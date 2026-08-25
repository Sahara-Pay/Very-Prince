//! Rounding direction protection for on-chain fractional arithmetic.
//!
//! ## Motivation
//!
//! Integer division in Rust (and every other language) truncates toward zero.
//! For unsigned inputs this is equivalent to "floor", but the direction is
//! implicit and invisible at the call site. In financial contracts where the
//! rounding direction is a *security property* — not an implementation detail
//! — silent truncation creates two classes of vulnerability:
//!
//! 1. **Value extraction via repeated micro-operations** — a caller can deposit
//!    and withdraw in a tight loop, exploiting the direction asymmetry between
//!    mint and burn to drain fractional residues from the collateral pool.
//! 2. **Dust accounting drift** — when a pool is distributed across N
//!    recipients, uncounted remainder tokens "disappear" from the ledger
//!    (they remain in the pool account but are never attributed), making
//!    the on-chain accounting non-deterministic across rounds.
//!
//! This module provides:
//! - [`RoundingDirection`] — an explicit, auditable enum for the three
//!   meaningful rounding modes for positive-integer blockchain arithmetic.
//! - [`safe_div`] — checked integer division with explicit direction.
//! - [`safe_mul_div`] — checked fused multiply-then-divide with explicit
//!   direction. Intermediate result uses i128 checked arithmetic to preserve
//!   precision without introducing floating point.
//!
//! ## No-std
//!
//! This module uses no heap allocation and no floating-point operations.
//! It compiles to deterministic, branch-free-where-possible WASM code.
//!
//! ## Rounding Mode Reference
//!
//! | Mode       | Formula                              | Bias          |
//! |------------|--------------------------------------|---------------|
//! | `Floor`    | `⌊n / d⌋` = `n / d` (integer div)   | toward −∞     |
//! | `Ceiling`  | `⌈n / d⌉` = `(n + d − 1) / d`      | toward +∞     |
//! | `Truncate` | `trunc(n / d)` = `n / d` in Rust     | toward zero   |
//!
//! For positive `n` and positive `d` (which is the usual case in token math),
//! `Floor` and `Truncate` are identical. The distinction only matters for
//! negative values, which this contract never intentionally produces but may
//! encounter from adversarial inputs.
//!
//! ## Usage
//!
//! ```rust,ignore
//! // QF allocation: distribute pool proportionally by weight, never over-allocate.
//! let allocation = safe_mul_div(
//!     env,
//!     pool,           // a: matching pool total
//!     project_weight, // b: this project's weight
//!     total_weight,   // d: sum of all weights
//!     RoundingDirection::Floor, // never give out more than the pool holds
//! );
//! ```

use crate::PrinceError;
use soroban_sdk::{panic_with_error, Env};

// ─────────────────────────────────────────────────────────────────────────────
// RoundingDirection
// ─────────────────────────────────────────────────────────────────────────────

/// Explicit rounding direction for integer division.
///
/// This type is the audit trail for every division that touches token amounts.
/// Call sites that pass `RoundingDirection::Floor` are documented as "protocol
/// favored"; sites that pass `Ceiling` are "caller favored". A code review
/// can grep for this type and immediately identify every place where rounding
/// direction was a conscious decision.
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum RoundingDirection {
    /// Round toward negative infinity: `⌊n / d⌋`.
    ///
    /// For positive inputs this is identical to Rust integer division.
    /// For negative numerators it rounds *away* from zero (more negative),
    /// which is the correct behavior for "never give out more than earned".
    ///
    /// Use this when distributing funds — each recipient gets at most their
    /// fair share; the undistributed dust stays in the pool.
    Floor,

    /// Round toward positive infinity: `⌈n / d⌉`.
    ///
    /// For positive inputs: `(n + d − 1) / d`.
    /// For negative numerators it rounds *toward* zero (less negative).
    ///
    /// Use this when computing the collateral required to cover a liability —
    /// the protocol always reserves at least as much as it owes.
    Ceiling,

    /// Round toward zero (Rust's native integer division behavior).
    ///
    /// `Truncate` and `Floor` are identical for positive inputs. Prefer
    /// `Floor` or `Ceiling` with an explanatory comment unless the semantics
    /// are explicitly "truncate toward zero regardless of sign".
    Truncate,
}

// ─────────────────────────────────────────────────────────────────────────────
// safe_div
// ─────────────────────────────────────────────────────────────────────────────

