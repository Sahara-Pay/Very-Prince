//! # BLS12-381 Signature Aggregation Verifier
//!
//! Provides utilities for verifying aggregated BLS signatures and preventing
//! rogue-key attacks via Proof-of-Possession (PoP) during key registration.
//!
//! BLS aggregation allows multiple signatures to be combined into a single
//! 48-byte curve point, reducing on-chain verification costs from O(N) to O(1)
//! pairings, regardless of the number of signers.

use bls12_381_plus::{
    multi_miller_loop, G1Affine, G2Affine, G1Projective, G2Prepared, G2Projective,
    Gt, group::Curve,
};
use bls12_381_plus::elliptic_curve::hash2curve::ExpandMsgXmd;

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/// Domain separation tag for BLS signatures (G1).
const DST_SIG: &[u8] = b"BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_";
/// Domain separation tag for Proof-of-Possession (PoP).
const DST_POP: &[u8] = b"BLS_POP_BLS12381G1_XMD:SHA-256_SSWU_RO_POP_";

// ─────────────────────────────────────────────────────────────────────────────
// Verification Logic
// ─────────────────────────────────────────────────────────────────────────────

/// Verify an aggregated BLS signature against an aggregated public key.
///
/// Equation: e(signature, G2_generator) == e(H(message), aggregated_pk)
///
/// # Arguments
/// * `aggregated_sig_bytes` - The 48-byte compressed G1 signature.
/// * `aggregated_pk_bytes`  - The 96-byte compressed G2 public key.
/// * `message`              - The raw message bytes that were signed.
pub fn verify_aggregated(
    aggregated_sig_bytes: &[u8; 48],
    aggregated_pk_bytes: &[u8; 96],
    message: &[u8],
) -> bool {
    let sig = match G1Affine::from_compressed(aggregated_sig_bytes).into_option() {
        Some(s) => s,
        None => return false,
    };
    let pk = match G2Affine::from_compressed(aggregated_pk_bytes).into_option() {
        Some(p) => p,
        None => return false,
    };

    // Hash message to G1 using bls12_381_plus 0.8.x API.
    let h_m = G1Projective::hash::<ExpandMsgXmd<sha2::Sha256>>(message, DST_SIG).to_affine();

    // Perform pairing check: e(sig, -G2) * e(h_m, pk) == 1
    let g2_gen_neg = -G2Affine::generator();

    let miller = multi_miller_loop(&[
        (&sig, &G2Prepared::from(g2_gen_neg)),
        (&h_m, &G2Prepared::from(pk)),
    ]);

    miller.final_exponentiation() == Gt::IDENTITY
}

/// Verify a Proof-of-Possession (PoP) for a public key.
///
/// A PoP is a signature on the public key itself using the corresponding private key.
/// Verifying this during registration prevents rogue-key attacks where an attacker
/// provides a public key that cancels out other keys in an aggregation.
///
/// Equation: e(pop, G2_generator) == e(H_pop(pk), pk)
pub fn verify_pop(
    pk_bytes: &[u8; 96],
    pop_bytes: &[u8; 48],
) -> bool {
    let pk = match G2Affine::from_compressed(pk_bytes).into_option() {
        Some(p) => p,
        None => return false,
    };
    let pop = match G1Affine::from_compressed(pop_bytes).into_option() {
        Some(s) => s,
        None => return false,
    };

    // Hash the public key to G1 using the PoP domain tag.
    let h_pk = G1Projective::hash::<ExpandMsgXmd<sha2::Sha256>>(pk_bytes, DST_POP).to_affine();

    let g2_gen_neg = -G2Affine::generator();

    let miller = multi_miller_loop(&[
        (&pop, &G2Prepared::from(g2_gen_neg)),
        (&h_pk, &G2Prepared::from(pk)),
    ]);

    miller.final_exponentiation() == Gt::IDENTITY
}

/// Aggregate a new public key into an existing aggregated key.
///
/// This is done on-chain during signer registration after PoP verification.
pub fn aggregate_pk(
    current_agg_pk_bytes: &[u8; 96],
    new_pk_bytes: &[u8; 96],
) -> Option<[u8; 96]> {
    let current_agg: G2Projective = if current_agg_pk_bytes == &[0u8; 96] {
        G2Projective::IDENTITY
    } else {
        G2Affine::from_compressed(current_agg_pk_bytes).into_option()?.into()
    };

    let new_pk = G2Affine::from_compressed(new_pk_bytes).into_option()?;

    let updated_agg = (current_agg + new_pk).to_affine();
    Some(updated_agg.to_compressed())
}
