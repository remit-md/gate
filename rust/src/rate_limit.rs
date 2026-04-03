use governor::clock::DefaultClock;
use governor::state::keyed::DefaultKeyedStateStore;
use governor::{Quota, RateLimiter};
use std::num::NonZeroU32;
use std::sync::Arc;

/// Keyed rate limiter (by IP or agent address).
pub type KeyedLimiter = RateLimiter<String, DefaultKeyedStateStore<String>, DefaultClock>;

/// Build per-agent rate limiter from config string like "1000/min".
pub fn build_agent_limiter(spec: &str) -> Arc<KeyedLimiter> {
    let (count, period) = parse_rate_spec(spec);
    let quota = match period {
        Period::Second => Quota::per_second(count),
        Period::Minute => Quota::per_minute(count),
    };
    Arc::new(RateLimiter::keyed(quota))
}

/// Build verification rate limiter from config string like "100/s".
pub fn build_verify_limiter(spec: &str) -> Arc<KeyedLimiter> {
    let (count, period) = parse_rate_spec(spec);
    let quota = match period {
        Period::Second => Quota::per_second(count),
        Period::Minute => Quota::per_minute(count),
    };
    Arc::new(RateLimiter::keyed(quota))
}

/// Check if a key is rate limited. Returns true if the request should be rejected.
pub fn is_rate_limited(limiter: &KeyedLimiter, key: &str) -> bool {
    limiter.check_key(&key.to_string()).is_err()
}

/// Periodic cleanup of stale entries. Call every 5 minutes.
pub fn retain_recent(limiter: &KeyedLimiter) {
    limiter.retain_recent();
}

enum Period {
    Second,
    Minute,
}

fn parse_rate_spec(spec: &str) -> (NonZeroU32, Period) {
    let parts: Vec<&str> = spec.split('/').collect();
    let count = parts.first()
        .and_then(|s| s.parse::<u32>().ok())
        .and_then(NonZeroU32::new)
        .unwrap_or(NonZeroU32::new(100).unwrap());

    let period = match parts.get(1).map(|s| s.trim()) {
        Some("s") | Some("sec") | Some("second") => Period::Second,
        Some("m") | Some("min") | Some("minute") => Period::Minute,
        _ => Period::Minute,
    };

    (count, period)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_rate_spec() {
        let (c, _) = parse_rate_spec("1000/min");
        assert_eq!(c.get(), 1000);

        let (c, _) = parse_rate_spec("100/s");
        assert_eq!(c.get(), 100);

        let (c, _) = parse_rate_spec("50/second");
        assert_eq!(c.get(), 50);
    }

    #[test]
    fn test_rate_limiting() {
        let limiter = build_agent_limiter("2/s");
        // First two should pass
        assert!(!is_rate_limited(&limiter, "agent1"));
        assert!(!is_rate_limited(&limiter, "agent1"));
        // Third should be limited
        assert!(is_rate_limited(&limiter, "agent1"));
        // Different key should pass
        assert!(!is_rate_limited(&limiter, "agent2"));
    }
}
