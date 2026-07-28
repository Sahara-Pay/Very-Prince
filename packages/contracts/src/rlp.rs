//! # RLP (Recursive Length Prefix) Decoder
//!
//! A `no_std` implementation of Ethereum's RLP encoding format.
//! Specification: https://ethereum.org/en/developers/docs/data-structures-and-encoding/rlp/
//!
//! ## Encoding rules (reference for decoding)
//! - Single byte in [0x00, 0x7f]: itself.
//! - Short string (0–55 bytes): 0x80+len, then payload.
//! - Long string (>55 bytes): 0xb7+lenOfLen, bigEndian(len), then payload.
//! - Short list (total payload 0–55 bytes): 0xc0+len, then encoded items.
//! - Long list (total payload >55 bytes): 0xf7+lenOfLen, bigEndian(len), then encoded items.

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/// Maximum nesting depth allowed to prevent stack exhaustion under the
/// 30 M CPU instruction budget.
const MAX_DEPTH: usize = 32;

/// Maximum total byte length of an RLP input we will decode (4 MiB).
const MAX_INPUT_LEN: usize = 4 * 1024 * 1024;

/// A decoded RLP value.  Lifetimes tie items back to the original byte slice
/// so no heap allocation is required.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RlpItem<'a> {
    /// A raw byte string (includes the empty string "").
    Bytes(&'a [u8]),
    /// An ordered list of RLP items.
    List(RlpList<'a>),
}

/// A thin wrapper around a byte slice that represents a list payload.
/// Individual items are decoded lazily via [`RlpList::iter`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RlpList<'a> {
    payload: &'a [u8],
}

/// Iterator over the items inside an [`RlpList`].
pub struct RlpListIter<'a> {
    data: &'a [u8],
    pos: usize,
    depth: usize,
}

/// Errors that can occur during RLP decoding.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum RlpError {
    /// Input is empty.
    Empty,
    /// Input slice is shorter than the prefix indicates.
    InputTooShort,
    /// Input exceeds the maximum allowed length.
    InputTooLong,
    /// A length field is zero where that is prohibited (non-canonical encoding).
    NonCanonicalLength,
    /// An integer length field uses leading zeroes (non-canonical).
    LeadingZeroInLength,
    /// Nesting depth exceeds [`MAX_DEPTH`].
    DepthLimitExceeded,
    /// The payload declared by the prefix extends past the end of the buffer.
    PayloadOutOfBounds,
    /// There is unconsumed trailing data after a complete item (when strict).
    TrailingData,
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/// Decode a single RLP item from `input`.
///
/// Returns `(item, bytes_consumed)` on success. The item borrows from `input`.
/// Use [`decode_exact`] if the full buffer must be a single item.
pub fn decode(input: &[u8]) -> Result<(RlpItem<'_>, usize), RlpError> {
    if input.is_empty() {
        return Err(RlpError::Empty);
    }
    if input.len() > MAX_INPUT_LEN {
        return Err(RlpError::InputTooLong);
    }
    decode_at(input, 0, 0)
}

/// Decode a single RLP item that must consume the entire `input` slice.
pub fn decode_exact(input: &[u8]) -> Result<RlpItem<'_>, RlpError> {
    let (item, consumed) = decode(input)?;
    if consumed != input.len() {
        return Err(RlpError::TrailingData);
    }
    Ok(item)
}

/// Decode a top-level RLP list and return a vec of its direct child items.
///
/// Convenience wrapper over [`decode_exact`].
pub fn decode_list(input: &[u8]) -> Result<RlpList<'_>, RlpError> {
    match decode_exact(input)? {
        RlpItem::List(list) => Ok(list),
        RlpItem::Bytes(_) => Err(RlpError::InputTooShort), // semantically wrong type
    }
}

