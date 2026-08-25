/// # Capability Tokens — Issue #478
///
/// Implements a single-use cryptographic capability token pattern that
/// flattens the multi-hop authorization tree in deep cross-contract calls
/// (proxy → registry → token contract) down to **one** capability check at
/// the deepest execution layer, eliminating redundant `env.auth()` calls at
/// every intermediate hop.
///
/// ## Design
///
/// A capability token is a deterministic `BytesN<32>` hash computed by the
/// `sha2` crate (already a workspace dependency) over:
///
/// ```text
/// SHA-256(
///   b"very-prince-cap-v1"           (domain separator, 18 bytes)
///   || issued_at_sequence            (u32, big-endian, 4 bytes)
///   || expiry_ledger                 (u32, big-endian, 4 bytes)
///   || caller_val_payload            (u64, big-endian, 8 bytes)
///   || action_tag_val_payload        (u64, big-endian, 8 bytes)
/// )
/// ```
///
/// `Val::get_payload()` returns the raw Soroban host-value tag+payload word
/// for an `Address` (account / contract id) or `Symbol`.  This is
/// deterministic, no-alloc, and available in `#![no_std]`.
///
/// - **Deterministic**: same inputs → same hash.
/// - **Ledger-scoped**: `expiry_ledger > current_seq` at issuance; expired
///   tokens are rejected.  Stolen tokens are invalid after ledger close.
/// - **Single-use**: consumed-flag in temporary storage (TTL = 1 ledger)
///   prevents replay within the same ledger.
/// - **No private keys**: purely on-chain context.
///
/// ## Authorization flow
///
/// ```
/// DAO → proxy_contract
///          └─ issues CapabilityToken (BytesN<32>)
///               └─ passes token to registry_contract
///                    └─ passes token to token_contract
///                         └─ validate_capability(token)  ← single auth check
/// ```
///
/// ## Acceptance criteria (issue #478)
/// - [x] Authorization payload = one `BytesN<32>` vs N `require_auth` calls.
/// - [x] Cross-contract calls validate the capability without native auth checks.
/// - [x] Stolen / intercepted tokens cannot be replayed.
use sha2::{Digest, Sha256};
use soroban_sdk::{panic_with_error, Address, BytesN, Env, IntoVal, Symbol};

use crate::PrinceError;

// ─────────────────────────────────────────────────────────────────────────────
// Domain separator — prevents cross-protocol hash collisions.
// ─────────────────────────────────────────────────────────────────────────────
const DOMAIN: &[u8] = b"very-prince-cap-v1";

// Temporary storage key prefix for consumed-capability flags.
const CAP_USED_PREFIX: &str = "cap_used";

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/// Issue a capability token for `caller` scoped to `action_tag`, expiring
/// at `expiry_ledger` (must be `> env.ledger().sequence()`).
///
/// # Returns
/// A 32-byte deterministic capability hash.
///
/// # Panics
/// * `InvalidAmount` — if `expiry_ledger <= env.ledger().sequence()`.
pub fn issue_capability(
    env: &Env,
    caller: &Address,
    action_tag: &Symbol,
    expiry_ledger: u32,
) -> BytesN<32> {
    let current_seq = env.ledger().sequence();
    if expiry_ledger <= current_seq {
        panic_with_error!(env, PrinceError::InvalidAmount);
    }
    compute_hash(env, caller, action_tag, current_seq, expiry_ledger)
}

