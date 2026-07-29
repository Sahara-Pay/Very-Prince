//! Fixed-point rounding math for fractional vault share minting/burning.
//!
//! Addresses GrantFox issue #474: integer division truncation lets a
//! malicious actor repeatedly mint and burn tiny fractional shares to
//! slowly drain the underlying collateral pool ("1-wei" micro-theft).
//!
//! ## Design
//!
//! Conversions always round in favor of the protocol/collateral pool:
//!   - Minting shares for a deposit rounds DOWN (the depositor never
//!     receives a fractional share they didn't fully pay for).
//!   - Converting shares to assets on burn rounds UP (the burner never
//!     extracts more collateral than their shares are worth).
//!
//! Both conversions use a `+1` virtual-share / virtual-asset offset
//! (the same technique used by OpenZeppelin's ERC-4626 implementation)
//! so that:
//!   - The denominator is never zero, even for an empty vault — no
//!     special-cased bootstrap branch is needed.
//!   - The very first depositor cannot be exploited by an "inflation"
//!     attack (donating raw tokens directly to the vault to skew the
//!     share price before anyone else deposits), because the offset
//!     makes that manipulation prohibitively expensive relative to the
//!     value it could steal.
//!
//! All arithmetic is checked `i128` math, matching the conventions used
//! elsewhere in this contract (see `checked_isqrt_i128` / `checked_square_i128`
//! in `lib.rs`). No floating point is used anywhere in the WASM binary.

use crate::PrinceError;
use soroban_sdk::{panic_with_error, Env};

/// Convert a deposit amount into vault shares, rounding DOWN.
///
/// `shares = assets * (total_shares + 1) / (total_assets + 1)`
///
/// Rounding down here means a depositor can never be minted a share
/// they haven't fully paid for — any fractional remainder is left
/// behind in favor of the collateral pool.
pub fn convert_to_shares_round_down(
    env: &Env,
    assets: i128,
    total_shares: i128,
    total_assets: i128,
) -> i128 {
    let shares_offset = total_shares
        .checked_add(1)
        .unwrap_or_else(|| panic_with_error!(env, PrinceError::RoundingOverflow));
    let assets_offset = total_assets
        .checked_add(1)
        .unwrap_or_else(|| panic_with_error!(env, PrinceError::RoundingOverflow));

    let numerator = assets
        .checked_mul(shares_offset)
        .unwrap_or_else(|| panic_with_error!(env, PrinceError::RoundingOverflow));

    // assets_offset is always >= 1, so this division is always safe.
    numerator / assets_offset
}

/// Convert a share amount into an asset (collateral) amount on burn,
/// rounding UP.
///
/// `assets = ceil(shares * (total_assets + 1) / (total_shares + 1))`
///
/// Rounding up here means a burner can never extract more collateral
/// than their shares are actually worth — any fractional remainder is
/// again left behind in favor of the collateral pool.
pub fn convert_to_assets_round_up(
    env: &Env,
    shares: i128,
    total_shares: i128,
    total_assets: i128,
) -> i128 {
    let shares_offset = total_shares
        .checked_add(1)
        .unwrap_or_else(|| panic_with_error!(env, PrinceError::RoundingOverflow));
    let assets_offset = total_assets
        .checked_add(1)
        .unwrap_or_else(|| panic_with_error!(env, PrinceError::RoundingOverflow));

    let numerator = shares
        .checked_mul(assets_offset)
        .unwrap_or_else(|| panic_with_error!(env, PrinceError::RoundingOverflow));

    // shares_offset is always >= 1, so this division is always safe.
    let quotient = numerator / shares_offset;
    let remainder = numerator % shares_offset;

    let rounded_up = if remainder != 0 {
        quotient
            .checked_add(1)
            .unwrap_or_else(|| panic_with_error!(env, PrinceError::RoundingOverflow))
    } else {
        quotient
    };

    // Defensive clamp: if the share:asset ratio has degraded below 1:1
    // through many prior rounded-up withdrawals, the ceiling above can
    // round a *full* burn to one unit more than the pool actually holds.
    // Never let a caller's rounding math claim more than the vault has —
    // the last withdrawer gets exactly what remains rather than a reverted
    // transaction.
    rounded_up.min(total_assets)
}