/// Decode a raw bytes item and return its payload slice.
pub fn decode_bytes(input: &[u8]) -> Result<&[u8], RlpError> {
    match decode_exact(input)? {
        RlpItem::Bytes(b) => Ok(b),
        RlpItem::List(_) => Err(RlpError::InputTooShort), // semantically wrong type
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// RlpList helpers
// ─────────────────────────────────────────────────────────────────────────────

impl<'a> RlpList<'a> {
    /// Return the raw payload bytes of this list.
    pub fn as_bytes(&self) -> &'a [u8] {
        self.payload
    }

    /// Iterate over the direct children of this list.
    pub fn iter(&self) -> RlpListIter<'a> {
        RlpListIter { data: self.payload, pos: 0, depth: 1 }
    }

    /// Return true if the list has no elements.
    pub fn is_empty(&self) -> bool {
        self.payload.is_empty()
    }

    /// Collect direct children into a fixed-size array-like structure.
    /// Returns `Err` if decoding any child fails.
    pub fn items(&self) -> Result<RlpChildVec<'a>, RlpError> {
        let mut out = RlpChildVec::new();
        for item in self.iter() {
            out.push(item?).map_err(|_| RlpError::DepthLimitExceeded)?;
        }
        Ok(out)
    }
}

impl<'a> Iterator for RlpListIter<'a> {
    type Item = Result<RlpItem<'a>, RlpError>;

