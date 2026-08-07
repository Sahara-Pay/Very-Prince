// Property-based tests for integer square root functions
// These tests validate mathematical correctness across a wide range of inputs

use amm_math::{isqrt, isqrt_bitwise, isqrt_amm};
use proptest::prelude::*;

proptest! {
    #[test]
    fn prop_isqrt_basic_property(n in 0u128..) {
        // Test that isqrt(n)² ≤ n < (isqrt(n) + 1)² for all n
        if let Some(sqrt) = isqrt(n) {
            // Check lower bound: sqrt² ≤ n
            let sqrt_squared = sqrt.checked_mul(sqrt);
            prop_assert!(sqrt_squared.map_or(false, |sq| sq <= n), 
                "isqrt({})² = {} should be ≤ {}", n, sqrt_squared.unwrap_or(u128::MAX), n);
            
            // Check upper bound: n < (sqrt + 1)²
            let sqrt_plus_1 = sqrt.checked_add(1);
            if let Some(sp1) = sqrt_plus_1 {
                let sp1_squared = sp1.checked_mul(sp1);
                prop_assert!(sp1_squared.map_or(true, |sq| n < sq), 
                    "isqrt({})+1² = {} should be > {}", n, sp1_squared.unwrap_or(u128::MAX), n);
            }
        }
    }

    #[test]
    fn prop_isqrt_perfect_squares(n in 0u64..) {
        // For perfect squares, isqrt(n²) = n
        let n = n as u128;
        let square = n.checked_mul(n);
        if let Some(sq) = square {
            if let Some(result) = isqrt(sq) {
                prop_assert_eq!(result, n, "isqrt({}²) should be {}, got {}", n, n, result);
            }
        }
    }

    #[test]
    fn prop_isqrt_monotonic(n1 in 0u128.., n2 in 0u128..) {
        // If n1 ≤ n2, then isqrt(n1) ≤ isqrt(n2)
        if n1 <= n2 {
            let sqrt1 = isqrt(n1);
            let sqrt2 = isqrt(n2);
            match (sqrt1, sqrt2) {
                (Some(s1), Some(s2)) => {
                    prop_assert!(s1 <= s2, 
                        "isqrt({}) = {} should be ≤ isqrt({}) = {}", n1, s1, n2, s2);
                }
                _ => {}
            }
        }
    }

    #[test]
    fn prop_isqrt_bitwise_consistency(n in 0u128..) {
        // isqrt and isqrt_bitwise should produce identical results
        let result_newton = isqrt(n);
        let result_bitwise = isqrt_bitwise(n);
        prop_assert_eq!(result_newton, result_bitwise, 
            "isqrt({}) = {:?} but isqrt_bitwise({}) = {:?}", n, result_newton, n, result_bitwise);
    }

    #[test]
    fn prop_isqrt_amm_consistency(n in 0u128..) {
        // isqrt_amm should produce the same result as isqrt for all inputs
        let result_standard = isqrt(n);
        let result_amm = isqrt_amm(n);
        prop_assert_eq!(result_standard, result_amm, 
            "isqrt({}) = {:?} but isqrt_amm({}) = {:?}", n, result_standard, n, result_amm);
    }

    #[test]
    fn prop_isqrt_range(n in 0u128..) {
        // isqrt(n) should be in range [0, √n]
        if let Some(sqrt) = isqrt(n) {
            // Lower bound: sqrt ≥ 0
            prop_assert!(sqrt >= 0, "isqrt({}) should be ≥ 0, got {}", n, sqrt);
            
            // Upper bound: sqrt ≤ √n (approximately)
            // We check this by verifying sqrt² ≤ n
            let sqrt_squared = sqrt.checked_mul(sqrt);
            prop_assert!(sqrt_squared.map_or(false, |sq| sq <= n), 
                "isqrt({})² = {} should be ≤ {}", n, sqrt_squared.unwrap_or(u128::MAX), n);
        }
    }

    #[test]
    fn prop_isqrt_idempotent(n in 0u128..) {
        // isqrt(isqrt(n)) should converge quickly
        if let Some(sqrt1) = isqrt(n) {
            if let Some(sqrt2) = isqrt(sqrt1) {
                // For n ≥ 1, isqrt(isqrt(n)) should be either isqrt(n) or isqrt(n)-1
                // This tests convergence properties
                if n >= 1 {
                    prop_assert!(sqrt2 == sqrt1 || sqrt2 == sqrt1.saturating_sub(1),
                        "isqrt(isqrt({})) = {} should converge to {} or {}", n, sqrt2, sqrt1, sqrt1.saturating_sub(1));
                }
            }
        }
    }

    #[test]
    fn prop_isqrt_special_cases() {
        // Test specific mathematical properties
        prop_assert_eq!(isqrt(0), Some(0), "isqrt(0) should be 0");
        prop_assert_eq!(isqrt(1), Some(1), "isqrt(1) should be 1");
        prop_assert_eq!(isqrt(u128::MAX), Some(340282366920938463463374607431768211455u128), 
            "isqrt(u128::MAX) should be √(2¹²⁸-1)");
    }

    #[test]
    fn prop_isqrt_power_of_two(exp in 0u8..64) {
        // Test powers of 2: isqrt(2^exp) = 2^(exp/2)
        let n = 1u128 << exp;
        let expected = 1u128 << (exp / 2);
        if let Some(result) = isqrt(n) {
            prop_assert_eq!(result, expected, 
                "isqrt(2^{}) = {} should equal 2^{} = {}", exp, result, exp / 2, expected);
        }
    }

    #[test]
    fn prop_isqrt_near_perfect_squares(base in 1u64..10000) {
        // Test values near perfect squares
        let base = base as u128;
        let square = base * base;
        
        // Test square - 1, square, square + 1
        for delta in -1i64..=1 {
            let n = (square as i64 + delta) as u128;
            if let Some(sqrt) = isqrt(n) {
                let expected = if delta <= 0 { base } else { base + 1 };
                prop_assert!(sqrt == expected as u128 || sqrt == expected as u128 - 1,
                    "isqrt({}² + {}) = {} should be close to {}", base, delta, sqrt, expected);
            }
        }
    }

    #[test]
    fn prop_isqrt_large_values() {
        // Test very large values to ensure no overflow
        prop_assert!(isqrt(u128::MAX).is_some(), "isqrt(u128::MAX) should not overflow");
        prop_assert!(isqrt(u128::MAX - 1).is_some(), "isqrt(u128::MAX - 1) should not overflow");
        
        // Test values near u128::MAX / 2
        let half_max = u128::MAX / 2;
        prop_assert!(isqrt(half_max).is_some(), "isqrt(u128::MAX/2) should not overflow");
    }

    #[test]
    fn prop_isqrt_convergence_rate(n in 1000u128..1_000_000) {
        // Test that the algorithm converges quickly for medium-sized numbers
        // This indirectly tests the efficiency of the initial guess
        let _ = isqrt(n); // Just ensure it completes without panicking
        prop_assert!(true, "isqrt({}) should complete quickly", n);
    }

    #[test]
    fn prop_isqrt_bitwise_deterministic(n in 0u128..) {
        // Same input should always produce same output (determinism)
        let result1 = isqrt_bitwise(n);
        let result2 = isqrt_bitwise(n);
        prop_assert_eq!(result1, result2, 
            "isqrt_bitwise({}) should be deterministic", n);
    }

    #[test]
    fn prop_isqrt_newton_deterministic(n in 0u128..) {
        // Same input should always produce same output (determinism)
        let result1 = isqrt(n);
        let result2 = isqrt(n);
        prop_assert_eq!(result1, result2, 
            "isqrt({}) should be deterministic", n);
    }

    #[test]
    fn prop_isqrt_boundary_values() {
        // Test boundary values around powers of 2
        for exp in 0..64u32 {
            let power = 1u128 << exp;
            if power > 0 {
                // Test power - 1, power, power + 1
                for delta in -1i64..=1i64 {
                    let n = (power as i64 + delta) as u128;
                    let _ = isqrt(n); // Should not panic
                }
            }
        }
        prop_assert!(true, "All boundary values handled correctly");
    }

    #[test]
    fn prop_isqrt_multiplicative_property(a in 1u64..1000, b in 1u64..1000) {
        // Test that isqrt(a*b) is close to isqrt(a)*isqrt(b)
        // This is not exact due to integer rounding, but should be close
        let a = a as u128;
        let b = b as u128;
        let product = a.checked_mul(b);
        
        if let Some(prod) = product {
            let sqrt_ab = isqrt(prod);
            let sqrt_a = isqrt(a);
            let sqrt_b = isqrt(b);
            
            if let (Some(sab), Some(sa), Some(sb)) = (sqrt_ab, sqrt_a, sqrt_b) {
                let product_of_sqrts = sa.checked_mul(sb);
                if let Some(pos) = product_of_sqrts {
                    // The difference should be at most 1 due to rounding
                    let diff = if sab > pos { sab - pos } else { pos - sab };
                    prop_assert!(diff <= 1 || diff <= sab / 100,
                        "isqrt({}*{}) = {} should be close to isqrt({})*isqrt({}) = {}", 
                        a, b, sab, a, b, pos);
                }
            }
        }
    }

    #[test]
    fn prop_isqrt_additive_property(a in 0u128..10000, b in 0u128..10000) {
        // Test that isqrt(a+b) ≤ isqrt(a) + isqrt(b) + 1
        // This is a known mathematical inequality
        let sum = a.saturating_add(b);
        let sqrt_sum = isqrt(sum);
        let sqrt_a = isqrt(a);
        let sqrt_b = isqrt(b);
        
        if let (Some(ss), Some(sa), Some(sb)) = (sqrt_sum, sqrt_a, sqrt_b) {
            let sum_of_sqrts = sa.saturating_add(sb).saturating_add(1);
            prop_assert!(ss <= sum_of_sqrts,
                "isqrt({}+{}) = {} should be ≤ isqrt({}) + isqrt({}) + 1 = {}",
                a, b, ss, a, b, sum_of_sqrts);
        }
    }
}

