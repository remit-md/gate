use std::sync::Arc;
use globset::{Glob, GlobSet, GlobSetBuilder};
use crate::config::{Config, RouteConfig, Settlement, DefaultAction};

/// Result of matching a request against route config.
#[derive(Debug)]
pub enum RouteMatch<'a> {
    /// Paid route — needs payment or verification.
    Paid { route: &'a RouteConfig, price: String, settlement: Settlement },
    /// Free route — proxy directly.
    Free,
    /// Allowlisted agent — proxy with allowlisted headers.
    Allowlisted { agent: String },
    /// No route matched, default_action = passthrough.
    Passthrough,
    /// No route matched, default_action = block.
    Blocked,
}

/// Compiled route matcher. Built once from config, shared across requests.
pub struct RouteMatcher {
    globset: GlobSet,
    routes: Vec<RouteConfig>,
    default_action: DefaultAction,
    global_allowlist: Vec<String>,
}

impl RouteMatcher {
    /// Build a RouteMatcher from config. Fails if any glob pattern is invalid.
    pub fn new(config: &Config) -> Result<Arc<Self>, String> {
        let mut builder = GlobSetBuilder::new();
        for route in &config.routes {
            let glob = Glob::new(&route.path)
                .map_err(|e| format!("Invalid glob pattern '{}': {}", route.path, e))?;
            builder.add(glob);
        }
        let globset = builder.build()
            .map_err(|e| format!("Failed to build globset: {}", e))?;

        let global_allowlist = config.global_allowlist
            .iter()
            .map(|a| a.to_lowercase())
            .collect();

        Ok(Arc::new(Self {
            globset,
            routes: config.routes.clone(),
            default_action: config.default_action,
            global_allowlist,
        }))
    }

    /// Match a request path + method against routes. First match wins.
    pub fn match_route<'a>(&'a self, path: &str, method: &str, agent: Option<&str>) -> RouteMatch<'a> {
        // Check global allowlist
        if let Some(addr) = agent {
            if self.global_allowlist.contains(&addr.to_lowercase()) {
                return RouteMatch::Allowlisted { agent: addr.to_string() };
            }
        }

        // GlobSet returns all matching indices; we want first-match by config order
        let matches = self.globset.matches(path);
        for &idx in &matches {
            let route = &self.routes[idx];

            // Method filter
            if let Some(ref m) = route.method {
                if !m.eq_ignore_ascii_case(method) {
                    continue;
                }
            }

            // Per-route allowlist
            if let Some(addr) = agent {
                if route.allowlist.iter().any(|a| a.eq_ignore_ascii_case(addr)) {
                    return RouteMatch::Allowlisted { agent: addr.to_string() };
                }
            }

            if route.free {
                return RouteMatch::Free;
            }

            let price = route.price.clone().unwrap_or_default();
            let settlement = route.settlement
                .unwrap_or_else(|| crate::config::auto_settlement(&price));

            return RouteMatch::Paid { route, price, settlement };
        }

        // No match — default action
        match self.default_action {
            DefaultAction::Passthrough => RouteMatch::Passthrough,
            DefaultAction::Block => RouteMatch::Blocked,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::*;

    fn test_config(routes: Vec<RouteConfig>, default: DefaultAction) -> Config {
        Config {
            version: 1,
            provider_address: "0x1234567890abcdef1234567890abcdef12345678".to_string(),
            proxy: ProxyConfig { target: "http://localhost:8080".to_string(), timeout: "30s".to_string() },
            routes,
            default_action: default,
            global_allowlist: vec![],
            rate_limits: RateLimits::default(),
            fail_mode: FailMode::Closed,
            log: LogConfig::default(),
            discovery: None,
        }
    }

    #[test]
    fn test_free_route() {
        let config = test_config(
            vec![RouteConfig {
                path: "/health".to_string(),
                method: None, price: None, settlement: None,
                free: true, allowlist: vec![], price_endpoint: None,
                description: None, mime_type: None, info: None,
            }],
            DefaultAction::Block,
        );
        let matcher = RouteMatcher::new(&config).unwrap();
        assert!(matches!(matcher.match_route("/health", "GET", None), RouteMatch::Free));
    }

    #[test]
    fn test_paid_route() {
        let config = test_config(
            vec![RouteConfig {
                path: "/api/v1/premium/*".to_string(),
                method: None, price: Some("0.01".to_string()),
                settlement: Some(Settlement::Tab), free: false,
                allowlist: vec![], price_endpoint: None,
                description: None, mime_type: None, info: None,
            }],
            DefaultAction::Block,
        );
        let matcher = RouteMatcher::new(&config).unwrap();
        match matcher.match_route("/api/v1/premium/data", "GET", None) {
            RouteMatch::Paid { price, settlement, .. } => {
                assert_eq!(price, "0.01");
                assert_eq!(settlement, Settlement::Tab);
            }
            other => panic!("Expected Paid, got {:?}", other),
        }
    }

    #[test]
    fn test_unmatched_block() {
        let config = test_config(vec![], DefaultAction::Block);
        let matcher = RouteMatcher::new(&config).unwrap();
        assert!(matches!(matcher.match_route("/unknown", "GET", None), RouteMatch::Blocked));
    }

    #[test]
    fn test_unmatched_passthrough() {
        let config = test_config(vec![], DefaultAction::Passthrough);
        let matcher = RouteMatcher::new(&config).unwrap();
        assert!(matches!(matcher.match_route("/unknown", "GET", None), RouteMatch::Passthrough));
    }

    #[test]
    fn test_method_filter() {
        let config = test_config(
            vec![RouteConfig {
                path: "/api/report".to_string(),
                method: Some("POST".to_string()),
                price: Some("5.00".to_string()),
                settlement: Some(Settlement::Direct), free: false,
                allowlist: vec![], price_endpoint: None,
                description: None, mime_type: None, info: None,
            }],
            DefaultAction::Passthrough,
        );
        let matcher = RouteMatcher::new(&config).unwrap();
        // POST matches
        assert!(matches!(matcher.match_route("/api/report", "POST", None), RouteMatch::Paid { .. }));
        // GET does not match
        assert!(matches!(matcher.match_route("/api/report", "GET", None), RouteMatch::Passthrough));
    }
}
