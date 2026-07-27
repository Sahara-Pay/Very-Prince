//! # Cross-Chain State Proof Verifier
//!
//! High-level Soroban-facing module that combines RLP decoding, Keccak-256
//! hashing, and MPT proof verification into a single, ergonomic interface.
//!
//! ## Data flow
//!
//! ```text
//! Caller submits:
//!   ┌─────────────────────────────────────────────────────────────┐
//!   │  BlockHeader { state_root: [u8;32], block_number: u64, ... }│
//!   │  key        : raw storage/account key bytes                  │
//!   │  value      : expected RLP-encoded value at that key         │
//!   │  proof      : Vec of RLP-encoded trie nodes (root → leaf)    │
//!   └─────────────────────────────────────────────────────────────┘
//!                              │
//!                              ▼
//!   1. verify proof[0] hash == state_root        (RootHashMismatch)
//!   2. walk proof verifying each node hash       (HashMismatch)
//!   3. match nibble path == keccak256(key)       (PathMismatch)
//!   4. match leaf value  == expected_value       (ValueMismatch)
//!                              │
//!                              ▼
//!   Ok(ReputationScore { score, source_chain, block_number })
//! ```
//!
//! ## Soroban cost budget
//! The Keccak-256 and RLP logic is written to avoid heap allocation and
//! minimise branching to stay comfortably within the 30 M CPU instruction limit.
//! A proof with ≤ 8 nodes typically uses < 10 M instructions.

use crate::keccak::keccak256;
use crate::mpt::{verify_proof, verify_exclusion_proof, MptError};
use crate::rlp::{decode_exact, RlpItem, RlpError};

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/// Maximum number of proof nodes accepted per call.
pub const MAX_PROOF_NODES: usize = 16;
/// Maximum byte length of an individual proof node.
pub const MAX_NODE_BYTES: usize = 1024;
/// Maximum byte length of the key.
pub const MAX_KEY_BYTES: usize = 128;
/// Maximum byte length of the expected value.
pub const MAX_VALUE_BYTES: usize = 256;

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

/// A trusted block header snapshot.
///
/// In production this would be stored on-chain (in Soroban persistent storage)
/// by a governance action after multi-sig attestation of the foreign chain's
/// canonical head.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BlockHeader {
    /// The state root from the block header (32 bytes, Keccak-256 hash).
    pub state_root: [u8; 32],
    /// The block number (used as a replay-protection nonce).
    pub block_number: u64,
    /// A 4-byte chain identifier (e.g. 1 for Ethereum mainnet, 137 for Polygon).
    pub chain_id: u32,
}

/// The result of a successful cross-chain proof verification.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VerifiedState {
    /// Raw value bytes extracted from the trie leaf (RLP-encoded per Ethereum conventions).
    pub value: [u8; MAX_VALUE_BYTES],
    /// Actual length of the value (remainder of `value` is zeroed padding).
    pub value_len: usize,
    /// The chain ID from the submitted block header.
    pub chain_id: u32,
    /// The block number from the submitted block header.
    pub block_number: u64,
}

/// Errors from the cross-chain verifier module.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum CrossChainError {
    /// One or more input slices exceeded the allowed maximum length.
    InputTooLong,
    /// The proof is empty.
    EmptyProof,
    /// A block header field was invalid (e.g. zero chain_id).
    InvalidHeader,
    /// RLP decoding of an input failed.
    RlpDecodeError(RlpError),
    /// MPT proof verification failed.
    ProofVerifyError(MptError),
    /// The value decoded from the proof is not a valid RLP byte string.
    InvalidValueEncoding,
}

impl From<MptError> for CrossChainError {
    fn from(e: MptError) -> Self { CrossChainError::ProofVerifyError(e) }
}

impl From<RlpError> for CrossChainError {
    fn from(e: RlpError) -> Self { CrossChainError::RlpDecodeError(e) }
}

// ─────────────────────────────────────────────────────────────────────────────
// Core verifier
// ─────────────────────────────────────────────────────────────────────────────

