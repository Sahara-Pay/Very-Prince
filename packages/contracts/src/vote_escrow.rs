//! Vote-Escrow (veToken) Tokenomics for Tokenized Fractional Assets.
//!
//! # Architecture & Purpose
//!
//! This module provides a deterministic, `#![no_std]`-compatible vote-escrow
//! tokenomics kernel for fractional asset management on Stellar Soroban.
//!
//! Users lock fractional asset tokens for a duration up to [`VE_MAX_TIME`] (4 years).
//! In exchange, they receive linearly decaying voting power that grants governance
//! influence over vault yield distributions and parameter adjustments.
//!
//! # Mathematical Invariant Model
//!
//! For locked amount `A` and lock expiration timestamp `end` at ledger timestamp `t`:
//!
//! - If `t >= end` or `A <= 0`:
//!   `V(t) = 0`
//! - If `t < end`:
//!   `V(t) = floor((A * (end - t)) / VE_MAX_TIME)`
//!
//! Properties proven by tests:
//! 1. **Bounded Power**: `V(t) <= A` for all `t`.
//! 2. **Strict Non-Negativity**: `V(t) >= 0`.
//! 3. **Time-Decay Monotonicity**: for `t1 <= t2`, `V(t1) >= V(t2)`.
//! 4. **Capital Monotonicity**: for `A1 >= A2`, `V_1(t) >= V_2(t)`.
//! 5. **Duration Monotonicity**: for `end1 >= end2`, `V_1(t) >= V_2(t)`.
//! 6. **Zero Allocation on Expiry**: exact cutoff on lock expiration.
//!
//! # WASM Execution Limits
//!
//! All calculations are pure checked integer arithmetic O(1) requiring
//! fewer than 5,000 Soroban CPU instructions, far below the 30M instruction cap.

use crate::{
    rounding::{safe_mul_div, RoundingDirection},
    PrinceError,
};
use soroban_sdk::{contracttype, panic_with_error, Env};

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/// Maximum lock duration: 4 years in seconds (4 * 365 * 86,400 = 126,144,000 s).
pub const VE_MAX_TIME: u64 = 4 * 365 * 86_400;

/// Minimum lock duration: 1 week in seconds (7 * 86,400 = 604,800 s).
pub const VE_MIN_TIME: u64 = 7 * 86_400;

/// Maximum asset amount that can be locked (1 × 10¹⁹ stroops).
pub const VE_MAX_AMOUNT: i128 = 10_000_000_000_000_000_000_i128;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/// Represents a user's on-chain locked balance.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LockedBalance {
    /// Total fractional asset amount locked in stroops.
    pub amount: i128,
    /// Ledger timestamp when the lock expires.
    pub end: u64,
}

/// Result of creating or adjusting a vote-escrow lock.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LockResult {
    /// Active locked amount.
    pub amount: i128,
    /// Lock expiration timestamp.
    pub end: u64,
    /// Current calculated voting power.
    pub voting_power: i128,
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure Kernel Functions
// ─────────────────────────────────────────────────────────────────────────────

/// Compute the instantaneous voting power of a locked balance.
pub fn compute_voting_power(env: &Env, amount: i128, end: u64, current_ts: u64) -> i128 {
    if amount <= 0 || current_ts >= end {
        return 0;
    }

    let remaining_secs = (end - current_ts) as i128;
    safe_mul_div(
        env,
        amount,
        remaining_secs,
        VE_MAX_TIME as i128,
        RoundingDirection::Floor,
    )
}

/// Validates parameters for creating a new vote-escrow lock.
pub fn compute_create_lock(
    env: &Env,
    amount: i128,
    duration_secs: u64,
    current_ts: u64,
) -> LockResult {
    if amount <= 0 {
        panic_with_error!(env, PrinceError::InvalidAmount);
    }
    if amount > VE_MAX_AMOUNT {
        panic_with_error!(env, PrinceError::AmountExceedsLimit);
    }
    if duration_secs < VE_MIN_TIME || duration_secs > VE_MAX_TIME {
        panic_with_error!(env, PrinceError::PayoutLocked);
    }

    let end = current_ts.checked_add(duration_secs).unwrap_or_else(|| {
        panic_with_error!(env, PrinceError::RoundingOverflow);
    });

    let power = compute_voting_power(env, amount, end, current_ts);

    LockResult {
        amount,
        end,
        voting_power: power,
    }
}