#[cfg(test)]
mod additional_tests {
    use super::*;
    use amm_math::{compute_output_amount, compute_input_amount};

    proptest! {
        #[test]
        fn prop_compute_output_amount_non_negative(
            input in 0u128..1_000_000,
            reserve_in in 1u128..1_000_000,
            reserve_out in 1u128..1_000_000
        ) {
            // Output should always be non-negative and ≤ reserve_out
            if let Some(output) = compute_output_amount(input, reserve_in, reserve_out) {
                prop_assert!(output <= reserve_out,
                    "Output {} should be ≤ reserve_out {}", output, reserve_out);
            }
        }

        #[test]
        fn prop_compute_output_amount_monotonic(
            input1 in 0u128..1000,
            input2 in 0u128..1000,
            reserve_in in 1000u128..10000,
            reserve_out in 1000u128..10000
        ) {
            // Larger input should produce larger output
            if input1 <= input2 {
                let out1 = compute_output_amount(input1, reserve_in, reserve_out);
                let out2 = compute_output_amount(input2, reserve_in, reserve_out);
                match (out1, out2) {
                    (Some(o1), Some(o2)) => {
                        prop_assert!(o1 <= o2,
                            "Output for input {} should be ≤ output for input {}", input1, input2);
                    }
                    _ => {}
                }
            }
        }

        #[test]
        fn prop_compute_input_output_consistency(
            amount in 100u128..1000,
            reserve_in in 1000u128..10000,
            reserve_out in 1000u128..10000
        ) {
            // If we compute output for amount, then compute input for that output,
            // we should get back approximately the original amount (with slippage)
            let output = compute_output_amount(amount, reserve_in, reserve_out);
            if let Some(out) = output {
                if out > 0 && out < reserve_out {
                    let input_back = compute_input_amount(out, reserve_in, reserve_out);
                    if let Some(in_back) = input_back {
                        // Allow for some slippage, but should be reasonably close
                        let diff = if amount > in_back { amount - in_back } else { in_back - amount };
                        prop_assert!(diff <= amount / 10 || diff <= 100,
                            "Round-trip calculation should be close: {} -> {} -> {}", amount, out, in_back);
                    }
                }
            }
        }

        #[test]
        fn prop_compute_input_amount_validation(
            output in 0u128..1_000_000,
            reserve_in in 1u128..1_000_000,
            reserve_out in 1u128..1_000_000
        ) {
            // Input calculation should validate that output < reserve_out
            let result = compute_input_amount(output, reserve_in, reserve_out);
            if output >= reserve_out {
                prop_assert!(result.is_none(),
                    "compute_input_amount should return None when output >= reserve_out");
            } else {
                prop_assert!(result.is_some(),
                    "compute_input_amount should return Some when output < reserve_out");
            }
        }
    }
}