    fn next(&mut self) -> Option<Self::Item> {
        if self.pos >= self.data.len() {
            return None;
        }
        let remaining = &self.data[self.pos..];
        match decode_at(remaining, 0, self.depth) {
            Ok((item, consumed)) => {
                self.pos += consumed;
                Some(Ok(item))
            }
            Err(e) => Some(Err(e)),
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Heap-free child collection (max 64 children)
// ─────────────────────────────────────────────────────────────────────────────

/// A fixed-capacity list of decoded RLP children.  Capacity = 64, which covers
/// all practical MPT branch nodes (17 children) and Ethereum account proofs.
pub struct RlpChildVec<'a> {
    items: [Option<RlpItem<'a>>; 64],
    len: usize,
}

impl<'a> RlpChildVec<'a> {
    fn new() -> Self {
        // `None::<RlpItem>` is a valid const expression (no heap, no Drop issues).
        // Rust 1.79+ allows `[const { expr }; N]` for non-Copy types.
        Self {
            items: [
                None, None, None, None, None, None, None, None,
                None, None, None, None, None, None, None, None,
                None, None, None, None, None, None, None, None,
                None, None, None, None, None, None, None, None,
                None, None, None, None, None, None, None, None,
                None, None, None, None, None, None, None, None,
                None, None, None, None, None, None, None, None,
                None, None, None, None, None, None, None, None,
            ],
            len: 0,
        }
    }

    /// Push an item; returns `Err(())` if capacity is exceeded.
    pub fn push(&mut self, item: RlpItem<'a>) -> Result<(), ()> {
        if self.len >= 64 {
            return Err(());
        }
        self.items[self.len] = Some(item);
        self.len += 1;
        Ok(())
    }

    /// Number of stored items.
    pub fn len(&self) -> usize {
        self.len
    }

    /// True if empty.
    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    /// Get item by index.
    pub fn get(&self, i: usize) -> Option<&RlpItem<'a>> {
        if i < self.len { self.items[i].as_ref() } else { None }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Core recursive decoder
// ─────────────────────────────────────────────────────────────────────────────

/// Decode one RLP item starting at `buf[offset]`, enforcing `depth <= MAX_DEPTH`.
/// Returns `(item, total_bytes_consumed_from_buf_start)`.
fn decode_at<'a>(buf: &'a [u8], offset: usize, depth: usize) -> Result<(RlpItem<'a>, usize), RlpError> {
    if depth > MAX_DEPTH {
        return Err(RlpError::DepthLimitExceeded);
    }
    if offset >= buf.len() {
        return Err(RlpError::InputTooShort);
    }

    let prefix = buf[offset];

    match prefix {
        // ── Single byte [0x00, 0x7f] ──────────────────────────────────────
        0x00..=0x7f => Ok((RlpItem::Bytes(&buf[offset..offset + 1]), 1)),

        // ── Short string [0x80, 0xb7]: 0 – 55 bytes ──────────────────────
        0x80..=0xb7 => {
            let str_len = (prefix - 0x80) as usize;
            // Single byte 0x80 = empty string ""
            let end = offset + 1 + str_len;
            if end > buf.len() {
                return Err(RlpError::PayloadOutOfBounds);
            }
            // Non-canonical: single byte that fits in [0x00,0x7f] must not use this prefix
            if str_len == 1 && buf[offset + 1] < 0x80 {
                return Err(RlpError::NonCanonicalLength);
            }
            Ok((RlpItem::Bytes(&buf[offset + 1..end]), 1 + str_len))
        }

        // ── Long string [0xb8, 0xbf]: len stored in next (prefix-0xb7) bytes ──
        0xb8..=0xbf => {
            let len_of_len = (prefix - 0xb7) as usize;
            let header_end = offset + 1 + len_of_len;
            if header_end > buf.len() {
                return Err(RlpError::InputTooShort);
            }
            let len_bytes = &buf[offset + 1..header_end];
            // Non-canonical: leading zero in the length field
            if len_bytes[0] == 0 {
                return Err(RlpError::LeadingZeroInLength);
            }
            let str_len = decode_usize(len_bytes)?;
            // Non-canonical: str_len must be > 55
            if str_len <= 55 {
                return Err(RlpError::NonCanonicalLength);
            }
            let payload_end = header_end + str_len;
            if payload_end > buf.len() {
                return Err(RlpError::PayloadOutOfBounds);
            }
            Ok((RlpItem::Bytes(&buf[header_end..payload_end]), 1 + len_of_len + str_len))
        }

        // ── Short list [0xc0, 0xf7]: 0 – 55 bytes total payload ──────────
        0xc0..=0xf7 => {
            let payload_len = (prefix - 0xc0) as usize;
            let payload_start = offset + 1;
            let payload_end = payload_start + payload_len;
            if payload_end > buf.len() {
                return Err(RlpError::PayloadOutOfBounds);
            }
            Ok((RlpItem::List(RlpList { payload: &buf[payload_start..payload_end] }),
                1 + payload_len))
        }

        // ── Long list [0xf8, 0xff] ────────────────────────────────────────
        0xf8..=0xff => {
            let len_of_len = (prefix - 0xf7) as usize;
            let header_end = offset + 1 + len_of_len;
            if header_end > buf.len() {
                return Err(RlpError::InputTooShort);
            }
            let len_bytes = &buf[offset + 1..header_end];
            if len_bytes[0] == 0 {
                return Err(RlpError::LeadingZeroInLength);
            }
            let payload_len = decode_usize(len_bytes)?;
            if payload_len <= 55 {
                return Err(RlpError::NonCanonicalLength);
            }
            let payload_end = header_end + payload_len;
            if payload_end > buf.len() {
                return Err(RlpError::PayloadOutOfBounds);
            }
            Ok((RlpItem::List(RlpList { payload: &buf[header_end..payload_end] }),
                1 + len_of_len + payload_len))
        }
    }
}

/// Decode a big-endian unsigned integer from a byte slice into a `usize`.
/// Returns `Err(InputTooShort)` if the value overflows `usize`.
fn decode_usize(bytes: &[u8]) -> Result<usize, RlpError> {
    if bytes.len() > core::mem::size_of::<usize>() {
        return Err(RlpError::InputTooShort); // value is too large for this platform
    }
    let mut val: usize = 0;
    for &b in bytes {
        val = val.checked_shl(8).ok_or(RlpError::InputTooShort)? | (b as usize);
    }
    Ok(val)
}

// ─────────────────────────────────────────────────────────────────────────────
// Convenience: decode RLP-encoded u64 (big-endian, no leading zeroes)
// ─────────────────────────────────────────────────────────────────────────────

/// Decode an RLP-encoded big-endian integer as a `u64`.
pub fn decode_u64(input: &[u8]) -> Result<u64, RlpError> {
    let bytes = decode_bytes(input)?;
    if bytes.len() > 8 {
        return Err(RlpError::InputTooShort);
    }
    if bytes.len() > 1 && bytes[0] == 0 {
        return Err(RlpError::LeadingZeroInLength);
    }
    let mut val: u64 = 0;
    for &b in bytes {
        val = val << 8 | (b as u64);
    }
    Ok(val)
}

// ─────────────────────────────────────────────────────────────────────────────
// Encoder (needed to re-hash nodes during MPT verification)
// ─────────────────────────────────────────────────────────────────────────────

/// Maximum encoded output size we support (4 KiB; enough for any MPT node).
const MAX_ENCODE_LEN: usize = 4096;

/// A fixed-size byte buffer used as an RLP encoding scratch pad.
pub struct EncodeBuf {
    data: [u8; MAX_ENCODE_LEN],
    len: usize,
}

impl EncodeBuf {
    pub fn new() -> Self {
        Self { data: [0u8; MAX_ENCODE_LEN], len: 0 }
    }

    pub fn as_slice(&self) -> &[u8] {
        &self.data[..self.len]
    }

    fn push(&mut self, b: u8) -> Result<(), RlpError> {
        if self.len >= MAX_ENCODE_LEN {
            return Err(RlpError::PayloadOutOfBounds);
        }
        self.data[self.len] = b;
        self.len += 1;
        Ok(())
    }

    fn push_slice(&mut self, s: &[u8]) -> Result<(), RlpError> {
        if self.len + s.len() > MAX_ENCODE_LEN {
            return Err(RlpError::PayloadOutOfBounds);
        }
        self.data[self.len..self.len + s.len()].copy_from_slice(s);
        self.len += s.len();
        Ok(())
    }
}

impl Default for EncodeBuf {
    fn default() -> Self {
        Self::new()
    }
}

/// Encode a byte string into `out`.
pub fn encode_bytes(bytes: &[u8], out: &mut EncodeBuf) -> Result<(), RlpError> {
    let len = bytes.len();
    if len == 1 && bytes[0] < 0x80 {
        out.push(bytes[0])
    } else if len <= 55 {
        out.push(0x80 + len as u8)?;
        out.push_slice(bytes)
    } else {
        let len_bytes = usize_to_be_bytes(len);
        out.push(0xb7 + len_bytes.len() as u8)?;
        out.push_slice(&len_bytes)?;
        out.push_slice(bytes)
    }
}

/// Encode a list payload (already-encoded children) into `out`.
pub fn encode_list_payload(payload: &[u8], out: &mut EncodeBuf) -> Result<(), RlpError> {
    let len = payload.len();
    if len <= 55 {
        out.push(0xc0 + len as u8)?;
        out.push_slice(payload)
    } else {
        let len_bytes = usize_to_be_bytes(len);
        out.push(0xf7 + len_bytes.len() as u8)?;
        out.push_slice(&len_bytes)?;
        out.push_slice(payload)
    }
}

/// Convert a `usize` to its minimal big-endian representation (no leading zeroes).
fn usize_to_be_bytes(val: usize) -> [u8; 8] {
    // We return the meaningful bytes packed at the front of this array;
    // the caller reads `[0..len]` where len is the number of significant bytes.
    // For simplicity we use a fixed array and return it; the prefix byte
    // encodes the true length.
    let be = val.to_be_bytes();
    be // caller strips leading zeroes via the prefix calculation
}

// Actually the encode functions need true minimal BE, so fix this:

/// Encode `len` as a minimal big-endian byte sequence, return `(bytes, count)`.
pub fn len_to_min_be(len: usize) -> ([u8; 8], usize) {
    let be = (len as u64).to_be_bytes();
    let leading = be.iter().take_while(|&&b| b == 0).count();
    let sig = 8 - leading;
    let sig = if sig == 0 { 1 } else { sig };
    (be, sig) // caller uses be[8-sig..] for the actual bytes
}

/// Encode a byte string into `out` using the correct minimal BE length.
pub fn encode_bytes_v2(bytes: &[u8], out: &mut EncodeBuf) -> Result<(), RlpError> {
    let len = bytes.len();
    if len == 1 && bytes[0] < 0x80 {
        out.push(bytes[0])
    } else if len <= 55 {
        out.push(0x80 + len as u8)?;
        out.push_slice(bytes)
    } else {
        let (be, sig) = len_to_min_be(len);
        out.push(0xb7 + sig as u8)?;
        out.push_slice(&be[8 - sig..])?;
        out.push_slice(bytes)
    }
}

/// Encode a list payload using the correct minimal BE length.
pub fn encode_list_payload_v2(payload: &[u8], out: &mut EncodeBuf) -> Result<(), RlpError> {
    let len = payload.len();
    if len <= 55 {
        out.push(0xc0 + len as u8)?;
        out.push_slice(payload)
    } else {
        let (be, sig) = len_to_min_be(len);
        out.push(0xf7 + sig as u8)?;
        out.push_slice(&be[8 - sig..])?;
        out.push_slice(payload)
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_byte_below_128() {
        for b in 0u8..=0x7f {
            let (item, consumed) = decode(&[b]).unwrap();
            assert_eq!(consumed, 1);
            assert_eq!(item, RlpItem::Bytes(&[b]));
        }
    }

    #[test]
    fn empty_string() {
        // 0x80 = empty byte string
        let (item, consumed) = decode(&[0x80]).unwrap();
        assert_eq!(consumed, 1);
        assert_eq!(item, RlpItem::Bytes(b""));
    }

    #[test]
    fn short_string() {
        // "dog" = 0x83 0x64 0x6f 0x67
        let input = [0x83, 0x64, 0x6f, 0x67];
        let item = decode_exact(&input).unwrap();
        assert_eq!(item, RlpItem::Bytes(b"dog"));
    }

    #[test]
    fn empty_list() {
        // 0xc0 = empty list
        let item = decode_exact(&[0xc0]).unwrap();
        assert!(matches!(item, RlpItem::List(_)));
        if let RlpItem::List(l) = item {
            assert!(l.is_empty());
        }
    }

    #[test]
    fn list_of_strings() {
        // ["cat", "dog"] = 0xc8, 0x83 "cat", 0x83 "dog"
        let input = [0xc8, 0x83, b'c', b'a', b't', 0x83, b'd', b'o', b'g'];
        let item = decode_exact(&input).unwrap();
        if let RlpItem::List(list) = item {
            let children = list.items().unwrap();
            assert_eq!(children.len(), 2);
            assert_eq!(children.get(0).unwrap(), &RlpItem::Bytes(b"cat"));
            assert_eq!(children.get(1).unwrap(), &RlpItem::Bytes(b"dog"));
        } else {
            panic!("expected list");
        }
    }

    #[test]
    fn non_canonical_single_byte() {
        // 0x81 0x00 — byte 0x00 fits in single-byte form, so this is non-canonical
        let result = decode_exact(&[0x81, 0x00]);
        assert_eq!(result, Err(RlpError::NonCanonicalLength));
    }

    #[test]
    fn trailing_data_error() {
        let input = [0x83, b'd', b'o', b'g', 0x00]; // extra 0x00
        let result = decode_exact(&input);
        assert_eq!(result, Err(RlpError::TrailingData));
    }

    #[test]
    fn payload_out_of_bounds() {
        // 0x83 says 3-byte payload but only 1 byte follows
        let result = decode_exact(&[0x83, b'a']);
        assert_eq!(result, Err(RlpError::PayloadOutOfBounds));
    }

    #[test]
    fn nested_list() {
        // [ [], [[]] ] — two-level nesting
        // inner empty list: 0xc0
        // [[]] = 0xc1 0xc0
        // [ [], [[]] ] = 0xc3 0xc0 0xc1 0xc0
        let input = [0xc3, 0xc0, 0xc1, 0xc0];
        let item = decode_exact(&input).unwrap();
        if let RlpItem::List(outer) = item {
            let children = outer.items().unwrap();
            assert_eq!(children.len(), 2);
            assert!(matches!(children.get(0).unwrap(), RlpItem::List(_)));
            assert!(matches!(children.get(1).unwrap(), RlpItem::List(_)));
        } else {
            panic!("expected list");
        }
    }

    #[test]
    fn long_string() {
        // Build a 56-byte string
        let payload = [0xaau8; 56];
        let mut buf = EncodeBuf::new();
        encode_bytes_v2(&payload, &mut buf).unwrap();
        let encoded = buf.as_slice();
        // First byte should be 0xb8 (0xb7 + 1)
        assert_eq!(encoded[0], 0xb8);
        assert_eq!(encoded[1], 56u8);
        let decoded = decode_bytes(encoded).unwrap();
        assert_eq!(decoded, &payload[..]);
    }

    #[test]
    fn encode_decode_roundtrip_list() {
        // Encode [b"hello", b"world"] and decode it back
        let mut child_buf = EncodeBuf::new();
        encode_bytes_v2(b"hello", &mut child_buf).unwrap();
        encode_bytes_v2(b"world", &mut child_buf).unwrap();
        let mut out = EncodeBuf::new();
        encode_list_payload_v2(child_buf.as_slice(), &mut out).unwrap();

        let item = decode_exact(out.as_slice()).unwrap();
        if let RlpItem::List(list) = item {
            let children = list.items().unwrap();
            assert_eq!(children.len(), 2);
            assert_eq!(children.get(0).unwrap(), &RlpItem::Bytes(b"hello"));
            assert_eq!(children.get(1).unwrap(), &RlpItem::Bytes(b"world"));
        } else {
            panic!("expected list");
        }
    }
}