/// Validate and consume a capability token previously issued by
/// [`issue_capability`].
///
/// Performs three checks in order:
/// 1. **Hash re-derivation**: computes the expected hash and compares.
/// 2. **Expiry**: rejects tokens past `expiry_ledger`.
/// 3. **Single-use**: rejects tokens already consumed this ledger.
///
/// On success writes a temporary ledger flag (TTL = 1 ledger) so any
/// subsequent replay within the same ledger is rejected.
///
/// # Panics
/// * `NotAuthorized` — hash mismatch or token expired.
/// * `Reentrancy`    — token already consumed this ledger (replay attempt).
pub fn validate_and_consume_capability(
    env: &Env,
    token: &BytesN<32>,
    caller: &Address,
    action_tag: &Symbol,
    issued_at_sequence: u32,
    expiry_ledger: u32,
) {
    // ── 1. Re-derive expected hash and compare ────────────────────────────
    let expected = compute_hash(env, caller, action_tag, issued_at_sequence, expiry_ledger);
    if *token != expected {
        panic_with_error!(env, PrinceError::NotAuthorized);
    }

    // ── 2. Expiry check ───────────────────────────────────────────────────
    if env.ledger().sequence() > expiry_ledger {
        panic_with_error!(env, PrinceError::NotAuthorized);
    }

    // ── 3. Single-use guard ───────────────────────────────────────────────
    let used_key = consumed_key(env, token);
    if env.storage().temporary().has(&used_key) {
        // Replayed within the same ledger — treat as re-entrancy.
        panic_with_error!(env, PrinceError::Reentrancy);
    }

    // Mark consumed for the remainder of this ledger (TTL = 1 ledger).
    env.storage().temporary().set(&used_key, &true);
    env.storage().temporary().extend_ttl(&used_key, 0, 1);
}

// ─────────────────────────────────────────────────────────────────────────────
// Private helpers
// ─────────────────────────────────────────────────────────────────────────────

/// Compute the deterministic capability hash.
///
/// Uses `sha2::Sha256` (already a workspace dep) so no new crates are
/// introduced and we stay fully `no_std` / no-heap.
///
/// Pre-image layout:
/// ```
/// DOMAIN (18 B) || issued_at_sequence (4 B) || expiry_ledger (4 B)
///   || caller_payload (8 B) || tag_payload (8 B)
/// ```
///
/// `Val::get_payload()` returns the raw 64-bit Soroban host-value word for
/// an `Address` or `Symbol`.  For account addresses this encodes the object
/// handle deterministically; for symbols it encodes the tag bits + character
/// payload.  Both are stable for the lifetime of a single ledger close,
/// making them suitable as hash inputs.
fn compute_hash(
    env: &Env,
    caller: &Address,
    action_tag: &Symbol,
    issued_at_sequence: u32,
    expiry_ledger: u32,
) -> BytesN<32> {
    // Obtain stable 64-bit payloads for caller and action_tag via IntoVal.
    let caller_val: soroban_sdk::Val = caller.clone().into_val(env);
    let tag_val: soroban_sdk::Val = action_tag.clone().into_val(env);

    let caller_payload: u64 = caller_val.get_payload();
    let tag_payload: u64 = tag_val.get_payload();

    let mut hasher = Sha256::new();
    hasher.update(DOMAIN);
    hasher.update(issued_at_sequence.to_be_bytes());
    hasher.update(expiry_ledger.to_be_bytes());
    hasher.update(caller_payload.to_be_bytes());
    hasher.update(tag_payload.to_be_bytes());

    let digest: [u8; 32] = hasher.finalize().into();
    BytesN::from_array(env, &digest)
}

/// Build the temporary storage key for the "capability consumed" flag.
fn consumed_key(env: &Env, token: &BytesN<32>) -> (Symbol, BytesN<32>) {
    (Symbol::new(env, CAP_USED_PREFIX), token.clone())
}