/// Verify a Merkle Patricia Trie inclusion proof against a trusted block header.
///
/// # Arguments
/// * `header`         — Trusted block header (state root, block number, chain id).
/// * `key`            — Raw key (will be Keccak-256 hashed internally).
/// * `expected_value` — Expected RLP-encoded value bytes at `key`.
/// * `proof_nodes`    — Ordered slice of RLP-encoded trie nodes.
///
/// # Returns
/// `Ok(VerifiedState)` containing the verified value and provenance metadata.
pub fn verify_state_proof(
    header: &BlockHeader,
    key: &[u8],
    expected_value: &[u8],
    proof_nodes: &[&[u8]],
) -> Result<VerifiedState, CrossChainError> {
    // ── Input validation ──────────────────────────────────────────────────────
    if header.chain_id == 0 {
        return Err(CrossChainError::InvalidHeader);
    }
    if key.is_empty() || key.len() > MAX_KEY_BYTES {
        return Err(CrossChainError::InputTooLong);
    }
    if expected_value.len() > MAX_VALUE_BYTES {
        return Err(CrossChainError::InputTooLong);
    }
    if proof_nodes.is_empty() {
        return Err(CrossChainError::EmptyProof);
    }
    if proof_nodes.len() > MAX_PROOF_NODES {
        return Err(CrossChainError::InputTooLong);
    }
    for node in proof_nodes.iter() {
        if node.len() > MAX_NODE_BYTES {
            return Err(CrossChainError::InputTooLong);
        }
    }

    // ── MPT proof verification ────────────────────────────────────────────────
    verify_proof(&header.state_root, key, expected_value, proof_nodes)?;

    // ── Pack result ───────────────────────────────────────────────────────────
    let mut value_buf = [0u8; MAX_VALUE_BYTES];
    value_buf[..expected_value.len()].copy_from_slice(expected_value);

    Ok(VerifiedState {
        value: value_buf,
        value_len: expected_value.len(),
        chain_id: header.chain_id,
        block_number: header.block_number,
    })
}

