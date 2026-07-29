// Benchmark tests for integer square root implementations
// These benchmarks measure CPU efficiency and compare different algorithms

use criterion::{black_box, criterion_group, criterion_main, Criterion, BenchmarkId};
use amm_math::{isqrt, isqrt_bitwise, isqrt_amm};

fn benchmark_isqrt(c: &mut Criterion) {
    let mut group = c.benchmark_group("isqrt");
    
    // Test different input sizes
    let sizes = vec![
        (10u128, "small"),
        (1_000u128, "medium"),
        (1_000_000u128, "large"),
        (1_000_000_000u128, "very_large"),
        (u128::MAX, "max"),
    ];
    
    for (size, name) in sizes {
        group.bench_with_input(BenchmarkId::new("newton", name), &size, |b, &n| {
            b.iter(|| isqrt(black_box(n)))
        });
        
        group.bench_with_input(BenchmarkId::new("bitwise", name), &size, |b, &n| {
            b.iter(|| isqrt_bitwise(black_box(n)))
        });
        
        group.bench_with_input(BenchmarkId::new("amm", name), &size, |b, &n| {
            b.iter(|| isqrt_amm(black_box(n)))
        });
    }
    
    group.finish();
}

fn benchmark_convergence(c: &mut Criterion) {
    let mut group = c.benchmark_group("convergence");
    
    // Test values that require different numbers of iterations
    let test_cases = vec![
        (2u128, "requires_1_iteration"),
        (10u128, "requires_2_iterations"),
        (1000u128, "requires_3_iterations"),
        (1_000_000u128, "requires_4_iterations"),
    ];
    
    for (value, name) in test_cases {
        group.bench_with_input(BenchmarkId::new("newton", name), &value, |b, &n| {
            b.iter(|| isqrt(black_box(n)))
        });
        
        group.bench_with_input(BenchmarkId::new("bitwise", name), &value, |b, &n| {
            b.iter(|| isqrt_bitwise(black_box(n)))
        });
    }
    
    group.finish();
}

fn benchmark_special_cases(c: &mut Criterion) {
    let mut group = c.benchmark_group("special_cases");
    
    // Perfect squares (should converge fastest)
    group.bench_function("perfect_square_100", |b| {
        b.iter(|| isqrt(black_box(10_000u128)))
    });
    
    group.bench_function("perfect_square_1000", |b| {
        b.iter(|| isqrt(black_box(1_000_000u128)))
    });
    
    // Powers of 2 (common in AMM)
    group.bench_function("power_of_2_2_10", |b| {
        b.iter(|| isqrt(black_box(1u128 << 10)))
    });
    
    group.bench_function("power_of_2_2_20", |b| {
        b.iter(|| isqrt(black_box(1u128 << 20)))
    });
    
    group.bench_function("power_of_2_2_30", |b| {
        b.iter(|| isqrt(black_box(1u128 << 30)))
    });
    
    // Near perfect squares (worst case for some algorithms)
    group.bench_function("near_perfect_square_100", |b| {
        b.iter(|| isqrt(black_box(10_000u128 - 1)))
    });
    
    group.bench_function("near_perfect_square_1000", |b| {
        b.iter(|| isqrt(black_box(1_000_000u128 - 1)))
    });
    
    group.finish();
}

fn benchmark_amm_specific(c: &mut Criterion) {
    let mut group = c.benchmark_group("amm_specific");
    
    // Typical AMM pool sizes (in smallest token units)
    let pool_sizes = vec![
        (1_000_000u128, "small_pool"),
        (10_000_000u128, "medium_pool"),
        (100_000_000u128, "large_pool"),
        (1_000_000_000u128, "very_large_pool"),
    ];
    
    for (k, name) in pool_sizes {
        group.bench_with_input(BenchmarkId::new("isqrt_amm", name), &k, |b, &n| {
            b.iter(|| isqrt_amm(black_box(n)))
        });
    }
    
    group.finish();
}

fn benchmark_comparison_with_naive(c: &mut Criterion) {
    let mut group = c.benchmark_group("comparison");
    
    // Naive implementation for comparison
    fn isqrt_naive(mut n: u128) -> Option<u128> {
        if n == 0 {
            return Some(0);
        }
        
        let mut x = n;
        let mut y = (x + 1) / 2;
        
        while y < x {
            x = y;
            y = (x + n / x) / 2;
        }
        
        Some(x)
    }
    
    let test_values = vec![
        1000u128,
        1_000_000u128,
        1_000_000_000u128,
    ];
    
    for value in test_values {
        group.bench_with_input(BenchmarkId::new("optimized", format!("{}", value)), &value, |b, &n| {
            b.iter(|| isqrt(black_box(n)))
        });
        
        group.bench_with_input(BenchmarkId::new("naive", format!("{}", value)), &value, |b, &n| {
            b.iter(|| isqrt_naive(black_box(n)))
        });
    }
    
    group.finish();
}

criterion_group!(
    benches,
    benchmark_isqrt,
    benchmark_convergence,
    benchmark_special_cases,
    benchmark_amm_specific,
    benchmark_comparison_with_naive
);
criterion_main!(benches);
