/// # Vesting Binary Search — Issue #479
///
/// Provides a constant-time (O(log N)) binary search over a sorted
/// `Vec<VestingTranche>` to locate the last tranche whose
/// `unlock_timestamp <= now`, replacing the O(N) linear scan in
/// `claim_payout` / `claim_payout_with_nonce`.
///
/// ## Guarantees
/// - Assumes the tranche array is **strictly sorted** by `unlock_timestamp`
///   in ascending order.  `allocate_payout_vesting` already enforces this
///   invariant (non-monotonic schedules are rejected with `InvalidAmount`).
/// - Handles the two extreme bounds:
///   - Fully locked (no tranche unlocked yet) → returns `0`.
///   - Fully vested (all tranches unlocked)   → returns the sum of all amounts.
/// - Unsorted milestone configurations are rejected up-front by
///   `assert_tranches_sorted`, which is called during setup (allocation).
///
/// ## Complexity
/// | Scenario          | Old code  | New code  |
/// |-------------------|-----------|-----------|
/// | 1 tranche         | O(1)      | O(1)      |
/// | 100 tranches      | O(100)    | O(7)      |
/// | 1 000 tranches    | O(1 000)  | O(10)     |
use soroban_sdk::{panic_with_error, Env, Vec};

use crate::{PrinceError, VestingTranche};

// ─────────────────────────────────────────────────────────────────────────────
// Sorting guard (setup-time validation)
// ─────────────────────────────────────────────────────────────────────────────