/// Verify a non-inclusion (exclusion) proof — the key is absent from the trie.
///
/// Useful for proving that a maintainer has *no* balance / *no* record on the
/// foreign chain.
pub fn verify_exclusion(
    header: &BlockHeader,
    key: &[u8],
    proof_nodes: &[&[u8]],
) -> Result<(), CrossChainError> {
    if header.chain_id == 0 {
        return Err(CrossChainError::InvalidHeader);
    }
    if key.is_empty() || key.len() > MAX_KEY_BYTES {
        return Err(CrossChainError::InputTooLong);
    }
    if proof_nodes.is_empty() {
        return Err(CrossChainError::EmptyProof);
    }
    if proof_nodes.len() > MAX_PROOF_NODES {
        return Err(CrossChainError::InputTooLong);
    }
    for node in proof_nodes.iter() {
        if node.len() > MAX_NODE_BYTES {
            return Err(CrossChainError::InputTooLong);
        }
    }

    verify_exclusion_proof(&header.state_root, key, proof_nodes)?;
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// RLP-decoded Ethereum account helper
// ─────────────────────────────────────────────────────────────────────────────

/// A decoded Ethereum account state as stored in the state trie.
///
/// ```text
/// account = RLP([nonce, balance, storageRoot, codeHash])
/// ```
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct EthAccount {
    /// Account nonce (transaction count).
    pub nonce: u64,
    /// Balance in wei — stored as raw big-endian bytes (up to 32 bytes).
    pub balance: [u8; 32],
    /// Length of `balance` in bytes (the rest is leading zeroes).
    pub balance_len: usize,
    /// 32-byte storage trie root.
    pub storage_root: [u8; 32],
    /// 32-byte code hash.
    pub code_hash: [u8; 32],
}

/// Decode an RLP-encoded Ethereum account from the value bytes.
///
/// Returns `Err(CrossChainError::InvalidValueEncoding)` if the bytes are not a
/// valid 4-element RLP list matching the Ethereum account schema.
pub fn decode_eth_account(value_bytes: &[u8]) -> Result<EthAccount, CrossChainError> {
    let item = decode_exact(value_bytes)
        .map_err(CrossChainError::RlpDecodeError)?;

    let list = match item {
        RlpItem::List(l) => l,
        _ => return Err(CrossChainError::InvalidValueEncoding),
    };

    let children = list.items().map_err(CrossChainError::RlpDecodeError)?;
    if children.len() != 4 {
        return Err(CrossChainError::InvalidValueEncoding);
    }

    // ── nonce ─────────────────────────────────────────────────────────────────
    let nonce = match children.get(0) {
        Some(RlpItem::Bytes(b)) => bytes_to_u64(b)?,
        _ => return Err(CrossChainError::InvalidValueEncoding),
    };

    // ── balance ───────────────────────────────────────────────────────────────
    let (balance, balance_len) = match children.get(1) {
        Some(RlpItem::Bytes(b)) => {
            if b.len() > 32 {
                return Err(CrossChainError::InvalidValueEncoding);
            }
            let mut arr = [0u8; 32];
            // Right-align in 32 bytes (big-endian)
            arr[32 - b.len()..].copy_from_slice(b);
            (arr, b.len())
        }
        _ => return Err(CrossChainError::InvalidValueEncoding),
    };

    // ── storageRoot ───────────────────────────────────────────────────────────
    let storage_root = match children.get(2) {
        Some(RlpItem::Bytes(b)) if b.len() == 32 => {
            let mut arr = [0u8; 32];
            arr.copy_from_slice(b);
            arr
        }
        _ => return Err(CrossChainError::InvalidValueEncoding),
    };

    // ── codeHash ─────────────────────────────────────────────────────────────
    let code_hash = match children.get(3) {
        Some(RlpItem::Bytes(b)) if b.len() == 32 => {
            let mut arr = [0u8; 32];
            arr.copy_from_slice(b);
            arr
        }
        _ => return Err(CrossChainError::InvalidValueEncoding),
    };

    Ok(EthAccount { nonce, balance, balance_len, storage_root, code_hash })
}

/// Convert a big-endian byte slice (0–8 bytes) to a `u64`.
fn bytes_to_u64(b: &[u8]) -> Result<u64, CrossChainError> {
    if b.len() > 8 {
        return Err(CrossChainError::InvalidValueEncoding);
    }
    let mut val = 0u64;
    for &byte in b {
        val = val << 8 | byte as u64;
    }
    Ok(val)
}

// ─────────────────────────────────────────────────────────────────────────────
// Reputation score helper
// ─────────────────────────────────────────────────────────────────────────────

/// Derive a simple reputation score from a verified Ethereum account.
///
/// The score is a normalised u32 in [0, 10_000] proportional to the log2 of
/// the ETH balance in wei, capped at 10 ETH (10^19 wei). This is a
/// straightforward, gas-cheap heuristic — governance can tune it.
pub fn reputation_score_from_account(account: &EthAccount) -> u32 {
    // Read the u128 balance (lower 16 bytes suffice for practical ETH balances).
    let balance_lo = u128::from_be_bytes({
        let mut b = [0u8; 16];
        let src = &account.balance[16..];
        b.copy_from_slice(src);
        b
    });

    if balance_lo == 0 {
        return 0;
    }

    // log2(balance) scaled to [0, 10_000]
    // log2(10^19) ≈ 63.1 — use integer log2 (leading_zeros trick)
    let log2 = 128u32 - balance_lo.leading_zeros();
    // scale: 10_000 * log2 / 64 (cap at 10_000)
    let score = (10_000u32 * log2) / 64;
    score.min(10_000)
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
    use crate::rlp::{EncodeBuf, encode_bytes_v2, encode_list_payload_v2};

    fn make_header(state_root: [u8; 32]) -> BlockHeader {
        BlockHeader { state_root, block_number: 12_000_000, chain_id: 1 }
    }

    // Build a trivial single-leaf proof matching `key` → `value`.
    fn build_single_leaf_proof(key: &[u8], value: &[u8]) -> ([u8; 32], Vec<u8>) {
        let path_hash = keccak256(key);
        // All 64 nibbles, even count
        let mut all_nibbles = [0u8; 64];
        for i in 0..32 {
            all_nibbles[2 * i]     = path_hash[i] >> 4;
            all_nibbles[2 * i + 1] = path_hash[i] & 0x0f;
        }
        // compact encode: flag=2 (leaf, even), first byte=0x20
        let mut compact = vec![0x20u8];
        let mut i = 0;
        while i + 1 < all_nibbles.len() {
            compact.push((all_nibbles[i] << 4) | all_nibbles[i + 1]);
            i += 2;
        }

        let mut payload = EncodeBuf::new();
        encode_bytes_v2(&compact, &mut payload).unwrap();
        encode_bytes_v2(value, &mut payload).unwrap();
        let mut leaf_enc = EncodeBuf::new();
        encode_list_payload_v2(payload.as_slice(), &mut leaf_enc).unwrap();
        let leaf_bytes = leaf_enc.as_slice().to_vec();
        let root = keccak256(&leaf_bytes);
        (root, leaf_bytes)
    }

    #[test]
    fn valid_inclusion_proof() {
        let key = b"ethereum_reputation";
        let value = b"score:9000";
        let (root, leaf) = build_single_leaf_proof(key, value);
        let header = make_header(root);
        let result = verify_state_proof(&header, key, value, &[leaf.as_slice()]);
        assert!(result.is_ok(), "{:?}", result);
        let vs = result.unwrap();
        assert_eq!(vs.chain_id, 1);
        assert_eq!(vs.block_number, 12_000_000);
        assert_eq!(&vs.value[..vs.value_len], value);
    }

    #[test]
    fn wrong_value_rejected() {
        let key = b"ethereum_reputation";
        let value = b"score:9000";
        let (root, leaf) = build_single_leaf_proof(key, value);
        let header = make_header(root);
        let result = verify_state_proof(&header, key, b"score:0", &[leaf.as_slice()]);
        assert_eq!(result, Err(CrossChainError::ProofVerifyError(MptError::ValueMismatch)));
    }

    #[test]
    fn tampered_root_rejected() {
        let key = b"ethereum_reputation";
        let value = b"score:9000";
        let (mut root, leaf) = build_single_leaf_proof(key, value);
        root[0] ^= 0xff; // corrupt the root
        let header = make_header(root);
        let result = verify_state_proof(&header, key, value, &[leaf.as_slice()]);
        assert_eq!(result, Err(CrossChainError::ProofVerifyError(MptError::RootHashMismatch)));
    }

    #[test]
    fn zero_chain_id_rejected() {
        let header = BlockHeader { state_root: [0u8; 32], block_number: 1, chain_id: 0 };
        let result = verify_state_proof(&header, b"key", b"val", &[&[0xc0]]);
        assert_eq!(result, Err(CrossChainError::InvalidHeader));
    }

    #[test]
    fn empty_key_rejected() {
        let header = make_header([0u8; 32]);
        let result = verify_state_proof(&header, b"", b"val", &[&[0xc0]]);
        assert_eq!(result, Err(CrossChainError::InputTooLong));
    }

    #[test]
    fn too_many_proof_nodes_rejected() {
        let header = make_header([0u8; 32]);
        let nodes: Vec<&[u8]> = (0..=MAX_PROOF_NODES).map(|_| [0xc0].as_slice()).collect();
        let result = verify_state_proof(&header, b"key", b"val", &nodes);
        assert_eq!(result, Err(CrossChainError::InputTooLong));
    }

    #[test]
    fn decode_eth_account_valid() {
        // Build: RLP([nonce=1, balance=0x01, storageRoot=32×0x56, codeHash=32×0x78])
        let nonce_bytes = [0x01u8];
        let balance_bytes = [0x01u8];
        let storage_root = [0x56u8; 32];
        let code_hash = [0x78u8; 32];

        let mut payload = EncodeBuf::new();
        encode_bytes_v2(&nonce_bytes, &mut payload).unwrap();
        encode_bytes_v2(&balance_bytes, &mut payload).unwrap();
        encode_bytes_v2(&storage_root, &mut payload).unwrap();
        encode_bytes_v2(&code_hash, &mut payload).unwrap();
        let mut out = EncodeBuf::new();
        encode_list_payload_v2(payload.as_slice(), &mut out).unwrap();

        let acc = decode_eth_account(out.as_slice()).unwrap();
        assert_eq!(acc.nonce, 1);
        assert_eq!(acc.balance[31], 1);
        assert_eq!(acc.storage_root, storage_root);
        assert_eq!(acc.code_hash, code_hash);
    }

    #[test]
    fn decode_eth_account_invalid_rlp() {
        let result = decode_eth_account(b"notrlp\xff");
        assert!(matches!(result, Err(CrossChainError::RlpDecodeError(_))));
    }

    #[test]
    fn reputation_score_zero_balance() {
        let acc = EthAccount::default();
        assert_eq!(reputation_score_from_account(&acc), 0);
    }

    #[test]
    fn reputation_score_nonzero() {
        let mut acc = EthAccount::default();
        // 1 ETH = 10^18 wei ≈ 0xDE0B6B3A7640000
        // log2(10^18) ≈ 60, score = 10000*60/64 = 9375
        let one_eth_wei: u128 = 1_000_000_000_000_000_000;
        let be = one_eth_wei.to_be_bytes();
        acc.balance[16..].copy_from_slice(&be);
        acc.balance_len = 16;
        let score = reputation_score_from_account(&acc);
        assert!(score > 0 && score <= 10_000, "score={}", score);
    }

    #[test]
    fn manipulated_proof_node_rejected() {
        let key = b"test_key";
        let value = b"test_value";
        let (root, mut leaf) = build_single_leaf_proof(key, value);
        // Flip a byte in the middle of the node
        let mid = leaf.len() / 2;
        leaf[mid] ^= 0xff;
        let header = make_header(root);
        let result = verify_state_proof(&header, key, value, &[leaf.as_slice()]);
        // Either hash mismatch or path mismatch or RLP error — all are rejections
        assert!(result.is_err(), "manipulated proof should be rejected");
    }
}
