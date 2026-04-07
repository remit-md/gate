//! Benchmarks for route matching — the synchronous hot path.
//!
//! Measures glob compilation + per-request matching latency.

use criterion::{black_box, criterion_group, criterion_main, Criterion};
use pay_gate::config::*;
use pay_gate::routes::RouteMatcher;

fn bench_config(n_routes: usize) -> Config {
    let mut routes: Vec<RouteConfig> = Vec::with_capacity(n_routes);
    // First route: free health check
    routes.push(RouteConfig {
        path: "/health".to_string(),
        method: None,
        price: None,
        settlement: None,
        free: true,
        allowlist: vec![],
        price_endpoint: None,
    });
    // Paid routes with varied patterns
    for i in 0..n_routes.saturating_sub(1) {
        routes.push(RouteConfig {
            path: format!("/api/v1/resource{}/*", i),
            method: None,
            price: Some("0.01".to_string()),
            settlement: Some(Settlement::Tab),
            free: false,
            allowlist: vec![],
            price_endpoint: None,
        });
    }
    Config {
        version: 1,
        provider_address: "0x1234567890abcdef1234567890abcdef12345678".to_string(),
        proxy: ProxyConfig {
            target: "http://localhost:8080".to_string(),
            timeout: "30s".to_string(),
        },
        routes,
        default_action: DefaultAction::Block,
        global_allowlist: vec![],
        rate_limits: RateLimits::default(),
        fail_mode: FailMode::Closed,
        log: LogConfig::default(),
    }
}

fn bench_route_match_free(c: &mut Criterion) {
    let config = bench_config(10);
    let matcher = RouteMatcher::new(&config).unwrap();

    c.bench_function("route_match/free_hit", |b| {
        b.iter(|| {
            let _ = matcher.match_route(
                black_box("/health"),
                black_box("GET"),
                black_box(None),
            );
        });
    });
}

fn bench_route_match_paid(c: &mut Criterion) {
    let config = bench_config(10);
    let matcher = RouteMatcher::new(&config).unwrap();

    c.bench_function("route_match/paid_hit", |b| {
        b.iter(|| {
            let _ = matcher.match_route(
                black_box("/api/v1/resource5/data"),
                black_box("GET"),
                black_box(None),
            );
        });
    });
}

fn bench_route_match_miss(c: &mut Criterion) {
    let config = bench_config(10);
    let matcher = RouteMatcher::new(&config).unwrap();

    c.bench_function("route_match/miss_blocked", |b| {
        b.iter(|| {
            let _ = matcher.match_route(
                black_box("/unknown/path"),
                black_box("GET"),
                black_box(None),
            );
        });
    });
}

fn bench_route_match_allowlist(c: &mut Criterion) {
    let mut config = bench_config(10);
    config.global_allowlist =
        vec!["0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string()];
    let matcher = RouteMatcher::new(&config).unwrap();

    c.bench_function("route_match/allowlisted_agent", |b| {
        b.iter(|| {
            let _ = matcher.match_route(
                black_box("/api/v1/resource5/data"),
                black_box("GET"),
                black_box(Some("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")),
            );
        });
    });
}

fn bench_route_match_50_routes(c: &mut Criterion) {
    let config = bench_config(50);
    let matcher = RouteMatcher::new(&config).unwrap();

    c.bench_function("route_match/50_routes_last_hit", |b| {
        b.iter(|| {
            let _ = matcher.match_route(
                black_box("/api/v1/resource48/data"),
                black_box("GET"),
                black_box(None),
            );
        });
    });
}

fn bench_route_match_method_filter(c: &mut Criterion) {
    let config = Config {
        version: 1,
        provider_address: "0x1234567890abcdef1234567890abcdef12345678".to_string(),
        proxy: ProxyConfig {
            target: "http://localhost:8080".to_string(),
            timeout: "30s".to_string(),
        },
        routes: vec![RouteConfig {
            path: "/api/report".to_string(),
            method: Some("POST".to_string()),
            price: Some("5.00".to_string()),
            settlement: Some(Settlement::Direct),
            free: false,
            allowlist: vec![],
            price_endpoint: None,
        }],
        default_action: DefaultAction::Passthrough,
        global_allowlist: vec![],
        rate_limits: RateLimits::default(),
        fail_mode: FailMode::Closed,
        log: LogConfig::default(),
    };
    let matcher = RouteMatcher::new(&config).unwrap();

    c.bench_function("route_match/method_filter", |b| {
        b.iter(|| {
            let _ = matcher.match_route(
                black_box("/api/report"),
                black_box("POST"),
                black_box(None),
            );
        });
    });
}

fn bench_globset_compilation(c: &mut Criterion) {
    let config = bench_config(50);

    c.bench_function("route_match/compile_50_routes", |b| {
        b.iter(|| {
            let _ = RouteMatcher::new(black_box(&config)).unwrap();
        });
    });
}

criterion_group!(
    benches,
    bench_route_match_free,
    bench_route_match_paid,
    bench_route_match_miss,
    bench_route_match_allowlist,
    bench_route_match_50_routes,
    bench_route_match_method_filter,
    bench_globset_compilation,
);
criterion_main!(benches);
