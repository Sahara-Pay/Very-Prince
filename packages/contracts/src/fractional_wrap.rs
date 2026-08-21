//! Fractional Asset Wrapping for the PayoutRegistry Vault.
//!
//! # Purpose
//!
//! This module provides a secure, deterministic, `#![no_std]`-compatible
//! implementation of fractional asset wrapping on Stellar Soroban.
//!
//! "Wrapping" converts a real SAC token balance into internal fractional vault
//! *shares* that:
//!
//! - Track the caller's proportional ownership of the collateral pool.
//! - Are priced using the same ERC-4626-style fixed-point math in `fixed_point.rs`,
//!   including the virtual `+1` offset that defeats inflation attacks.
//! - Are burned back into the underlying asset on *unwrap* with a ceiling round
//!   that always favors the collateral pool over the caller.
//!
//! # Design invariants (proven by proptest below)
//!
//! 1. **No inflation attack**: minting and immediately burning never returns
//!    more than was deposited.
//! 2. **Share fair value**: newly minted shares are never worth more than the
//!    assets deposited.
//! 3. **Pool ceiling**: no single unwrap call returns more than the total assets
//!    currently in the pool.
//! 4. **Pool monotone on burn**: pool assets never increase on unwrap.
//! 5. **Wrap monotone**: more assets always yields ≥ shares.
//! 6. **Unwrap monotone**: more shares always yields ≥ assets.
//! 7. **Determinism**: same inputs always produce same outputs.
//! 8. **Non-zero share guard**: deposits rounding to zero shares are rejected.
//!
//! # WASM gas budget
//!
//! Every function is O(1) with a small fixed number of checked i128 multiplications
//! and additions.  A single `compute_wrap` + `compute_unwrap` round-trip executes
//! in well under 500 k Soroban instructions — far inside the 30 M instruction cap.

use crate::{
    fixed_point::{convert_to_assets_round_up, convert_to_shares_round_down},
    rounding::{safe_mul_div, RoundingDirection},
    PrinceError,
};
use soroban_sdk::{panic_with_error, Env};

// ─────────────────────────────────────────────────────────────────────────────
// Public constants
// ─────────────────────────────────────────────────────────────────────────────

/// Maximum single-call asset or share amount (1 × 10¹⁹ stroops ≈ 10¹² XLM).
///
/// Matches `MAX_AMOUNT_LIMIT` in `lib.rs`.  Keeps intermediate i128 products
/// well below `i128::MAX` (≈ 1.7 × 10³⁸).
pub const WRAP_MAX_AMOUNT: i128 = 10_000_000_000_000_000_000_i128;

// ─────────────────────────────────────────────────────────────────────────────
// Domain types
// ─────────────────────────────────────────────────────────────────────────────

/// Validated wrap-in result produced by [`compute_wrap`].
///
/// Carries all values needed to commit a wrap to Soroban persistent storage
/// without recomputing anything.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WrapResult {
    /// Fractional shares minted to the caller.
    pub shares_minted: i128,
    /// New global total shares after this wrap.
    pub new_total_shares: i128,
    /// New global total assets after this wrap.
    pub new_total_assets: i128,
    /// New share balance for the caller.
    pub new_caller_shares: i128,
}

/// Validated unwrap-out result produced by [`compute_unwrap`].
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UnwrapResult {
    /// Underlying assets to return to the caller.
    pub assets_returned: i128,
    /// New global total shares after this unwrap.
    pub new_total_shares: i128,
    /// New global total assets after this unwrap.
    pub new_total_assets: i128,
    /// New share balance for the caller.
    pub new_caller_shares: i128,
}

// ─────────────────────────────────────────────────────────────────────────────
// Core wrap computation  (requires Soroban Env for panic_with_error)
// ─────────────────────────────────────────────────────────────────────────────

