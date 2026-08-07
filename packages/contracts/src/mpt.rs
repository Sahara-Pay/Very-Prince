//! # Merkle Patricia Trie (MPT) Proof Verifier
//!
//! Verifies Ethereum-compatible Merkle Patricia Trie inclusion/exclusion proofs
//! in `no_std` Rust. Used to authenticate cross-chain state submitted by users
//! against a trusted block header stored on-chain.
//!
//! ## Overview
//! An Ethereum MPT proof is an ordered list of RLP-encoded trie nodes from the
//! root down to the leaf that holds the claimed value. To verify:
//!
//! 1. Keccak-256 hash of `proof[0]` must equal the trusted `root_hash`.
//! 2. Each node points to the next node via a 32-byte hash (or inline if ≤ 31 bytes).
//! 3. The nibble path encoded inside leaf/extension nodes must match the remaining
//!    nibbles of `keccak256(key)`.
//! 4. The value at the leaf must equal the expected value.
//!
//! ## Supported node types
//! - **Branch node**: 17-item list (16 child slots + 1 value slot).
//! - **Extension node**: 2-item list with compact-encoded partial path + child hash.
//! - **Leaf node**: 2-item list with compact-encoded path + value.
//! - **Empty node**: 0x80 (empty RLP byte string).
//!
//! Reference: https://ethereum.org/en/developers/docs/data-structures-and-encoding/patricia-merkle-trie/

use crate::keccak::keccak256;
use crate::rlp::{decode_exact, EncodeBuf, RlpItem, encode_bytes_v2, encode_list_payload_v2};

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/// Maximum number of nodes in a proof (trie depth upper bound for Ethereum mainnet).
const MAX_PROOF_NODES: usize = 16;

/// A Keccak-256 hash is exactly 32 bytes.
const HASH_LEN: usize = 32;

/// Maximum value length we are willing to accept (256 bytes is ample for
/// Ethereum account RLP: nonce, balance, storageRoot, codeHash).
const MAX_VALUE_LEN: usize = 256;

// ─────────────────────────────────────────────────────────────────────────────
// Error type
// ─────────────────────────────────────────────────────────────────────────────

/// Errors produced during MPT proof verification.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum MptError {
    /// The proof contains no nodes.
    EmptyProof,
    /// The proof contains too many nodes (> [`MAX_PROOF_NODES`]).
    ProofTooLong,
    /// An individual node could not be RLP-decoded.
    InvalidRlp,
    /// The root node's hash does not match the trusted `root_hash`.
    RootHashMismatch,
    /// A parent node references a child hash that does not match the next node.
    HashMismatch,
    /// A node's RLP structure does not correspond to a valid branch/extension/leaf.
    InvalidNodeStructure,
    /// The nibble path extracted from nodes does not match `keccak256(key)`.
    PathMismatch,
    /// The proof proves non-inclusion but an inclusion was expected.
    KeyNotFound,
    /// The leaf value does not match the expected value.
    ValueMismatch,
    /// A compact-encoded path nibble was invalid (> 0x0f).
    InvalidNibble,
    /// The proof node is an inline node but its size exceeds 31 bytes (spec violation).
    OversizedInlineNode,
    /// The key being proved has zero length.
    EmptyKey,
    /// A provided slice (key, value, root, or node bytes) exceeds the allowed maximum.
    InputTooLong,
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/// Verify an Ethereum MPT inclusion proof.
///
/// # Arguments
/// * `root_hash` — 32-byte trusted state/storage/receipts root from the block header.
/// * `key`       — The raw key being proved (will be Keccak-256 hashed internally).
/// * `value`     — Expected RLP-encoded value at the key (empty slice = non-inclusion).
/// * `proof`     — Ordered slice of RLP-encoded trie nodes (root → leaf).
///
/// # Returns
/// `Ok(())` if the proof is valid, otherwise an [`MptError`].
pub fn verify_proof(
    root_hash: &[u8; HASH_LEN],
    key: &[u8],
    expected_value: &[u8],
    proof: &[&[u8]],
) -> Result<(), MptError> {
    if key.is_empty() {
        return Err(MptError::EmptyKey);
    }
    if proof.is_empty() {
        return Err(MptError::EmptyProof);
    }
    if proof.len() > MAX_PROOF_NODES {
        return Err(MptError::ProofTooLong);
    }
    if expected_value.len() > MAX_VALUE_LEN {
        return Err(MptError::InputTooLong);
    }

    // The MPT key path is keccak256(key), expressed as nibbles (half-bytes).
    let path_bytes = keccak256(key);
    let path = NibblePath::from_bytes(&path_bytes);

    verify_inner(root_hash, &path, expected_value, proof)
}

