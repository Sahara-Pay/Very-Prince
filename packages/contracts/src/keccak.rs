//! # Keccak-256 Hash Function
//!
//! A `no_std`, dependency-free, WASM-friendly implementation of Keccak-256
//! (the hash used by Ethereum — distinct from NIST SHA3-256 in padding).
//!
//! ## Design goals
//! - Zero heap allocation: all state lives on the stack.
//! - Optimised for Soroban's 30 M CPU instruction budget:
//!   - Loop-unrollable 24-round permutation.
//!   - 64-bit lane arithmetic maps directly to WASM i64 ops.
//!   - Single-pass, streaming absorb interface avoids copying large inputs.
//!
//! Reference: https://keccak.team/keccak_specs_summary.html

// ─────────────────────────────────────────────────────────────────────────────
// Round constants
// ─────────────────────────────────────────────────────────────────────────────

/// Keccak-f[1600] round constants (iota step).
const RC: [u64; 24] = [
    0x0000000000000001, 0x0000000000008082,
    0x800000000000808a, 0x8000000080008000,
    0x000000000000808b, 0x0000000080000001,
    0x8000000080008081, 0x8000000000008009,
    0x000000000000008a, 0x0000000000000088,
    0x0000000080008009, 0x000000008000000a,
    0x000000008000808b, 0x800000000000008b,
    0x8000000000008089, 0x8000000000008003,
    0x8000000000008002, 0x8000000000000080,
    0x000000000000800a, 0x800000008000000a,
    0x8000000080008081, 0x8000000000008080,
    0x0000000080000001, 0x8000000080008008,
];

/// Rotation offsets for the rho step (indexed by lane x,y → see spec table).
const RHO: [u32; 25] = [
     0,  1, 62, 28, 27,
    36, 44,  6, 55, 20,
     3, 10, 43, 25, 39,
    41, 45, 15, 21,  8,
    18,  2, 61, 56, 14,
];

/// Pi step permutation: new index for each of the 25 lanes.
const PI: [usize; 25] = [
     0, 10, 20,  5, 15,
    16,  1, 11, 21,  6,
     7, 17,  2, 12, 22,
    23,  8, 18,  3, 13,
    14, 24,  9, 19,  4,
];

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

/// Keccak-256 hasher state.
///
/// Keccak-256 parameters:
/// - rate r = 1088 bits = 136 bytes = 17 × 64-bit lanes
/// - capacity c = 512 bits
/// - output length = 256 bits
pub struct Keccak256 {
    /// 5×5 = 25 64-bit lanes (little-endian).
    state: [u64; 25],
    /// Bytes absorbed so far in the current block (position in rate buffer).
    pos: usize,
}

/// Keccak-256 rate in bytes.
const RATE: usize = 136; // (1600 - 512) / 8

impl Keccak256 {
    /// Create a new hasher with zeroed state.
    pub const fn new() -> Self {
        Self { state: [0u64; 25], pos: 0 }
    }

    /// Absorb `data` into the sponge.
    ///
    /// Can be called multiple times to hash data in chunks — useful for
    /// incremental hashing without needing a contiguous buffer.
    pub fn update(&mut self, mut data: &[u8]) {
        while !data.is_empty() {
            let available = RATE - self.pos;
            let chunk_len = data.len().min(available);

            // XOR bytes into the state lanes (little-endian lane layout)
            xor_into_state(&mut self.state, self.pos, &data[..chunk_len]);
            self.pos += chunk_len;
            data = &data[chunk_len..];

            if self.pos == RATE {
                keccak_f1600(&mut self.state);
                self.pos = 0;
            }
        }
    }

    /// Finalise and return the 32-byte Keccak-256 digest.
    ///
    /// Applies Keccak (not SHA3) padding: 0x01 at `pos`, 0x80 at `RATE - 1`.
    pub fn finalize(mut self) -> [u8; 32] {
        // Padding: 0x01 directly after last absorbed byte
        xor_byte_into_state(&mut self.state, self.pos, 0x01);
        // 0x80 at the last byte of the rate block
        xor_byte_into_state(&mut self.state, RATE - 1, 0x80);
        keccak_f1600(&mut self.state);
        squeeze(&self.state)
    }
}