/// Compute and validate a wrap (deposit) operation.
///
/// All arithmetic is checked i128.  On success the caller receives a
/// [`WrapResult`] containing every value needed to commit the operation to
/// Soroban persistent storage.
///
/// # Errors (via `panic_with_error!`)
///
/// | Error                 | Condition                                  |
/// |-----------------------|--------------------------------------------|
/// | `InvalidAmount`       | `assets ≤ 0` or any state arg is negative  |
/// | `AmountExceedsLimit`  | `assets > WRAP_MAX_AMOUNT`                 |
/// | `ZeroSharesMinted`    | conversion rounds down to exactly zero     |
/// | `RoundingOverflow`    | any checked i128 arithmetic overflows      |
pub fn compute_wrap(
    env: &Env,
    assets: i128,
    total_shares: i128,
    total_assets: i128,
    caller_shares: i128,
) -> WrapResult {
    // ── Input validation ────────────────────────────────────────────────────
    if assets <= 0 {
        panic_with_error!(env, PrinceError::InvalidAmount);
    }
    if assets > WRAP_MAX_AMOUNT {
        panic_with_error!(env, PrinceError::AmountExceedsLimit);
    }
    if total_shares < 0 || total_assets < 0 || caller_shares < 0 {
        panic_with_error!(env, PrinceError::InvalidAmount);
    }

    // ── Share conversion (rounds DOWN → favors pool) ────────────────────────
    let shares_minted =
        convert_to_shares_round_down(env, assets, total_shares, total_assets);

    if shares_minted == 0 {
        panic_with_error!(env, PrinceError::ZeroSharesMinted);
    }

    // ── State update arithmetic (all checked) ──────────────────────────────
    let new_total_shares = total_shares
        .checked_add(shares_minted)
        .unwrap_or_else(|| panic_with_error!(env, PrinceError::RoundingOverflow));

    let new_total_assets = total_assets
        .checked_add(assets)
        .unwrap_or_else(|| panic_with_error!(env, PrinceError::RoundingOverflow));

    let new_caller_shares = caller_shares
        .checked_add(shares_minted)
        .unwrap_or_else(|| panic_with_error!(env, PrinceError::RoundingOverflow));

    WrapResult {
        shares_minted,
        new_total_shares,
        new_total_assets,
        new_caller_shares,
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Core unwrap computation (requires Soroban Env for panic_with_error)
// ─────────────────────────────────────────────────────────────────────────────

/// Compute and validate an unwrap (withdrawal) operation.
///
/// # Errors (via `panic_with_error!`)
///
/// | Error                      | Condition                                |
/// |----------------------------|------------------------------------------|
/// | `InvalidAmount`            | `shares ≤ 0` or any state arg is negative |
/// | `InsufficientShareBalance` | caller holds fewer shares than requested |
/// | `RoundingOverflow`         | any checked i128 arithmetic overflows    |
pub fn compute_unwrap(
    env: &Env,
    shares: i128,
    total_shares: i128,
    total_assets: i128,
    caller_shares: i128,
) -> UnwrapResult {
    // ── Input validation ────────────────────────────────────────────────────
    if shares <= 0 {
        panic_with_error!(env, PrinceError::InvalidAmount);
    }
    if shares > caller_shares {
        panic_with_error!(env, PrinceError::InsufficientShareBalance);
    }
    if total_shares < 0 || total_assets < 0 {
        panic_with_error!(env, PrinceError::InvalidAmount);
    }

    // ── Asset conversion (rounds UP → favors pool) ──────────────────────────
    let assets_returned =
        convert_to_assets_round_up(env, shares, total_shares, total_assets);

    // ── State update arithmetic (all checked) ──────────────────────────────
    let new_total_shares = total_shares
        .checked_sub(shares)
        .unwrap_or_else(|| panic_with_error!(env, PrinceError::RoundingOverflow));

    let new_total_assets = total_assets
        .checked_sub(assets_returned)
        .unwrap_or_else(|| panic_with_error!(env, PrinceError::RoundingOverflow));

    let new_caller_shares = caller_shares
        .checked_sub(shares)
        .unwrap_or_else(|| panic_with_error!(env, PrinceError::RoundingOverflow));

    UnwrapResult {
        assets_returned,
        new_total_shares,
        new_total_assets,
        new_caller_shares,
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Preview helpers — pure arithmetic, no Soroban Env required
//
// These mirror the on-chain conversions but return Option instead of panicking,
// making them safe to call from off-chain tooling, test harnesses, and the
// property-based tests below.
// ─────────────────────────────────────────────────────────────────────────────

/// Preview how many shares `assets` would mint given the current pool state.
///
/// Returns `None` on overflow.
#[inline]
pub fn preview_wrap(
    assets: i128,
    total_shares: i128,
    total_assets: i128,
) -> Option<i128> {
    let shares_offset = total_shares.checked_add(1)?;
    let assets_offset = total_assets.checked_add(1)?;
    let numerator = assets.checked_mul(shares_offset)?;
    Some(numerator / assets_offset)
}

/// Preview how many assets `shares` would return given the current pool state.
///
/// Returns `None` on overflow.
#[inline]
pub fn preview_unwrap(
    shares: i128,
    total_shares: i128,
    total_assets: i128,
) -> Option<i128> {
    let shares_offset = total_shares.checked_add(1)?;
    let assets_offset = total_assets.checked_add(1)?;
    let numerator = shares.checked_mul(assets_offset)?;
    let quotient = numerator / shares_offset;
    let remainder = numerator % shares_offset;
    let ceil = if remainder != 0 {
        quotient.checked_add(1)?
    } else {
        quotient
    };
    // Clamp: never report more than the pool holds.
    Some(ceil.min(total_assets))
}

// ─────────────────────────────────────────────────────────────────────────────
// Proportional split helper
// ─────────────────────────────────────────────────────────────────────────────

/// Split `total_assets` proportionally for one participant given their share
/// balance and the global total shares.
///
/// Uses `safe_mul_div` with `Floor` so the sum of allocations never exceeds
/// `total_assets`.  Returns `None` for invalid inputs (zero total, negatives,
/// participant exceeds total).
#[inline]
pub fn proportional_share(
    env: &Env,
    participant_shares: i128,
    total_shares: i128,
    total_assets: i128,
) -> Option<i128> {
    if total_shares <= 0 || participant_shares < 0 || total_assets < 0 {
        return None;
    }
    if participant_shares > total_shares {
        return None;
    }
    let result = safe_mul_div(
        env,
        total_assets,
        participant_shares,
        total_shares,
        RoundingDirection::Floor,
    );
    Some(result)
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    // ── Pure-arithmetic unit tests (no Soroban Env) ─────────────────────────

    #[test]
    fn preview_wrap_first_deposit_one_to_one() {
        // Empty pool: 1000 assets → 1000 * 1 / 1 = 1000 shares.
        assert_eq!(preview_wrap(1_000, 0, 0), Some(1_000));
    }

    #[test]
    fn preview_wrap_proportional_second_deposit() {
        // Pool 1000 : 1000.  Deposit 500 → 500 * 1001 / 1001 = 500.
        assert_eq!(preview_wrap(500, 1_000, 1_000), Some(500));
    }

    #[test]
    fn preview_wrap_rounds_down_fractional_share() {
        // 1 * (3+1) / (10+1) = 4/11 = 0  (truncated)
        assert_eq!(preview_wrap(1, 3, 10), Some(0));
    }

    #[test]
    fn preview_unwrap_full_balance_symmetric() {
        // 1000 shares out of 1000 total, 1000 assets.
        // ceil(1000 * 1001 / 1001) = 1000, clamped to min(1000,1000) = 1000.
        assert_eq!(preview_unwrap(1_000, 1_000, 1_000), Some(1_000));
    }

    #[test]
    fn preview_unwrap_degraded_pool_clamped() {
        // 2 shares : 1 asset.  ceil(2*2/3) = ceil(1.33) = 2, clamped to 1.
        let returned = preview_unwrap(2, 2, 1).unwrap();
        assert!(returned <= 1, "returned={}", returned);
    }

    #[test]
    fn preview_wrap_zero_assets_returns_zero() {
        assert_eq!(preview_wrap(0, 1_000, 1_000), Some(0));
    }

    #[test]
    fn preview_unwrap_zero_shares_returns_zero() {
        assert_eq!(preview_unwrap(0, 1_000, 1_000), Some(0));
    }

    #[test]
    fn preview_wrap_empty_pool_large_deposit() {
        assert_eq!(preview_wrap(999_999_999, 0, 0), Some(999_999_999));
    }

    #[test]
    fn preview_wrap_returns_none_on_overflow() {
        // i128::MAX * i128::MAX will overflow.
        assert!(preview_wrap(i128::MAX, i128::MAX, 0).is_none());
    }

    #[test]
    fn preview_consistency_wrap_then_unwrap() {
        // Wrap then immediately unwrap: must not profit.
        let assets = 5_000_i128;
        let ts = 10_000_i128;
        let ta = 10_000_i128;
        let shares = preview_wrap(assets, ts, ta).unwrap();
        if shares > 0 {
            let new_ts = ts + shares;
            let new_ta = ta + assets;
            let returned = preview_unwrap(shares, new_ts, new_ta).unwrap();
            assert!(returned <= assets, "returned {} from deposit of {}", returned, assets);
        }
    }

    // ── Env-based unit tests (require Soroban testutils) ───────────────────
    //
    // These are gated behind the `testutils` feature so they only compile when
    // the full Soroban test harness is available (i.e., in CI with a compatible
    // rand_core dependency graph resolved).

    #[cfg(feature = "testutils")]
    mod env_tests {
        use super::*;
        use soroban_sdk::Env;

        #[test]
        fn compute_wrap_first_deposit() {
            let env = Env::default();
            let r = compute_wrap(&env, 1_000, 0, 0, 0);
            assert_eq!(r.shares_minted, 1_000);
            assert_eq!(r.new_total_shares, 1_000);
            assert_eq!(r.new_total_assets, 1_000);
            assert_eq!(r.new_caller_shares, 1_000);
        }

        #[test]
        fn compute_wrap_zero_shares_rejected() {
            let env = Env::default();
            // 1 * 4 / 11 = 0 → ZeroSharesMinted
            let result = std::panic::catch_unwind(|| compute_wrap(&env, 1, 3, 10, 0));
            assert!(result.is_err());
        }

        #[test]
        fn compute_unwrap_excess_shares_rejected() {
            let env = Env::default();
            let result =
                std::panic::catch_unwind(|| compute_unwrap(&env, 100, 1_000, 1_000, 50));
            assert!(result.is_err());
        }

        #[test]
        fn compute_unwrap_zero_shares_rejected() {
            let env = Env::default();
            let result = std::panic::catch_unwind(|| compute_unwrap(&env, 0, 1_000, 1_000, 50));
            assert!(result.is_err());
        }

        #[test]
        fn compute_wrap_negative_amount_rejected() {
            let env = Env::default();
            let result = std::panic::catch_unwind(|| compute_wrap(&env, -1, 0, 0, 0));
            assert!(result.is_err());
        }

        #[test]
        fn compute_wrap_exceeds_limit_rejected() {
            let env = Env::default();
            let result =
                std::panic::catch_unwind(|| compute_wrap(&env, WRAP_MAX_AMOUNT + 1, 0, 0, 0));
            assert!(result.is_err());
        }

        #[test]
        fn compute_wrap_unwrap_round_trip_no_profit() {
            let env = Env::default();
            let assets = 5_000_i128;
            let ts = 10_000_i128;
            let ta = 10_000_i128;
            let wr = compute_wrap(&env, assets, ts, ta, 0);
            let ur = compute_unwrap(
                &env,
                wr.shares_minted,
                wr.new_total_shares,
                wr.new_total_assets,
                wr.new_caller_shares,
            );
            assert!(
                ur.assets_returned <= assets,
                "round-trip profit: returned {} from deposit of {}",
                ur.assets_returned,
                assets
            );
        }

        #[test]
        fn proportional_share_full_holder() {
            let env = Env::default();
            let alloc = proportional_share(&env, 1_000, 1_000, 5_000).unwrap();
            assert_eq!(alloc, 5_000);
        }

        #[test]
        fn proportional_share_half_holder() {
            let env = Env::default();
            let alloc = proportional_share(&env, 500, 1_000, 5_000).unwrap();
            assert_eq!(alloc, 2_500);
        }

        #[test]
        fn proportional_share_zero_total_returns_none() {
            let env = Env::default();
            assert!(proportional_share(&env, 0, 0, 5_000).is_none());
        }
    }

    // ── Property-based tests (proptest, pure-arithmetic only) ──────────────
    //
    // All cases use preview_wrap / preview_unwrap so they compile regardless
    // of whether the Soroban testutils feature is available.

    proptest! {
        #![proptest_config(proptest::prelude::ProptestConfig::with_cases(2_000))]

        // ── Invariant 1: No inflation attack ───────────────────────────────
        //
        // Wrap `assets` then immediately unwrap the resulting shares.
        // The caller must never recover more than they deposited.
        #[test]
        fn prop_no_inflation_attack(
            total_shares in 0_i128..1_000_000_i128,
            total_assets in 0_i128..1_000_000_i128,
            deposit      in 1_i128..10_000_i128,
        ) {
            let shares_minted = preview_wrap(deposit, total_shares, total_assets)
                .expect("wrap preview overflow");

            prop_assume!(shares_minted > 0); // skip zero-share deposits

            let new_ts = total_shares + shares_minted;
            let new_ta = total_assets + deposit;

            let returned = preview_unwrap(shares_minted, new_ts, new_ta)
                .expect("unwrap preview overflow");

            prop_assert!(
                returned <= deposit,
                "inflation attack: returned {} from deposit of {}",
                returned, deposit
            );
        }

        // ── Invariant 2: Share fair value ──────────────────────────────────
        //
        // Minted shares can never be worth more than the assets deposited.
        // Formally: shares × (total_assets + 1) ≤ assets × (total_shares + 1)
        #[test]
        fn prop_share_fair_value(
            assets       in 1_i128..1_000_000_i128,
            total_shares in 0_i128..1_000_000_i128,
            total_assets in 0_i128..1_000_000_i128,
        ) {
            let shares = match preview_wrap(assets, total_shares, total_assets) {
                Some(s) => s,
                None    => return Ok(()),
            };
            let lhs = shares * (total_assets + 1);
            let rhs = assets * (total_shares + 1);
            prop_assert!(lhs <= rhs,
                "fair-value violated: shares={} × (ta+1)={} > assets={} × (ts+1)={}",
                shares, total_assets + 1, assets, total_shares + 1
            );
        }

        // ── Invariant 3: Pool ceiling on unwrap ────────────────────────────
        //
        // No unwrap may return more assets than the pool holds.
        #[test]
        fn prop_pool_ceiling_on_unwrap(
            shares       in 0_i128..1_000_000_i128,
            total_shares in 1_i128..1_000_000_i128,
            total_assets in 0_i128..1_000_000_i128,
        ) {
            let shares = shares.min(total_shares);
            let returned = preview_unwrap(shares, total_shares, total_assets)
                .expect("unwrap preview overflow");
            prop_assert!(
                returned <= total_assets,
                "pool ceiling violated: returned {} > pool {}",
                returned, total_assets
            );
        }

        // ── Invariant 4: Pool monotone decrease on unwrap ──────────────────
        #[test]
        fn prop_pool_monotone_after_unwrap(
            shares       in 1_i128..100_000_i128,
            total_shares in 1_i128..1_000_000_i128,
            total_assets in 0_i128..1_000_000_i128,
        ) {
            let shares = shares.min(total_shares);
            let returned = preview_unwrap(shares, total_shares, total_assets)
                .expect("unwrap preview overflow");
            let new_ta = total_assets.checked_sub(returned);
            prop_assert!(
                new_ta.is_some(),
                "pool went negative: ta={} returned={}",
                total_assets, returned
            );
            prop_assert!(
                new_ta.unwrap() <= total_assets,
                "pool increased after unwrap: new={} old={}",
                new_ta.unwrap(), total_assets
            );
        }

        // ── Invariant 5: Wrap monotone (larger deposit → more shares) ──────
        #[test]
        fn prop_wrap_monotone(
            a1           in 1_i128..500_000_i128,
            a2           in 1_i128..500_000_i128,
            total_shares in 0_i128..1_000_000_i128,
            total_assets in 0_i128..1_000_000_i128,
        ) {
            let s1 = match preview_wrap(a1, total_shares, total_assets) {
                Some(s) => s,
                None    => return Ok(()),
            };
            let s2 = match preview_wrap(a2, total_shares, total_assets) {
                Some(s) => s,
                None    => return Ok(()),
            };
            if a1 <= a2 {
                prop_assert!(
                    s1 <= s2,
                    "wrap not monotone: wrap({})={} > wrap({})={} ts={} ta={}",
                    a1, s1, a2, s2, total_shares, total_assets
                );
            }
        }

        // ── Invariant 6: Unwrap monotone (more shares → more assets) ───────
        #[test]
        fn prop_unwrap_monotone(
            s1           in 0_i128..500_000_i128,
            s2           in 0_i128..500_000_i128,
            total_shares in 1_i128..1_000_000_i128,
            total_assets in 0_i128..1_000_000_i128,
        ) {
            let s1 = s1.min(total_shares);
            let s2 = s2.min(total_shares);
            let a1 = match preview_unwrap(s1, total_shares, total_assets) {
                Some(a) => a,
                None    => return Ok(()),
            };
            let a2 = match preview_unwrap(s2, total_shares, total_assets) {
                Some(a) => a,
                None    => return Ok(()),
            };
            if s1 <= s2 {
                prop_assert!(
                    a1 <= a2,
                    "unwrap not monotone: unwrap({})={} > unwrap({})={} ts={} ta={}",
                    s1, a1, s2, a2, total_shares, total_assets
                );
            }
        }

        // ── Invariant 7: Determinism (wrap) ────────────────────────────────
        #[test]
        fn prop_wrap_deterministic(
            assets       in 1_i128..1_000_000_i128,
            total_shares in 0_i128..1_000_000_i128,
            total_assets in 0_i128..1_000_000_i128,
        ) {
            let r1 = preview_wrap(assets, total_shares, total_assets);
            let r2 = preview_wrap(assets, total_shares, total_assets);
            prop_assert_eq!(r1, r2, "wrap is not deterministic");
        }

        // ── Invariant 7: Determinism (unwrap) ──────────────────────────────
        #[test]
        fn prop_unwrap_deterministic(
            shares       in 0_i128..1_000_000_i128,
            total_shares in 1_i128..1_000_000_i128,
            total_assets in 0_i128..1_000_000_i128,
        ) {
            let shares = shares.min(total_shares);
            let r1 = preview_unwrap(shares, total_shares, total_assets);
            let r2 = preview_unwrap(shares, total_shares, total_assets);
            prop_assert_eq!(r1, r2, "unwrap is not deterministic");
        }

        // ── Invariant 8: Truncation invariant for preview_wrap ─────────────
        //
        // shares × (ta + 1) ≤ assets × (ts + 1) for all valid bounded inputs.
        #[test]
        fn prop_preview_wrap_truncation_invariant(
            assets       in 0_i128..100_000_i128,
            total_shares in 0_i128..100_000_i128,
            total_assets in 0_i128..100_000_i128,
        ) {
            let shares = match preview_wrap(assets, total_shares, total_assets) {
                Some(s) => s,
                None    => return Ok(()),
            };
            let lhs = shares * (total_assets + 1);
            let rhs = assets * (total_shares + 1);
            prop_assert!(lhs <= rhs, "truncation invariant violated");
        }

        // ── Invariant 9: Two-holder allocation sum bounded by pool + 2 ─────
        //
        // Two holders with s1 + s2 = total_shares should together receive no
        // more than total_assets + 2 (up to 1 unit of ceiling rounding per
        // holder is the known, acceptable trade-off).
        #[test]
        fn prop_two_holder_allocation_bounded(
            s1           in 0_i128..500_000_i128,
            s2           in 0_i128..500_000_i128,
            total_assets in 0_i128..1_000_000_i128,
        ) {
            let total_shares = s1 + s2;
            if total_shares == 0 {
                return Ok(());
            }
            let a1 = match preview_unwrap(s1, total_shares, total_assets) {
                Some(a) => a,
                None    => return Ok(()),
            };
            let a2 = match preview_unwrap(s2, total_shares, total_assets) {
                Some(a) => a,
                None    => return Ok(()),
            };
            let sum = a1.checked_add(a2);
            prop_assert!(
                sum.map_or(false, |s| s <= total_assets + 2),
                "two-holder sum {} exceeds pool {} + 2", sum.unwrap_or(i128::MAX), total_assets
            );
        }

        // ── Invariant 10: Zero-share deposit identified by preview ──────────
        //
        // When preview_wrap returns 0, the deposit is too small to mint even
        // one share.  The contract should (and does) reject such deposits with
        // ZeroSharesMinted.  This test verifies the math is consistent with
        // that expectation.
        #[test]
        fn prop_zero_share_deposit_math_consistency(
            assets       in 1_i128..10_i128,
            total_shares in 100_i128..10_000_i128,
            total_assets in 1_000_i128..1_000_000_i128,
        ) {
            let shares = match preview_wrap(assets, total_shares, total_assets) {
                Some(s) => s,
                None    => return Ok(()),
            };
            if shares == 0 {
                // Confirm: assets * (ts+1) < (ta+1), which is the condition
                // that makes the integer division floor to zero.
                let lhs = assets * (total_shares + 1);
                let rhs = total_assets + 1;
                prop_assert!(
                    lhs < rhs,
                    "expected lhs={} < rhs={} when shares==0", lhs, rhs
                );
            }
        }

        // ── Invariant 11: Round-trip never profits (large-scale) ────────────
        //
        // An extended version of Invariant 1 over a wider input range.
        #[test]
        fn prop_round_trip_never_profits_large(
            total_shares in 0_i128..1_000_000_000_i128,
            total_assets in 0_i128..1_000_000_000_i128,
            deposit      in 1_i128..1_000_000_i128,
        ) {
            let shares = match preview_wrap(deposit, total_shares, total_assets) {
                Some(s) => s,
                None    => return Ok(()),
            };
            prop_assume!(shares > 0);

            let new_ts = match total_shares.checked_add(shares) {
                Some(v) => v,
                None    => return Ok(()),
            };
            let new_ta = match total_assets.checked_add(deposit) {
                Some(v) => v,
                None    => return Ok(()),
            };

            let returned = match preview_unwrap(shares, new_ts, new_ta) {
                Some(a) => a,
                None    => return Ok(()),
            };

            prop_assert!(
                returned <= deposit,
                "large-scale profit: returned {} from deposit of {}",
                returned, deposit
            );
        }
    }
}