/// Divide `numerator / denominator` with an explicit rounding direction.
///
/// # Panics
/// - `PrinceError::RoundingOverflow` if `denominator == 0`.
/// - `PrinceError::RoundingOverflow` if the ceiling intermediate
///   `numerator + denominator - 1` overflows `i128`.
///
/// # Examples
/// ```rust,ignore
/// // 7 / 2 = 3.5
/// assert_eq!(safe_div(env, 7, 2, Floor),    3);  // ⌊3.5⌋
/// assert_eq!(safe_div(env, 7, 2, Ceiling),  4);  // ⌈3.5⌉
/// assert_eq!(safe_div(env, 7, 2, Truncate), 3);  // trunc(3.5) — same as floor for positives
///
/// // -7 / 2 = -3.5
/// assert_eq!(safe_div(env, -7, 2, Floor),    -4); // ⌊-3.5⌋  — more negative
/// assert_eq!(safe_div(env, -7, 2, Ceiling),  -3); // ⌈-3.5⌉  — less negative
/// assert_eq!(safe_div(env, -7, 2, Truncate), -3); // trunc(-3.5) — toward zero
/// ```
pub fn safe_div(env: &Env, numerator: i128, denominator: i128, direction: RoundingDirection) -> i128 {
    if denominator == 0 {
        panic_with_error!(env, PrinceError::RoundingOverflow);
    }

    match direction {
        // Truncate is native Rust integer division.
        RoundingDirection::Truncate => numerator / denominator,

        // Floor: round toward −∞.
        // For positive/positive: same as Truncate.
        // For negative/positive: Rust truncates toward zero, we need to go one
        // more step toward −∞ when there is a remainder.
        RoundingDirection::Floor => {
            let q = numerator / denominator;
            let r = numerator % denominator;
            // A non-zero remainder and a mismatch of signs means the true
            // quotient is between q and q-1; floor requires q-1.
            if r != 0 && (r < 0) != (denominator < 0) {
                q.checked_sub(1)
                    .unwrap_or_else(|| panic_with_error!(env, PrinceError::RoundingOverflow))
            } else {
                q
            }
        }

        // Ceiling: round toward +∞.
        // For positive/positive: (n + d - 1) / d — but use overflow-safe form.
        // For the general case: ceil(n/d) = -floor(-n/d).
        // We implement it as: q + 1 if there is a remainder AND signs agree.
        RoundingDirection::Ceiling => {
            let q = numerator / denominator;
            let r = numerator % denominator;
            // A non-zero remainder and matching signs means the true quotient
            // lies strictly between q and q+1; ceiling requires q+1.
            if r != 0 && (r < 0) == (denominator < 0) {
                q.checked_add(1)
                    .unwrap_or_else(|| panic_with_error!(env, PrinceError::RoundingOverflow))
            } else {
                q
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// safe_mul_div
// ─────────────────────────────────────────────────────────────────────────────

/// Fused multiply-then-divide: `⌊(a × b) / d⌋` (or ceil/truncate).
///
/// This is the standard token distribution formula. A naïve implementation of
/// `(a * b) / d` in `i64` arithmetic overflows at pool sizes above ~3 billion
/// tokens; in `i128` arithmetic the overflow boundary is ~1.7 × 10³⁸, which
/// safely covers the entire supply of any Stellar asset (max 922 × 10⁹ stroops
/// per asset × 10⁷ assets ≈ 9.2 × 10¹⁸ — well within i128 range).
///
/// # Arguments
/// * `a` — First multiplicand (e.g. pool total).
/// * `b` — Second multiplicand (e.g. project weight).
/// * `d` — Denominator (e.g. total weight).
/// * `direction` — Rounding direction.
///
/// # Panics
/// - `PrinceError::RoundingOverflow` if `a × b` overflows `i128`.
/// - `PrinceError::RoundingOverflow` if `d == 0`.
/// - `PrinceError::RoundingOverflow` if the ceiling adjustment overflows.
///
/// # Example
///
/// Distribute 1000-token pool across two projects with weights 3 and 7:
/// ```rust,ignore
/// let p1 = safe_mul_div(env, 1000, 3, 10, Floor); // 300
/// let p2 = safe_mul_div(env, 1000, 7, 10, Floor); // 700
/// // sum = 1000 — no dust in this case
///
/// let p1 = safe_mul_div(env, 1000, 1, 3, Floor);  // 333
/// let p2 = safe_mul_div(env, 1000, 1, 3, Floor);  // 333
/// let p3 = safe_mul_div(env, 1000, 1, 3, Floor);  // 333
/// // sum = 999 — 1 token dust remains in pool ✓ (never over-allocated)
/// ```
pub fn safe_mul_div(
    env: &Env,
    a: i128,
    b: i128,
    d: i128,
    direction: RoundingDirection,
) -> i128 {
    let numerator = a
        .checked_mul(b)
        .unwrap_or_else(|| panic_with_error!(env, PrinceError::RoundingOverflow));
    safe_div(env, numerator, d, direction)
}

// ─────────────────────────────────────────────────────────────────────────────
// dust_remainder
// ─────────────────────────────────────────────────────────────────────────────

/// Return the unallocated dust after distributing `pool` proportionally by
/// `weight / total_weight` using floor rounding across N projects.
///
/// Because each allocation is floored, the sum of all allocations is ≤ pool.
/// The difference is "dust" — fractional tokens that are indivisible and must
/// remain in the pool rather than being silently lost from accounting.
///
/// This is a pure helper for callers that want to explicitly track the dust
/// rather than computing it themselves.
///
/// ```rust,ignore
/// let allocation = safe_mul_div(env, pool, weight, total_weight, Floor);
/// let remaining  = dust_remainder(env, pool, distributed_so_far);
/// ```
pub fn dust_remainder(env: &Env, pool: i128, distributed_total: i128) -> i128 {
    pool.checked_sub(distributed_total)
        .unwrap_or_else(|| panic_with_error!(env, PrinceError::RoundingOverflow))
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::Env;

    // ── safe_div unit tests ───────────────────────────────────────────────────

    #[test]
    fn floor_exact_division() {
        let env = Env::default();
        // 6 / 2 = 3.0 — no remainder; all modes agree.
        assert_eq!(safe_div(&env, 6, 2, RoundingDirection::Floor), 3);
        assert_eq!(safe_div(&env, 6, 2, RoundingDirection::Ceiling), 3);
        assert_eq!(safe_div(&env, 6, 2, RoundingDirection::Truncate), 3);
    }

    #[test]
    fn floor_positive_remainder() {
        let env = Env::default();
        // 7 / 2 = 3.5
        assert_eq!(safe_div(&env, 7, 2, RoundingDirection::Floor), 3);    // ⌊3.5⌋
        assert_eq!(safe_div(&env, 7, 2, RoundingDirection::Ceiling), 4);  // ⌈3.5⌉
        assert_eq!(safe_div(&env, 7, 2, RoundingDirection::Truncate), 3); // trunc
    }

    #[test]
    fn floor_negative_numerator() {
        let env = Env::default();
        // -7 / 2 = -3.5
        assert_eq!(safe_div(&env, -7, 2, RoundingDirection::Floor), -4);    // ⌊-3.5⌋ = -4
        assert_eq!(safe_div(&env, -7, 2, RoundingDirection::Ceiling), -3);  // ⌈-3.5⌉ = -3
        assert_eq!(safe_div(&env, -7, 2, RoundingDirection::Truncate), -3); // trunc(-3.5) = -3
    }

    #[test]
    fn floor_negative_denominator() {
        let env = Env::default();
        // 7 / -2 = -3.5
        assert_eq!(safe_div(&env, 7, -2, RoundingDirection::Floor), -4);    // ⌊-3.5⌋ = -4
        assert_eq!(safe_div(&env, 7, -2, RoundingDirection::Ceiling), -3);  // ⌈-3.5⌉ = -3
        assert_eq!(safe_div(&env, 7, -2, RoundingDirection::Truncate), -3); // trunc = -3
    }

    #[test]
    fn floor_both_negative() {
        let env = Env::default();
        // -7 / -2 = 3.5
        assert_eq!(safe_div(&env, -7, -2, RoundingDirection::Floor), 3);    // ⌊3.5⌋ = 3
        assert_eq!(safe_div(&env, -7, -2, RoundingDirection::Ceiling), 4);  // ⌈3.5⌉ = 4
        assert_eq!(safe_div(&env, -7, -2, RoundingDirection::Truncate), 3); // trunc = 3
    }

    #[test]
    fn zero_numerator() {
        let env = Env::default();
        assert_eq!(safe_div(&env, 0, 7, RoundingDirection::Floor), 0);
        assert_eq!(safe_div(&env, 0, 7, RoundingDirection::Ceiling), 0);
        assert_eq!(safe_div(&env, 0, 7, RoundingDirection::Truncate), 0);
    }

    #[test]
    fn one_over_large_denominator_floor() {
        let env = Env::default();
        // 1 / 1_000_000 = 0 (floor) and 1 (ceiling)
        assert_eq!(safe_div(&env, 1, 1_000_000, RoundingDirection::Floor), 0);
        assert_eq!(safe_div(&env, 1, 1_000_000, RoundingDirection::Ceiling), 1);
    }

    #[test]
    fn safe_div_denominator_one() {
        let env = Env::default();
        // n / 1 always equals n for all directions.
        for n in [-100_i128, -1, 0, 1, 100, i128::MAX - 1] {
            assert_eq!(safe_div(&env, n, 1, RoundingDirection::Floor), n);
            assert_eq!(safe_div(&env, n, 1, RoundingDirection::Ceiling), n);
            assert_eq!(safe_div(&env, n, 1, RoundingDirection::Truncate), n);
        }
    }

    // ── safe_mul_div unit tests ───────────────────────────────────────────────

    #[test]
    fn mul_div_proportional_distribution_no_dust() {
        let env = Env::default();
        // Pool = 1000, weights = 3 and 7, total = 10 → clean split.
        let p1 = safe_mul_div(&env, 1000, 3, 10, RoundingDirection::Floor);
        let p2 = safe_mul_div(&env, 1000, 7, 10, RoundingDirection::Floor);
        assert_eq!(p1, 300);
        assert_eq!(p2, 700);
        assert_eq!(p1 + p2, 1000);
    }

    #[test]
    fn mul_div_dust_stays_in_pool_floor() {
        let env = Env::default();
        // Pool = 1000, three equal weights of 1/3 each.
        // Each allocation floors to 333; sum = 999; 1 token dust stays.
        let a = safe_mul_div(&env, 1000, 1, 3, RoundingDirection::Floor);
        let b = safe_mul_div(&env, 1000, 1, 3, RoundingDirection::Floor);
        let c = safe_mul_div(&env, 1000, 1, 3, RoundingDirection::Floor);
        assert_eq!(a, 333);
        assert_eq!(b, 333);
        assert_eq!(c, 333);
        assert!(a + b + c <= 1000, "floor allocations must never exceed pool");
        assert_eq!(dust_remainder(&Env::default(), 1000, a + b + c), 1);
    }

    #[test]
    fn mul_div_ceiling_never_underestimates() {
        let env = Env::default();
        // 1000 / 3 = 333.33… → ceiling rounds to 334.
        let ceil = safe_mul_div(&env, 1000, 1, 3, RoundingDirection::Ceiling);
        let floor = safe_mul_div(&env, 1000, 1, 3, RoundingDirection::Floor);
        assert!(ceil >= floor, "ceiling must never be below floor");
        assert_eq!(ceil, 334);
    }

    #[test]
    fn mul_div_large_pool_no_overflow() {
        let env = Env::default();
        // Use values near Stellar's practical maximums.
        // Total Stellar supply = ~50 billion XLM = 500_000_000_000_000_000 stroops (5e17).
        let pool = 500_000_000_000_000_000_i128;
        let weight = 999_999_i128;
        let total = 1_000_000_i128;
        // Should not overflow: 5e17 * 999_999 ≈ 5e23 — fits in i128 (max ~1.7e38).
        let alloc = safe_mul_div(&env, pool, weight, total, RoundingDirection::Floor);
        assert!(alloc < pool, "allocation cannot exceed pool");
        assert!(alloc > 0, "non-zero weight should yield non-zero allocation");
    }

    #[test]
    fn dust_remainder_exact() {
        let env = Env::default();
        // Total pool 100, distributed 99 → 1 dust.
        assert_eq!(dust_remainder(&env, 100, 99), 1);
        // Exact distribution → 0 dust.
        assert_eq!(dust_remainder(&env, 100, 100), 0);
    }

    // ── Proptest fuzz suites ─────────────────────────────────────────────────
    //
    // These property tests encode the mathematical invariants that must hold
    // for *all* valid inputs. They are the acceptance criteria for the
    // rounding direction protection module.

    proptest::proptest! {
        #![proptest_config(proptest::prelude::ProptestConfig::with_cases(2000))]

        // ── Invariant 1: Floor never exceeds the exact (rational) value ───────
        //
        // ⌊n/d⌋ ≤ n/d  ⟺  floor * d ≤ n  (for positive d)
        #[test]
        fn prop_floor_never_exceeds_exact(
            n in 0_i128..1_000_000_000_i128,
            d in 1_i128..1_000_000_i128,
        ) {
            let env = Env::default();
            let floor = safe_div(&env, n, d, RoundingDirection::Floor);
            // floor * d must not exceed n (the numerator).
            proptest::prop_assert!(
                floor.checked_mul(d).map_or(false, |v| v <= n),
                "floor({n}/{d}) = {floor} but {floor} * {d} > {n}"
            );
        }

        // ── Invariant 2: Ceiling never undercounts ────────────────────────────
        //
        // ⌈n/d⌉ ≥ n/d  ⟺  ceil * d ≥ n  (for positive d)
        #[test]
        fn prop_ceiling_never_undercounts(
            n in 0_i128..1_000_000_000_i128,
            d in 1_i128..1_000_000_i128,
        ) {
            let env = Env::default();
            let ceil = safe_div(&env, n, d, RoundingDirection::Ceiling);
            proptest::prop_assert!(
                ceil.checked_mul(d).map_or(true, |v| v >= n),
                "ceil({n}/{d}) = {ceil} but {ceil} * {d} < {n}"
            );
        }

        // ── Invariant 3: Floor ≤ Truncate ≤ Ceiling (for positive inputs) ─────
        //
        // For n ≥ 0 and d > 0, all three modes must bracket correctly.
        #[test]
        fn prop_floor_le_truncate_le_ceiling_positive(
            n in 0_i128..1_000_000_000_i128,
            d in 1_i128..1_000_000_i128,
        ) {
            let env = Env::default();
            let floor = safe_div(&env, n, d, RoundingDirection::Floor);
            let trunc = safe_div(&env, n, d, RoundingDirection::Truncate);
            let ceil  = safe_div(&env, n, d, RoundingDirection::Ceiling);
            proptest::prop_assert!(floor <= trunc, "floor > truncate for n={n}, d={d}");
            proptest::prop_assert!(trunc <= ceil,  "truncate > ceiling for n={n}, d={d}");
        }

        // ── Invariant 4: Exact division ⟹ all modes agree ────────────────────
        #[test]
        fn prop_exact_division_all_modes_agree(
            q in 0_i128..1_000_000_i128,
            d in 1_i128..1_000_000_i128,
        ) {
            let env = Env::default();
            let n = q * d; // n is exactly divisible by d
            let floor = safe_div(&env, n, d, RoundingDirection::Floor);
            let ceil  = safe_div(&env, n, d, RoundingDirection::Ceiling);
            let trunc = safe_div(&env, n, d, RoundingDirection::Truncate);
            proptest::prop_assert_eq!(floor, q, "floor should equal q for exact division");
            proptest::prop_assert_eq!(ceil,  q, "ceiling should equal q for exact division");
            proptest::prop_assert_eq!(trunc, q, "truncate should equal q for exact division");
        }

        // ── Invariant 5: Floor ≤ Ceiling ≤ Floor + 1 (gap is at most 1) ──────
        //
        // For any division, ceiling and floor differ by at most 1.
        #[test]
        fn prop_ceiling_floor_gap_at_most_one(
            n in -1_000_000_000_i128..1_000_000_000_i128,
            d in 1_i128..1_000_000_i128,
        ) {
            let env = Env::default();
            let floor = safe_div(&env, n, d, RoundingDirection::Floor);
            let ceil  = safe_div(&env, n, d, RoundingDirection::Ceiling);
            proptest::prop_assert!(
                ceil - floor <= 1,
                "ceiling - floor = {} for n={n}, d={d} — gap must be ≤ 1",
                ceil - floor
            );
            proptest::prop_assert!(ceil >= floor, "ceiling < floor for n={n}, d={d}");
        }

        // ── Invariant 6: safe_mul_div floor never over-allocates ──────────────
        //
        // For any positive pool, weight, and total_weight, the floored
        // allocation must not exceed the theoretical fair share.
        #[test]
        fn prop_mul_div_floor_no_over_allocation(
            pool    in 0_i128..1_000_000_000_i128,
            weight  in 0_i128..1_000_000_i128,
            total_w in 1_i128..1_000_000_i128,
        ) {
            let env = Env::default();
            let weight = weight.min(total_w); // weight never exceeds total
            let alloc = safe_mul_div(&env, pool, weight, total_w, RoundingDirection::Floor);
            // Floored allocation must not exceed pool.
            proptest::prop_assert!(alloc <= pool, "alloc {alloc} > pool {pool}");
            proptest::prop_assert!(alloc >= 0, "allocation must be non-negative");
        }

        // ── Invariant 7: Sum of floored allocations never exceeds pool ────────
        //
        // Simulates distributing a pool across up to 8 projects with random
        // weights; total distributed must never exceed the pool.
        #[test]
        fn prop_sum_of_floor_allocations_le_pool(
            pool in 1_i128..1_000_000_000_i128,
            w0 in 0_i128..100_i128,
            w1 in 0_i128..100_i128,
            w2 in 0_i128..100_i128,
            w3 in 0_i128..100_i128,
            w4 in 0_i128..100_i128,
        ) {
            let env = Env::default();
            let weights = [w0, w1, w2, w3, w4];
            let total_w: i128 = weights.iter().sum();
            if total_w == 0 {
                return Ok(()); // skip degenerate case; tested separately
            }

            let mut distributed: i128 = 0;
            for &w in &weights {
                let a = safe_mul_div(&env, pool, w, total_w, RoundingDirection::Floor);
                distributed = distributed.checked_add(a).expect("sum overflow in test");
            }

            proptest::prop_assert!(
                distributed <= pool,
                "distributed {distributed} > pool {pool}"
            );

            // Dust must be non-negative and bounded.
            let dust = dust_remainder(&env, pool, distributed);
            proptest::prop_assert!(dust >= 0);
            proptest::prop_assert!(dust < (weights.len() as i128));
        }

        // ── Invariant 8: Monotonicity — larger numerator ⟹ larger result ─────
        //
        // For a fixed positive denominator, safe_div must be monotone.
        #[test]
        fn prop_floor_monotone_in_numerator(
            n1 in 0_i128..500_000_000_i128,
            n2 in 0_i128..500_000_000_i128,
            d  in 1_i128..1_000_000_i128,
        ) {
            let env = Env::default();
            let (lo, hi) = if n1 <= n2 { (n1, n2) } else { (n2, n1) };
            let r_lo = safe_div(&env, lo, d, RoundingDirection::Floor);
            let r_hi = safe_div(&env, hi, d, RoundingDirection::Floor);
            proptest::prop_assert!(r_lo <= r_hi, "floor not monotone: f({lo}/{d})={r_lo} > f({hi}/{d})={r_hi}");
        }

        // ── Invariant 9: No panic on non-zero denominator (any i128 values) ───
        //
        // The function must never abort the Soroban VM for valid (non-zero-d)
        // inputs, even for extreme i128 values. This ensures no hidden panic
        // path can be triggered by adversarial inputs.
        #[test]
        fn prop_safe_div_no_panic_nonzero_denominator(
            n in proptest::num::i128::ANY,
            d in 1_i128..=i128::MAX, // d > 0
        ) {
            let env = Env::default();
            // This must not panic; result value is ignored.
            let _ = safe_div(&env, n, d, RoundingDirection::Floor);
            let _ = safe_div(&env, n, d, RoundingDirection::Ceiling);
            let _ = safe_div(&env, n, d, RoundingDirection::Truncate);
        }

        // ── Invariant 10: safe_mul_div commutativity of a and b ───────────────
        //
        // a × b / d == b × a / d (multiplication is commutative).
        #[test]
        fn prop_mul_div_commutative(
            a in 0_i128..1_000_000_i128,
            b in 0_i128..1_000_000_i128,
            d in 1_i128..1_000_000_i128,
        ) {
            let env = Env::default();
            let r_ab = safe_mul_div(&env, a, b, d, RoundingDirection::Floor);
            let r_ba = safe_mul_div(&env, b, a, d, RoundingDirection::Floor);
            proptest::prop_assert_eq!(r_ab, r_ba, "mul_div not commutative for a={}, b={}, d={}", a, b, d);
        }

        // ── Invariant 11: Dust is always < number of projects ─────────────────
        //
        // When distributing pool / N (equal weights), each floor rounding can
        // lose at most 1 stroop, so total dust < N. This bounds the "slippage"
        // of the distribution algorithm.
        #[test]
        fn prop_dust_bounded_by_project_count(
            pool in 1_i128..1_000_000_000_i128,
            n_projects in 1_usize..=32_usize,
        ) {
            let env = Env::default();
            let n = n_projects as i128;
            let mut distributed: i128 = 0;
            for _ in 0..n_projects {
                let a = safe_mul_div(&env, pool, 1, n, RoundingDirection::Floor);
                distributed = distributed.checked_add(a).expect("overflow");
            }
            let dust = dust_remainder(&env, pool, distributed);
            proptest::prop_assert!(dust >= 0);
            proptest::prop_assert!(
                dust < n,
                "dust {dust} >= n_projects {n} — each project can contribute at most 1 stroop of dust"
            );
        }
    }
}