impl Default for Keccak256 {
    fn default() -> Self {
        Self::new()
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public convenience function
// ─────────────────────────────────────────────────────────────────────────────

/// Compute the Keccak-256 digest of `data` in a single call.
///
/// Prefer the streaming [`Keccak256`] hasher when the data is chunked.
#[inline]
pub fn keccak256(data: &[u8]) -> [u8; 32] {
    let mut h = Keccak256::new();
    h.update(data);
    h.finalize()
}

/// Compute the Keccak-256 digest of two concatenated byte slices without
/// allocating an intermediate buffer. Used in MPT node rehashing.
#[inline]
pub fn keccak256_concat(a: &[u8], b: &[u8]) -> [u8; 32] {
    let mut h = Keccak256::new();
    h.update(a);
    h.update(b);
    h.finalize()
}

// ─────────────────────────────────────────────────────────────────────────────
// Keccak-f[1600] permutation
// ─────────────────────────────────────────────────────────────────────────────

/// Apply the Keccak-f[1600] permutation to `a` in place.
///
/// 24 rounds of θ, ρ, π, χ, ι.
fn keccak_f1600(a: &mut [u64; 25]) {
    for round in 0..24 {
        // ── θ (theta) ─────────────────────────────────────────────────────
        let mut c = [0u64; 5];
        for x in 0..5 {
            c[x] = a[x] ^ a[x + 5] ^ a[x + 10] ^ a[x + 15] ^ a[x + 20];
        }
        let mut d = [0u64; 5];
        for x in 0..5 {
            d[x] = c[(x + 4) % 5] ^ c[(x + 1) % 5].rotate_left(1);
        }
        for i in 0..25 {
            a[i] ^= d[i % 5];
        }

        // ── ρ (rho) + π (pi) — combined in one pass ───────────────────────
        let mut b = [0u64; 25];
        for i in 0..25 {
            b[PI[i]] = a[i].rotate_left(RHO[i]);
        }

        // ── χ (chi) ───────────────────────────────────────────────────────
        for y in 0..5 {
            let base = y * 5;
            let t0 = b[base];
            let t1 = b[base + 1];
            let t2 = b[base + 2];
            let t3 = b[base + 3];
            let t4 = b[base + 4];
            a[base]     = t0 ^ ((!t1) & t2);
            a[base + 1] = t1 ^ ((!t2) & t3);
            a[base + 2] = t2 ^ ((!t3) & t4);
            a[base + 3] = t3 ^ ((!t4) & t0);
            a[base + 4] = t4 ^ ((!t0) & t1);
        }

        // ── ι (iota) ──────────────────────────────────────────────────────
        a[0] ^= RC[round];
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: state ↔ bytes conversion
// ─────────────────────────────────────────────────────────────────────────────

/// XOR `bytes` into the sponge state starting at byte offset `state_pos`.
/// Bytes are mapped to lanes in little-endian order.
#[inline(always)]
fn xor_into_state(state: &mut [u64; 25], state_pos: usize, bytes: &[u8]) {
    for (i, &byte) in bytes.iter().enumerate() {
        let pos = state_pos + i;
        let lane = pos / 8;
        let byte_in_lane = pos % 8;
        state[lane] ^= (byte as u64) << (8 * byte_in_lane);
    }
}

/// XOR a single byte into the sponge state at byte offset `pos`.
#[inline(always)]
fn xor_byte_into_state(state: &mut [u64; 25], pos: usize, byte: u8) {
    let lane = pos / 8;
    let byte_in_lane = pos % 8;
    state[lane] ^= (byte as u64) << (8 * byte_in_lane);
}

/// Extract the first 32 bytes from the sponge state (little-endian lanes).
#[inline(always)]
fn squeeze(state: &[u64; 25]) -> [u8; 32] {
    let mut out = [0u8; 32];
    for i in 0..4 {
        let lane = state[i].to_le_bytes();
        out[i * 8..(i + 1) * 8].copy_from_slice(&lane);
    }
    out
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// Known Keccak-256 test vectors.
    struct TestVector {
        input: &'static [u8],
        expected: [u8; 32],
    }

    fn hex(s: &str) -> [u8; 32] {
        let mut out = [0u8; 32];
        for i in 0..32 {
            out[i] = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).unwrap();
        }
        out
    }

    #[test]
    fn empty_input() {
        // Keccak256("") = c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470
        let expected = hex("c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
        assert_eq!(keccak256(b""), expected);
    }

    #[test]
    fn abc() {
        // Keccak256("abc") = 4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45
        let expected = hex("4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45");
        assert_eq!(keccak256(b"abc"), expected);
    }

    #[test]
    fn ethereum_address_hash() {
        // Keccak256("hello") = 1c8aff950685c2ed4bc3174f3472287b56d9517b9c948127319a09a7a36deac8
        let expected = hex("1c8aff950685c2ed4bc3174f3472287b56d9517b9c948127319a09a7a36deac8");
        assert_eq!(keccak256(b"hello"), expected);
    }

    #[test]
    fn streaming_matches_oneshot() {
        let data = b"The quick brown fox jumps over the lazy dog";
        let oneshot = keccak256(data);

        let mut h = Keccak256::new();
        h.update(&data[..10]);
        h.update(&data[10..20]);
        h.update(&data[20..]);
        let streaming = h.finalize();

        assert_eq!(oneshot, streaming);
    }

    #[test]
    fn multi_block_input() {
        // 200 bytes — crosses the 136-byte rate boundary
        let data = [0x42u8; 200];
        let h1 = keccak256(&data);

        let mut h = Keccak256::new();
        h.update(&data[..100]);
        h.update(&data[100..]);
        assert_eq!(h1, h.finalize());
    }

    #[test]
    fn concat_matches_combined() {
        let a = b"cross-chain";
        let b = b"-reputation";
        let combined: [u8; 22] = {
            let mut c = [0u8; 22];
            c[..11].copy_from_slice(a);
            c[11..].copy_from_slice(b);
            c
        };
        assert_eq!(keccak256_concat(a, b), keccak256(&combined));
    }
}