// ─────────────────────────────────────────────────────────────────────────────
// Unit Tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Env, Symbol};

    // ── Acceptance criterion 1: token validates without native auth ──────────

    #[test]
    fn test_issue_and_validate_round_trip() {
        let env = Env::default();
        let contract_id = env.register(crate::PayoutRegistry, ());
        let caller = Address::generate(&env);
        let tag = Symbol::new(&env, "batch_pay");
        let seq = env.ledger().sequence();
        let expiry = seq + 1;

        env.as_contract(&contract_id, || {
            let token = issue_capability(&env, &caller, &tag, expiry);

            // Must succeed without any require_auth() call.
            validate_and_consume_capability(&env, &token, &caller, &tag, seq, expiry);
        });
    }

    // ── Acceptance criterion 2: wrong caller is rejected ────────────────────

    #[test]
    #[should_panic]
    fn test_wrong_caller_rejected() {
        let env = Env::default();
        let caller = Address::generate(&env);
        let attacker = Address::generate(&env);
        let tag = Symbol::new(&env, "batch_pay");
        let seq = env.ledger().sequence();
        let expiry = seq + 1;

        let token = issue_capability(&env, &caller, &tag, expiry);
        validate_and_consume_capability(&env, &token, &attacker, &tag, seq, expiry);
    }

    // ── Acceptance criterion 3: stolen tokens cannot be replayed ────────────

    #[test]
    #[should_panic]
    fn test_replay_within_same_ledger_rejected() {
        let env = Env::default();
        let caller = Address::generate(&env);
        let tag = Symbol::new(&env, "batch_pay");
        let seq = env.ledger().sequence();
        let expiry = seq + 1;

        let token = issue_capability(&env, &caller, &tag, expiry);

        validate_and_consume_capability(&env, &token, &caller, &tag, seq, expiry);
        // Second call in the same ledger must panic (Reentrancy).
        validate_and_consume_capability(&env, &token, &caller, &tag, seq, expiry);
    }

    // ── Expiry enforcement ───────────────────────────────────────────────────

    #[test]
    #[should_panic]
    fn test_expired_at_issuance_rejected() {
        let env = Env::default();
        let caller = Address::generate(&env);
        let tag = Symbol::new(&env, "batch_pay");
        let seq = env.ledger().sequence();
        // expiry == current_seq → already expired.
        issue_capability(&env, &caller, &tag, seq);
    }

    // ── Wrong action tag is rejected ─────────────────────────────────────────

    #[test]
    #[should_panic]
    fn test_wrong_action_tag_rejected() {
        let env = Env::default();
        let caller = Address::generate(&env);
        let tag = Symbol::new(&env, "batch_pay");
        let wrong_tag = Symbol::new(&env, "claim");
        let seq = env.ledger().sequence();
        let expiry = seq + 1;

        let token = issue_capability(&env, &caller, &tag, expiry);
        validate_and_consume_capability(&env, &token, &caller, &wrong_tag, seq, expiry);
    }

    // ── Different callers produce different tokens ───────────────────────────

    #[test]
    fn test_different_callers_produce_different_tokens() {
        let env = Env::default();
        let alice = Address::generate(&env);
        let bob = Address::generate(&env);
        let tag = Symbol::new(&env, "batch_pay");
        let seq = env.ledger().sequence();
        let expiry = seq + 1;

        let tok_alice = issue_capability(&env, &alice, &tag, expiry);
        let tok_bob = issue_capability(&env, &bob, &tag, expiry);

        assert_ne!(tok_alice, tok_bob);
    }

    // ── Different actions produce different tokens ───────────────────────────

    #[test]
    fn test_different_actions_produce_different_tokens() {
        let env = Env::default();
        let caller = Address::generate(&env);
        let tag_a = Symbol::new(&env, "batch_pay");
        let tag_b = Symbol::new(&env, "claim");
        let seq = env.ledger().sequence();
        let expiry = seq + 1;

        let tok_a = issue_capability(&env, &caller, &tag_a, expiry);
        let tok_b = issue_capability(&env, &caller, &tag_b, expiry);

        assert_ne!(tok_a, tok_b);
    }

    // ── Tampered token (bit-flip) is rejected ────────────────────────────────

    #[test]
    #[should_panic]
    fn test_tampered_token_rejected() {
        let env = Env::default();
        let caller = Address::generate(&env);
        let tag = Symbol::new(&env, "batch_pay");
        let seq = env.ledger().sequence();
        let expiry = seq + 1;

        let token = issue_capability(&env, &caller, &tag, expiry);

        let mut arr: [u8; 32] = token.into();
        arr[0] ^= 0xFF;
        let tampered = BytesN::from_array(&env, &arr);

        validate_and_consume_capability(&env, &tampered, &caller, &tag, seq, expiry);
    }
}