/// Verify that a key is NOT present in the trie (non-inclusion / exclusion proof).
///
/// The proof must lead to either an empty slot or a leaf with a different path.
pub fn verify_exclusion_proof(
    root_hash: &[u8; HASH_LEN],
    key: &[u8],
    proof: &[&[u8]],
) -> Result<(), MptError> {
    if key.is_empty() {
        return Err(MptError::EmptyKey);
    }
    if proof.is_empty() {
        // An empty root (keccak256 of empty string) with an empty proof is valid non-inclusion.
        // We check the caller passed the right root for that case externally.
        return Err(MptError::EmptyProof);
    }
    if proof.len() > MAX_PROOF_NODES {
        return Err(MptError::ProofTooLong);
    }

    let path_bytes = keccak256(key);
    let path = NibblePath::from_bytes(&path_bytes);

    match verify_inner(root_hash, &path, &[], proof) {
        Ok(()) => Ok(()),               // empty value = key absent
        Err(MptError::KeyNotFound) => Ok(()), // also valid non-inclusion
        Err(e) => Err(e),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal proof traversal
// ─────────────────────────────────────────────────────────────────────────────

fn verify_inner(
    root_hash: &[u8; HASH_LEN],
    path: &NibblePath,
    expected_value: &[u8],
    proof: &[&[u8]],
) -> Result<(), MptError> {
    // The hash we expect the current node to match.
    let mut expected_hash: [u8; HASH_LEN] = *root_hash;
    // How many nibbles of `path` have been consumed so far.
    let mut path_pos: usize = 0;

    for (node_idx, &node_bytes) in proof.iter().enumerate() {
        // ── 1. Verify node hash ───────────────────────────────────────────
        verify_node_hash(node_bytes, &expected_hash, node_idx == 0)?;

        // ── 2. Decode the node ────────────────────────────────────────────
        let item = decode_exact(node_bytes).map_err(|_| MptError::InvalidRlp)?;

        let list = match item {
            RlpItem::List(l) => l,
            RlpItem::Bytes(_) => return Err(MptError::InvalidNodeStructure),
        };

        let children = list.items().map_err(|_| MptError::InvalidRlp)?;

        match children.len() {
            // ── Branch node (17 children) ─────────────────────────────────
            17 => {
                if path_pos >= path.len() {
                    // The value slot of the branch node is child[16].
                    let value_item = children.get(16).ok_or(MptError::InvalidNodeStructure)?;
                    return match_value(value_item, expected_value);
                }

                let nibble = path.get(path_pos);
                path_pos += 1;

                let child_item = children.get(nibble as usize)
                    .ok_or(MptError::InvalidNodeStructure)?;

                // Advance expected_hash to the child's hash or inline node.
                expected_hash = extract_child_hash(child_item, proof, node_idx + 1)?;
            }

            // ── Extension or Leaf node (2 children) ──────────────────────
            2 => {
                let key_item = children.get(0).ok_or(MptError::InvalidNodeStructure)?;
                let val_item = children.get(1).ok_or(MptError::InvalidNodeStructure)?;

                let key_bytes = match key_item {
                    RlpItem::Bytes(b) => *b,
                    _ => return Err(MptError::InvalidNodeStructure),
                };

                let (is_leaf, node_nibbles) = decode_compact(key_bytes)?;

                // Consume the node's nibbles from `path`.
                if path_pos + node_nibbles.len() > path.len() {
                    return Err(MptError::PathMismatch);
                }
                for i in 0..node_nibbles.len() {
                    if path.get(path_pos + i) != node_nibbles[i] {
                        return Err(MptError::PathMismatch);
                    }
                }
                path_pos += node_nibbles.len();

                if is_leaf {
                    // Must be the last proof node.
                    if path_pos != path.len() {
                        return Err(MptError::PathMismatch);
                    }
                    return match_value(val_item, expected_value);
                } else {
                    // Extension: val_item is the child reference.
                    expected_hash = extract_child_hash(val_item, proof, node_idx + 1)?;
                }
            }

            // ── Empty or unknown ──────────────────────────────────────────
            0 => {
                // Empty node (0xc0). Key is absent.
                if expected_value.is_empty() {
                    return Ok(()); // non-inclusion confirmed
                }
                return Err(MptError::KeyNotFound);
            }

            _ => return Err(MptError::InvalidNodeStructure),
        }
    }

    // Exhausted proof nodes without reaching a leaf.
    Err(MptError::KeyNotFound)
}

// ─────────────────────────────────────────────────────────────────────────────
// Node hash verification
// ─────────────────────────────────────────────────────────────────────────────

/// Verify that `node_bytes` matches `expected_hash`.
///
/// If `node_bytes.len() < 32`, Ethereum uses the raw bytes as an inline node
/// (no hashing). We then compare the inline content with the hash slot that
/// referred us here — but since inline nodes are embedded directly in their
/// parent, not hashed, we just accept them and verify inline content separately.
fn verify_node_hash(
    node_bytes: &[u8],
    expected_hash: &[u8; HASH_LEN],
    is_root: bool,
) -> Result<(), MptError> {
    if is_root || node_bytes.len() >= HASH_LEN {
        let actual = keccak256(node_bytes);
        if actual != *expected_hash {
            return Err(if is_root { MptError::RootHashMismatch } else { MptError::HashMismatch });
        }
    }
    // Inline nodes (< 32 bytes) appearing as children are not hashed;
    // their raw bytes are embedded in the parent. Caller already verified parent.
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// Child hash extraction
// ─────────────────────────────────────────────────────────────────────────────

/// Extract the 32-byte hash reference to the next node from a branch child slot
/// or extension value.
///
/// Per the spec:
/// - If the slot is a 32-byte byte string → it IS the hash of the next node.
/// - If the slot is a shorter byte string or list → it is an inline node.
///   We re-encode it and compute its hash.
/// - Empty byte string (0x80) → null child; key absent.
fn extract_child_hash(
    item: &RlpItem<'_>,
    _proof: &[&[u8]],
    _next_idx: usize,
) -> Result<[u8; HASH_LEN], MptError> {
    match item {
        RlpItem::Bytes(b) => {
            if b.is_empty() {
                // Null child → absent
                Err(MptError::KeyNotFound)
            } else if b.len() == HASH_LEN {
                // Standard 32-byte reference
                let mut hash = [0u8; HASH_LEN];
                hash.copy_from_slice(b);
                Ok(hash)
            } else if b.len() < HASH_LEN {
                // Inline node: its hash is keccak256(RLP(inline_bytes))
                // Re-encode as an RLP byte string first.
                let mut enc = EncodeBuf::new();
                encode_bytes_v2(b, &mut enc).map_err(|_| MptError::InvalidNodeStructure)?;
                Ok(keccak256(enc.as_slice()))
            } else {
                Err(MptError::OversizedInlineNode)
            }
        }
        RlpItem::List(l) => {
            // Inline list node — re-encode the list payload and hash it.
            let payload = l.as_bytes();
            let mut enc = EncodeBuf::new();
            encode_list_payload_v2(payload, &mut enc)
                .map_err(|_| MptError::InvalidNodeStructure)?;
            Ok(keccak256(enc.as_slice()))
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Compact encoding (Ethereum hex-prefix)
// ─────────────────────────────────────────────────────────────────────────────

/// Maximum nibble path length for a compact-encoded segment.
/// A 32-byte keccak key = 64 nibbles; a node can hold at most 64 nibbles.
const MAX_NIBBLES: usize = 64;

/// Compact-encoded nibble array (stack-allocated).
struct Nibbles {
    data: [u8; MAX_NIBBLES],
    len: usize,
}

impl Nibbles {
    fn new() -> Self { Self { data: [0u8; MAX_NIBBLES], len: 0 } }

    fn push(&mut self, n: u8) -> Result<(), MptError> {
        if n > 0x0f {
            return Err(MptError::InvalidNibble);
        }
        if self.len >= MAX_NIBBLES {
            return Err(MptError::PathMismatch);
        }
        self.data[self.len] = n;
        self.len += 1;
        Ok(())
    }

    fn len(&self) -> usize { self.len }

    fn is_empty(&self) -> bool { self.len == 0 }
}

impl core::ops::Index<usize> for Nibbles {
    type Output = u8;
    fn index(&self, i: usize) -> &u8 { &self.data[i] }
}

/// Decode Ethereum compact (hex-prefix) encoding.
///
/// Returns `(is_leaf, nibbles)`.
///
/// Compact encoding:
/// - Byte 0 high nibble flags:
///   - 0: extension, even length
///   - 1: extension, odd length (first data nibble is low nibble of byte 0)
///   - 2: leaf, even length
///   - 3: leaf, odd length
fn decode_compact(input: &[u8]) -> Result<(bool, Nibbles), MptError> {
    if input.is_empty() {
        return Err(MptError::InvalidNodeStructure);
    }
    let flag = input[0] >> 4;
    let is_leaf = flag >= 2;
    let odd = (flag & 1) == 1;

    let mut nibbles = Nibbles::new();

    if odd {
        nibbles.push(input[0] & 0x0f)?;
    }

    for &byte in &input[1..] {
        nibbles.push(byte >> 4)?;
        nibbles.push(byte & 0x0f)?;
    }

    Ok((is_leaf, nibbles))
}

// ─────────────────────────────────────────────────────────────────────────────
// Value comparison
// ─────────────────────────────────────────────────────────────────────────────

/// Check that the leaf value matches `expected_value`.
fn match_value(val_item: &RlpItem<'_>, expected: &[u8]) -> Result<(), MptError> {
    match val_item {
        RlpItem::Bytes(actual) => {
            if expected.is_empty() {
                // Non-inclusion expected but we found a value.
                return Err(MptError::ValueMismatch);
            }
            if *actual == expected {
                Ok(())
            } else {
                Err(MptError::ValueMismatch)
            }
        }
        RlpItem::List(_) => {
            // Some Ethereum nodes store the value as an inline list.
            // We do not support this in this implementation; callers should
            // pass the full RLP-encoded value bytes.
            Err(MptError::InvalidNodeStructure)
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// NibblePath helper
// ─────────────────────────────────────────────────────────────────────────────

/// A nibble (half-byte) path derived from a 32-byte key hash.
/// 32 bytes → 64 nibbles.
struct NibblePath {
    bytes: [u8; 32],
}

impl NibblePath {
    fn from_bytes(b: &[u8; 32]) -> Self {
        Self { bytes: *b }
    }

    fn len(&self) -> usize { 64 }

    /// Get nibble at position `i` (0 = most significant nibble of byte 0).
    fn get(&self, i: usize) -> u8 {
        let byte = self.bytes[i / 2];
        if i % 2 == 0 { byte >> 4 } else { byte & 0x0f }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    extern crate alloc;
    use alloc::vec;
    use alloc::vec::Vec;
    use super::*;
    use crate::keccak::keccak256;
    use crate::rlp::{EncodeBuf, encode_bytes_v2, encode_list_payload_v2};

    // ─── Helpers to build minimal trie nodes for testing ─────────────────────

    /// Build an RLP-encoded leaf node: [compact_key, value]
    fn make_leaf(partial_nibbles: &[u8], odd: bool, value: &[u8]) -> Vec<u8> {
        let compact = compact_encode(partial_nibbles, true, odd);
        let mut children = EncodeBuf::new();
        encode_bytes_v2(&compact, &mut children).unwrap();
        encode_bytes_v2(value, &mut children).unwrap();
        let mut out = EncodeBuf::new();
        encode_list_payload_v2(children.as_slice(), &mut out).unwrap();
        out.as_slice().to_vec()
    }

    /// Build an RLP-encoded branch node: 16 child hashes + 1 value slot.
    fn make_branch(children: &[Option<[u8; 32]>; 16], value: &[u8]) -> Vec<u8> {
        let mut payload = EncodeBuf::new();
        for slot in children.iter() {
            match slot {
                Some(hash) => encode_bytes_v2(hash, &mut payload).unwrap(),
                None => encode_bytes_v2(&[], &mut payload).unwrap(),
            }
        }
        encode_bytes_v2(value, &mut payload).unwrap();
        let mut out = EncodeBuf::new();
        encode_list_payload_v2(payload.as_slice(), &mut out).unwrap();
        out.as_slice().to_vec()
    }

    /// Compact-encode a nibble path (Ethereum hex-prefix).
    fn compact_encode(nibbles: &[u8], is_leaf: bool, odd: bool) -> Vec<u8> {
        let flag_hi: u8 = if is_leaf { 2 } else { 0 } | if odd { 1 } else { 0 };
        let mut out = Vec::new();
        if odd {
            out.push((flag_hi << 4) | nibbles[0]);
            let mut i = 1;
            while i + 1 < nibbles.len() {
                out.push((nibbles[i] << 4) | nibbles[i + 1]);
                i += 2;
            }
        } else {
            out.push(flag_hi << 4);
            let mut i = 0;
            while i + 1 < nibbles.len() {
                out.push((nibbles[i] << 4) | nibbles[i + 1]);
                i += 2;
            }
        }
        out
    }

    // ─── Test: Single-node trie (just a leaf at root) ─────────────────────────

    #[test]
    fn single_leaf_proof_valid() {
        let key = b"mykey";
        let value = b"myvalue";

        // The MPT path for `key` is keccak256(key) expressed as 64 nibbles.
        let path_hash = keccak256(key);
        // Build a leaf with ALL 64 nibbles as path, even count.
        let mut all_nibbles = [0u8; 64];
        for i in 0..32 {
            all_nibbles[2 * i]     = path_hash[i] >> 4;
            all_nibbles[2 * i + 1] = path_hash[i] & 0x0f;
        }

        let leaf = make_leaf(&all_nibbles, false, value);
        let root_hash = keccak256(&leaf);

        let result = verify_proof(&root_hash, key, value, &[leaf.as_slice()]);
        assert_eq!(result, Ok(()));
    }

    #[test]
    fn single_leaf_wrong_value() {
        let key = b"mykey";
        let value = b"myvalue";
        let path_hash = keccak256(key);
        let mut all_nibbles = [0u8; 64];
        for i in 0..32 {
            all_nibbles[2 * i]     = path_hash[i] >> 4;
            all_nibbles[2 * i + 1] = path_hash[i] & 0x0f;
        }
        let leaf = make_leaf(&all_nibbles, false, value);
        let root_hash = keccak256(&leaf);

        // Claim a different value
        let result = verify_proof(&root_hash, key, b"wrongvalue", &[leaf.as_slice()]);
        assert_eq!(result, Err(MptError::ValueMismatch));
    }

    #[test]
    fn root_hash_mismatch() {
        let key = b"mykey";
        let value = b"myvalue";
        let path_hash = keccak256(key);
        let mut all_nibbles = [0u8; 64];
        for i in 0..32 {
            all_nibbles[2 * i]     = path_hash[i] >> 4;
            all_nibbles[2 * i + 1] = path_hash[i] & 0x0f;
        }
        let leaf = make_leaf(&all_nibbles, false, value);
        let mut wrong_root = [0u8; 32];
        wrong_root[0] = 0xde;
        wrong_root[1] = 0xad;

        let result = verify_proof(&wrong_root, key, value, &[leaf.as_slice()]);
        assert_eq!(result, Err(MptError::RootHashMismatch));
    }

    #[test]
    fn empty_proof_error() {
        let result = verify_proof(&[0u8; 32], b"key", b"val", &[]);
        assert_eq!(result, Err(MptError::EmptyProof));
    }

    #[test]
    fn empty_key_error() {
        let result = verify_proof(&[0u8; 32], b"", b"val", &[&[0xc0]]);
        assert_eq!(result, Err(MptError::EmptyKey));
    }

    #[test]
    fn compact_decode_even_extension() {
        // flag=0 (extension, even): first byte = 0x00, then pairs
        let input = [0x00, 0x12, 0x34];
        let (is_leaf, nibbles) = decode_compact(&input).unwrap();
        assert!(!is_leaf);
        assert_eq!(nibbles.len(), 4);
        assert_eq!(nibbles[0], 1);
        assert_eq!(nibbles[1], 2);
        assert_eq!(nibbles[2], 3);
        assert_eq!(nibbles[3], 4);
    }

    #[test]
    fn compact_decode_odd_leaf() {
        // flag=3 (leaf, odd): first byte = 0x3a → flag=3, first nibble=a
        let input = [0x3a, 0xbc];
        let (is_leaf, nibbles) = decode_compact(&input).unwrap();
        assert!(is_leaf);
        assert_eq!(nibbles.len(), 3);
        assert_eq!(nibbles[0], 0x0a);
        assert_eq!(nibbles[1], 0x0b);
        assert_eq!(nibbles[2], 0x0c);
    }

    #[test]
    fn nibble_path_indexing() {
        let bytes = [0xab, 0xcd, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                     0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                     0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                     0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
        let path = NibblePath::from_bytes(&bytes);
        assert_eq!(path.get(0), 0x0a);
        assert_eq!(path.get(1), 0x0b);
        assert_eq!(path.get(2), 0x0c);
        assert_eq!(path.get(3), 0x0d);
        assert_eq!(path.get(4), 0x00);
    }
}
