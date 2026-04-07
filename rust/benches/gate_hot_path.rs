//! Benchmarks for the gate hot path — request handling + 402 generation.
//!
//! Measures the CPU overhead pay-gate adds: route matching, 402 construction,
//! rate limiting. Network-bound paths (facilitator verify, proxy) are covered
//! by the k6 integration benchmark in bench/k6-throughput.js.

use criterion::{black_box, criterion_group, criterion_main, Criterion};

use pay_gate::config::*;
use pay_gate::rate_limit;
use pay_gate::response::{build_402, Build402Params, build_requirements};
use pay_gate::routes::RouteMatcher;

/// Benchmark 402 response construction (the most common paid-path output).
fn bench_build_402(c: &mut Criterion) {
    let amount = price_to_micro_usdc("0.01");

    c.bench_function("hot_path/build_402_json", |b| {
        b.iter(|| {
            let _ = build_402(black_box(&Build402Params {
                amount: &amount,
                settlement: Settlement::Tab,
                provider_address: "0x1234567890abcdef1234567890abcdef12345678",
                facilitator_url: "https://testnet.pay-skill.com/x402",
                price_display: "0.01",
                accept: Some("application/json"),
                reason: None,
                request_url: "/api/v1/weather?q=NYC",
                chain_id: 84532,
            }));
        });
    });
}

/// Benchmark 402 HTML response (browser path).
fn bench_build_402_html(c: &mut Criterion) {
    let amount = price_to_micro_usdc("0.01");

    c.bench_function("hot_path/build_402_html", |b| {
        b.iter(|| {
            let _ = build_402(black_box(&Build402Params {
                amount: &amount,
                settlement: Settlement::Tab,
                provider_address: "0x1234567890abcdef1234567890abcdef12345678",
                facilitator_url: "https://testnet.pay-skill.com/x402",
                price_display: "0.01",
                accept: Some("text/html"),
                reason: None,
                request_url: "/api/v1/weather?q=NYC",
                chain_id: 84532,
            }));
        });
    });
}

/// Benchmark payment requirements construction.
fn bench_build_requirements(c: &mut Criterion) {
    let amount = price_to_micro_usdc("0.01");

    c.bench_function("hot_path/build_requirements", |b| {
        b.iter(|| {
            let _ = build_requirements(
                black_box(&amount),
                black_box(Settlement::Tab),
                black_box("0x1234567890abcdef1234567890abcdef12345678"),
                black_box("https://testnet.pay-skill.com/x402"),
                black_box(84532),
            );
        });
    });
}

/// Benchmark rate limiter check (single key, not exhausted).
fn bench_rate_limiter_pass(c: &mut Criterion) {
    let limiter = rate_limit::build_agent_limiter("10000/s");

    c.bench_function("hot_path/rate_limiter_pass", |b| {
        let mut i = 0u64;
        b.iter(|| {
            // Use unique keys to avoid exhaustion within the benchmark
            let key = format!("10.0.0.{}", i % 256);
            i += 1;
            let _ = rate_limit::is_rate_limited(
                black_box(&limiter),
                black_box(&key),
            );
        });
    });
}

/// Benchmark rate limiter check (same key, will be rate-limited).
fn bench_rate_limiter_reject(c: &mut Criterion) {
    let limiter = rate_limit::build_agent_limiter("1/min");
    // Exhaust the single allowed request
    let _ = rate_limit::is_rate_limited(&limiter, "10.0.0.1");

    c.bench_function("hot_path/rate_limiter_reject", |b| {
        b.iter(|| {
            let _ = rate_limit::is_rate_limited(
                black_box(&limiter),
                black_box("10.0.0.1"),
            );
        });
    });
}

/// Benchmark price_to_micro_usdc conversion.
fn bench_price_conversion(c: &mut Criterion) {
    c.bench_function("hot_path/price_to_micro_usdc", |b| {
        b.iter(|| {
            let _ = price_to_micro_usdc(black_box("0.01"));
        });
    });
}

/// Benchmark auto_settlement decision.
fn bench_auto_settlement(c: &mut Criterion) {
    c.bench_function("hot_path/auto_settlement", |b| {
        b.iter(|| {
            let _ = auto_settlement(black_box("0.50"));
        });
    });
}

/// End-to-end: route match + 402 build (no network, no proxy).
/// This is the "CPU overhead" that pay-gate adds to every paid request
/// when no payment signature is present.
fn bench_full_402_path(c: &mut Criterion) {
    let config = Config {
        version: 1,
        provider_address: "0x1234567890abcdef1234567890abcdef12345678".to_string(),
        proxy: ProxyConfig {
            target: "http://localhost:8080".to_string(),
            timeout: "30s".to_string(),
        },
        routes: vec![RouteConfig {
            path: "/api/v1/**".to_string(),
            method: None,
            price: Some("0.01".to_string()),
            settlement: Some(Settlement::Tab),
            free: false,
            allowlist: vec![],
            price_endpoint: None,
        }],
        default_action: DefaultAction::Block,
        global_allowlist: vec![],
        rate_limits: RateLimits::default(),
        fail_mode: FailMode::Closed,
        log: LogConfig::default(),
    };
    let matcher = RouteMatcher::new(&config).unwrap();

    c.bench_function("hot_path/full_402_no_sig", |b| {
        b.iter(|| {
            // 1. Route match
            let m = matcher.match_route(
                black_box("/api/v1/weather"),
                black_box("GET"),
                black_box(None),
            );
            // 2. Extract price + build 402
            if let pay_gate::routes::RouteMatch::Paid { price, settlement, .. } = m {
                let amount = price_to_micro_usdc(&price);
                let _ = build_402(&Build402Params {
                    amount: &amount,
                    settlement,
                    provider_address: &config.provider_address,
                    facilitator_url: "https://testnet.pay-skill.com/x402",
                    price_display: &price,
                    accept: Some("application/json"),
                    reason: None,
                    request_url: "/api/v1/weather",
                    chain_id: 84532,
                });
            }
        });
    });
}

/// End-to-end: route match for a free route (passthrough baseline).
fn bench_full_free_path(c: &mut Criterion) {
    let config = Config {
        version: 1,
        provider_address: "0x1234567890abcdef1234567890abcdef12345678".to_string(),
        proxy: ProxyConfig {
            target: "http://localhost:8080".to_string(),
            timeout: "30s".to_string(),
        },
        routes: vec![
            RouteConfig {
                path: "/health".to_string(),
                method: None,
                price: None,
                settlement: None,
                free: true,
                allowlist: vec![],
                price_endpoint: None,
            },
        ],
        default_action: DefaultAction::Block,
        global_allowlist: vec![],
        rate_limits: RateLimits::default(),
        fail_mode: FailMode::Closed,
        log: LogConfig::default(),
    };
    let matcher = RouteMatcher::new(&config).unwrap();

    c.bench_function("hot_path/full_free_passthrough", |b| {
        b.iter(|| {
            let _ = matcher.match_route(
                black_box("/health"),
                black_box("GET"),
                black_box(None),
            );
        });
    });
}

criterion_group!(
    benches,
    bench_build_402,
    bench_build_402_html,
    bench_build_requirements,
    bench_rate_limiter_pass,
    bench_rate_limiter_reject,
    bench_price_conversion,
    bench_auto_settlement,
    bench_full_402_path,
    bench_full_free_path,
);
criterion_main!(benches);