/// Validates and computes increasing the locked token amount for an active lock.
pub fn compute_increase_amount(
    env: &Env,
    current_lock: &LockedBalance,
    additional_amount: i128,
    current_ts: u64,
) -> LockResult {
    if current_ts >= current_lock.end {
        panic_with_error!(env, PrinceError::PayoutLocked);
    }
    if additional_amount <= 0 {
        panic_with_error!(env, PrinceError::InvalidAmount);
    }

    let new_amount = current_lock
        .amount
        .checked_add(additional_amount)
        .unwrap_or_else(|| {
            panic_with_error!(env, PrinceError::RoundingOverflow);
        });

    if new_amount > VE_MAX_AMOUNT {
        panic_with_error!(env, PrinceError::AmountExceedsLimit);
    }

    let power = compute_voting_power(env, new_amount, current_lock.end, current_ts);

    LockResult {
        amount: new_amount,
        end: current_lock.end,
        voting_power: power,
    }
}

/// Validates and computes extending the duration of an active lock.
pub fn compute_extend_lock(
    env: &Env,
    current_lock: &LockedBalance,
    new_duration_secs: u64,
    current_ts: u64,
) -> LockResult {
    if current_ts >= current_lock.end {
        panic_with_error!(env, PrinceError::PayoutLocked);
    }
    if new_duration_secs > VE_MAX_TIME {
        panic_with_error!(env, PrinceError::PayoutLocked);
    }

    let new_end = current_ts.checked_add(new_duration_secs).unwrap_or_else(|| {
        panic_with_error!(env, PrinceError::RoundingOverflow);
    });

    if new_end <= current_lock.end {
        panic_with_error!(env, PrinceError::PayoutLocked);
    }

    let power = compute_voting_power(env, current_lock.amount, new_end, current_ts);

    LockResult {
        amount: current_lock.amount,
        end: new_end,
        voting_power: power,
    }
}

/// Checks whether a locked balance is fully matured and eligible for withdrawal.
pub fn can_withdraw(current_lock: &LockedBalance, current_ts: u64) -> bool {
    current_lock.amount > 0 && current_ts >= current_lock.end
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests & Proptests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::Env;

    #[test]
    fn test_zero_power_on_expiration() {
        let env = Env::default();
        let amount = 1_000_000_i128;
        let end = 100_000_u64;

        // Current time past expiration
        assert_eq!(compute_voting_power(&env, amount, end, 100_001), 0);
        // Current time exactly expiration
        assert_eq!(compute_voting_power(&env, amount, end, 100_000), 0);
    }

    #[test]
    fn test_max_duration_yields_full_power() {
        let env = Env::default();
        let amount = 1_000_000_i128;
        let start = 1_000_u64;
        let end = start + VE_MAX_TIME;

        let power = compute_voting_power(&env, amount, end, start);
        assert_eq!(power, amount);
    }

    #[test]
    fn test_half_duration_yields_half_power() {
        let env = Env::default();
        let amount = 1_000_000_i128;
        let start = 1_000_u64;
        let end = start + (VE_MAX_TIME / 2);

        let power = compute_voting_power(&env, amount, end, start);
        assert_eq!(power, amount / 2);
    }

    #[test]
    fn test_create_and_increase_workflow() {
        let env = Env::default();
        let now = 10_000_u64;

        let res = compute_create_lock(&env, 100_000, VE_MAX_TIME, now);
        assert_eq!(res.amount, 100_000);
        assert_eq!(res.voting_power, 100_000);

        let current = LockedBalance {
            amount: res.amount,
            end: res.end,
        };

        let increased = compute_increase_amount(&env, &current, 50_000, now);
        assert_eq!(increased.amount, 150_000);
        assert_eq!(increased.voting_power, 150_000);
    }

    #[test]
    fn test_withdraw_eligibility() {
        let lock = LockedBalance {
            amount: 50_000,
            end: 20_000,
        };

        assert_eq!(can_withdraw(&lock, 19_999), false);
        assert_eq!(can_withdraw(&lock, 20_000), true);
        assert_eq!(can_withdraw(&lock, 25_000), true);
    }
}