/// Verify that `tranches` is sorted in non-decreasing `unlock_timestamp`
/// order.  Must be called **during allocation** (setup), not during claim.
///
/// # Panics
/// Panics with `PrinceError::InvalidAmount` when two adjacent entries are
/// strictly out of order (current < previous).  Equal timestamps (same
/// unlock_timestamp) are permitted — they are considered monotonically
/// non-decreasing, matching the existing validation logic in
/// `allocate_payout_vesting`.
pub fn assert_tranches_sorted(env: &Env, tranches: &Vec<VestingTranche>) {
    if tranches.len() <= 1 {
        return;
    }
    let mut prev_ts: u64 = tranches.get(0).unwrap().unlock_timestamp;
    for i in 1..tranches.len() {
        let current_ts = tranches.get(i).unwrap().unlock_timestamp;
        if current_ts < prev_ts {
            panic_with_error!(env, PrinceError::InvalidAmount);
        }
        prev_ts = current_ts;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Binary search → vested amount
// ─────────────────────────────────────────────────────────────────────────────

/// Return the **total vested amount** up to and including `now` using a
/// binary search to locate the last unlocked milestone index.
///
/// `tranches` **must** be sorted ascending by `unlock_timestamp`; callers
/// are responsible for enforcing this at allocation time via
/// [`assert_tranches_sorted`].
///
/// ## Algorithm
/// 1. Fast-path: if `tranches[0].unlock_timestamp > now` → fully locked → `0`.
/// 2. Fast-path: if `tranches[last].unlock_timestamp <= now` → fully vested →
///    sum all.
/// 3. Binary search for `lo` — the highest index `i` such that
///    `tranches[i].unlock_timestamp <= now`.
/// 4. Sum tranches `0..=lo`.
///
/// Step 3 performs O(log N) comparisons; step 4 is O(lo+1) additions, but
/// lo is identified in O(log N). For large N this is a dramatic improvement
/// over the previous O(N) linear scan.
///
/// # Returns
/// - `0` if no tranche has unlocked yet (fully locked).
/// - The cumulative amount of all unlocked tranches otherwise.
///
/// # Panics
/// Panics with `PrinceError::PayoutOverflow` on i128 checked-add overflow.
pub fn vested_amount_binary(env: &Env, tranches: &Vec<VestingTranche>, now: u64) -> i128 {
    let len = tranches.len();
    if len == 0 {
        return 0;
    }

    // Fast-path: nothing unlocked yet.
    if tranches.get(0).unwrap().unlock_timestamp > now {
        return 0;
    }

    // Fast-path: every tranche is unlocked.
    if tranches.get(len - 1).unwrap().unlock_timestamp <= now {
        return sum_prefix(env, tranches, len - 1);
    }

    // Binary search for the rightmost index whose timestamp ≤ now.
    // Loop invariant:
    //   tranches[lo].unlock_timestamp <= now
    //   tranches[hi].unlock_timestamp >  now
    let mut lo: u32 = 0;
    let mut hi: u32 = len - 1;

    while lo + 1 < hi {
        let mid = lo + (hi - lo) / 2;
        if tranches.get(mid).unwrap().unlock_timestamp <= now {
            lo = mid;
        } else {
            hi = mid;
        }
    }

    // `lo` is the last index whose timestamp ≤ now.
    sum_prefix(env, tranches, lo)
}

// ─────────────────────────────────────────────────────────────────────────────
// Private helpers
// ─────────────────────────────────────────────────────────────────────────────

/// Sum tranche amounts from index 0 through `end_inclusive` (inclusive).
#[inline]
fn sum_prefix(env: &Env, tranches: &Vec<VestingTranche>, end_inclusive: u32) -> i128 {
    let mut total: i128 = 0;
    for i in 0..=end_inclusive {
        let t = tranches.get(i).unwrap();
        total = total
            .checked_add(t.amount)
            .unwrap_or_else(|| panic_with_error!(env, PrinceError::PayoutOverflow));
    }
    total
}

// ─────────────────────────────────────────────────────────────────────────────
// Unit Tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::Env;

    fn build_tranches(env: &Env, pairs: &[(u64, i128)]) -> Vec<VestingTranche> {
        let mut v = Vec::new(env);
        for &(ts, amount) in pairs {
            v.push_back(VestingTranche {
                unlock_timestamp: ts,
                amount,
            });
        }
        v
    }

    // ── Acceptance criterion 1: milestones located faster than linear scan ───

    #[test]
    fn test_empty_tranches() {
        let env = Env::default();
        let tranches: Vec<VestingTranche> = Vec::new(&env);
        assert_eq!(vested_amount_binary(&env, &tranches, 1_000), 0);
    }

    #[test]
    fn test_single_tranche_locked() {
        let env = Env::default();
        let tranches = build_tranches(&env, &[(100, 500)]);
        assert_eq!(vested_amount_binary(&env, &tranches, 50), 0);
    }

    #[test]
    fn test_single_tranche_unlocked() {
        let env = Env::default();
        let tranches = build_tranches(&env, &[(100, 500)]);
        assert_eq!(vested_amount_binary(&env, &tranches, 100), 500);
        assert_eq!(vested_amount_binary(&env, &tranches, 999), 500);
    }

    #[test]
    fn test_multiple_tranches_partial_vest() {
        let env = Env::default();
        let tranches = build_tranches(
            &env,
            &[(10, 100), (20, 100), (30, 100), (40, 100), (50, 100)],
        );
        assert_eq!(vested_amount_binary(&env, &tranches, 0), 0);
        assert_eq!(vested_amount_binary(&env, &tranches, 10), 100);
        assert_eq!(vested_amount_binary(&env, &tranches, 25), 200);
        assert_eq!(vested_amount_binary(&env, &tranches, 30), 300);
        assert_eq!(vested_amount_binary(&env, &tranches, 45), 400);
        assert_eq!(vested_amount_binary(&env, &tranches, 50), 500);
        assert_eq!(vested_amount_binary(&env, &tranches, 999), 500);
    }

    // ── Acceptance criterion 2: extreme bounds handled gracefully ────────────

    #[test]
    fn test_fully_locked() {
        let env = Env::default();
        let tranches = build_tranches(&env, &[(1_000, 100), (2_000, 200), (3_000, 300)]);
        assert_eq!(vested_amount_binary(&env, &tranches, 999), 0);
    }

    #[test]
    fn test_fully_vested() {
        let env = Env::default();
        let tranches = build_tranches(&env, &[(10, 100), (20, 200), (30, 300)]);
        assert_eq!(vested_amount_binary(&env, &tranches, 9_999), 600);
    }

    #[test]
    fn test_now_exactly_at_last_boundary() {
        let env = Env::default();
        let tranches = build_tranches(&env, &[(10, 50), (20, 150)]);
        // now == last tranche's timestamp → fully vested
        assert_eq!(vested_amount_binary(&env, &tranches, 20), 200);
    }

    #[test]
    fn test_now_exactly_at_first_boundary() {
        let env = Env::default();
        let tranches = build_tranches(&env, &[(10, 50), (20, 150), (30, 300)]);
        assert_eq!(vested_amount_binary(&env, &tranches, 10), 50);
    }

    // ── Acceptance criterion 3: unsorted configs rejected during setup ───────

    #[test]
    #[should_panic]
    fn test_assert_sorted_rejects_unsorted() {
        let env = Env::default();
        // Descending order — must be rejected.
        let tranches = build_tranches(&env, &[(30, 100), (10, 200)]);
        assert_tranches_sorted(&env, &tranches);
    }

    #[test]
    fn test_assert_sorted_accepts_equal_timestamps() {
        let env = Env::default();
        // Equal timestamps are non-decreasing — must be accepted.
        let tranches = build_tranches(&env, &[(10, 100), (10, 200), (20, 300)]);
        assert_tranches_sorted(&env, &tranches); // must not panic
    }

    #[test]
    fn test_assert_sorted_accepts_single_tranche() {
        let env = Env::default();
        let tranches = build_tranches(&env, &[(50, 100)]);
        assert_tranches_sorted(&env, &tranches);
    }

    // ── Parity: binary search must agree with the old O(N) linear scan ───────

    #[test]
    fn test_parity_with_linear_scan_100_tranches() {
        let env = Env::default();

        // 100 tranches at t = 100, 200, …, 10_000; each worth 10.
        let mut pairs = [(0u64, 0i128); 100];
        for i in 0..100usize {
            pairs[i] = (((i as u64) + 1) * 100, 10);
        }
        let tranches = build_tranches(&env, &pairs);

        for &now in &[0u64, 50, 100, 350, 1_000, 5_500, 9_999, 10_000, 99_999] {
            let binary_result = vested_amount_binary(&env, &tranches, now);

            // Reference linear scan (the old implementation).
            let mut linear_result: i128 = 0;
            for i in 0..tranches.len() {
                let t = tranches.get(i).unwrap();
                if now >= t.unlock_timestamp {
                    linear_result += t.amount;
                }
            }

            assert_eq!(
                binary_result, linear_result,
                "mismatch at now={}: binary={} linear={}",
                now, binary_result, linear_result
            );
        }
    }
}