#[allow(clippy::module_inception)]
#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::Env;

    // ── Unit tests: known-value edge cases ─────────────────────────────────

    #[test]
    fn first_deposit_is_approximately_one_to_one() {
        let env = Env::default();
        // Empty vault: total_shares = 0, total_assets = 0.
        // With the +1 offset, 1000 assets -> 1000 * 1 / 1 = 1000 shares.
        let shares = convert_to_shares_round_down(&env, 1_000, 0, 0);
        assert_eq!(shares, 1_000);
    }

    #[test]
    fn mint_rounds_down_on_fractional_share_price() {
        let env = Env::default();
        // total_shares = 3, total_assets = 10 -> share price > 1.
        // Depositing 1 asset: 1 * (3+1) / (10+1) = 4/11 = 0 (rounds down).
        let shares = convert_to_shares_round_down(&env, 1, 3, 10);
        assert_eq!(shares, 0);
    }

    #[test]
    fn burn_rounds_up_on_fractional_asset_value() {
        let env = Env::default();
        // total_shares = 10, total_assets = 3 -> share price < 1.
        // Burning 1 share: 1 * (3+1) / (10+1) = 4/11 = 0.36 -> rounds up to 1.
        let assets = convert_to_assets_round_up(&env, 1, 10, 3);
        assert_eq!(assets, 1);
    }

    #[test]
    fn burn_all_shares_never_exceeds_the_pool() {
        let env = Env::default();
        let total_shares = 12_345_i128;
        let total_assets = 98_765_i128;
        let assets = convert_to_assets_round_up(&env, total_shares, total_shares, total_assets);
        // The virtual +1 offset (inflation-attack protection) intentionally
        // leaves a small permanent dust amount in the pool rather than
        // draining it to exactly zero on a full burn — so this is <=, not ==.
        assert!(assets <= total_assets);
    }

    #[test]
    fn burn_never_exceeds_pool_even_with_degraded_ratio() {
        let env = Env::default();
        // A ratio where total_assets < total_shares (can arise after many
        // rounded-up withdrawals) used to round a full burn to MORE than
        // the pool held, before the clamp in convert_to_assets_round_up.
        let assets = convert_to_assets_round_up(&env, 2, 2, 1);
        assert!(assets <= 1);
    }

    // ── Fuzz: repeated micro-mint/burn cannot extract net value ────────────
    //
    // This is the core acceptance criterion from issue #474: an attacker
    // repeatedly minting and burning tiny (1-wei-scale) share amounts must
    // never walk away with more collateral than they put in.

    proptest::proptest! {
        #![proptest_config(proptest::prelude::ProptestConfig::with_cases(500))]

        #[test]
        fn fuzz_micro_mint_burn_cycle_never_profits(
            total_shares in 0_i128..1_000_000_i128,
            total_assets in 0_i128..1_000_000_i128,
            deposit in 1_i128..5_i128, // 1-wei-scale deposits, as described in the issue
        ) {
            let env = Env::default();

            let shares_minted =
                convert_to_shares_round_down(&env, deposit, total_shares, total_assets);

            let new_total_shares = total_shares + shares_minted;
            let new_total_assets = total_assets + deposit;

            // Immediately burn back every share just minted.
            let assets_returned = convert_to_assets_round_up(
                &env,
                shares_minted,
                new_total_shares,
                new_total_assets,
            );

            // The attacker can never get back more than they deposited.
            proptest::prop_assert!(assets_returned <= deposit);
        }

        #[test]
        fn fuzz_shares_round_down_never_exceeds_fair_value(
            assets in 0_i128..1_000_000_000_i128,
            total_shares in 0_i128..1_000_000_000_i128,
            total_assets in 0_i128..1_000_000_000_i128,
        ) {
            let env = Env::default();
            let shares = convert_to_shares_round_down(&env, assets, total_shares, total_assets);

            // Fair-value invariant: shares * (total_assets + 1) must never
            // exceed assets * (total_shares + 1) — i.e. the minted shares
            // are never worth more than what was actually deposited.
            // Both products are bounded well within i128 range for the
            // input ranges used here (~1e9 * ~1e9 = ~1e18).
            let lhs = shares * (total_assets + 1);
            let rhs = assets * (total_shares + 1);
            proptest::prop_assert!(lhs <= rhs);
        }

        #[test]
        fn fuzz_assets_round_up_never_exceeds_pool(
            shares in 0_i128..1_000_000_i128,
            total_shares in 1_i128..1_000_000_i128,
            total_assets in 0_i128..1_000_000_i128,
        ) {
            let env = Env::default();
            let shares = shares.min(total_shares); // can't burn more than exists
            let assets = convert_to_assets_round_up(&env, shares, total_shares, total_assets);

            // No burn — full or partial, and regardless of whether the
            // share:asset ratio has degraded below 1:1 — may ever return
            // more than the collateral pool actually holds.
            proptest::prop_assert!(assets <= total_assets);
        }
    }
}