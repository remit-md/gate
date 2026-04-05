use serde::Deserialize;
use std::path::Path;

/// Top-level config, parsed from YAML + env overrides.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
#[allow(dead_code)]
pub struct Config {
    pub version: u32,
    pub provider_address: String,
    pub proxy: ProxyConfig,
    pub routes: Vec<RouteConfig>,
    pub default_action: DefaultAction,
    #[serde(default)]
    pub global_allowlist: Vec<String>,
    #[serde(default)]
    pub rate_limits: RateLimits,
    #[serde(default)]
    pub fail_mode: FailMode,
    #[serde(default)]
    pub log: LogConfig,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
#[allow(dead_code)]
pub struct ProxyConfig {
    pub target: String,
    #[serde(default = "default_timeout")]
    pub timeout: String,
}

fn default_timeout() -> String {
    "30s".to_string()
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RouteConfig {
    pub path: String,
    pub method: Option<String>,
    pub price: Option<String>,
    pub settlement: Option<Settlement>,
    #[serde(default)]
    pub free: bool,
    #[serde(default)]
    pub allowlist: Vec<String>,
    pub price_endpoint: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Settlement {
    Direct,
    Tab,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DefaultAction {
    Passthrough,
    Block,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum FailMode {
    #[default]
    Closed,
    Open,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RateLimits {
    #[serde(default = "default_per_agent")]
    pub per_agent: String,
    #[serde(default = "default_verification")]
    pub verification: String,
}

impl Default for RateLimits {
    fn default() -> Self {
        Self {
            per_agent: default_per_agent(),
            verification: default_verification(),
        }
    }
}

fn default_per_agent() -> String { "1000/min".to_string() }
fn default_verification() -> String { "100/s".to_string() }

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
#[allow(dead_code)]
pub struct LogConfig {
    #[serde(default = "default_log_level")]
    pub level: String,
    #[serde(default = "default_log_format")]
    pub format: String,
}

impl Default for LogConfig {
    fn default() -> Self {
        Self {
            level: default_log_level(),
            format: default_log_format(),
        }
    }
}

fn default_log_level() -> String { "info".to_string() }
fn default_log_format() -> String { "json".to_string() }

/// Load config from file with env var overrides.
pub fn load_config(path: &Path) -> Result<Config, String> {
    let content = std::fs::read_to_string(path)
        .map_err(|e| format!("Failed to read config file {}: {}", path.display(), e))?;

    let mut config: Config = serde_yaml::from_str(&content)
        .map_err(|e| format!("Failed to parse config: {}", e))?;

    apply_env_overrides(&mut config);
    validate_config(&config)?;

    Ok(config)
}

/// Apply environment variable overrides.
fn apply_env_overrides(config: &mut Config) {
    if let Ok(v) = std::env::var("PAY_GATE_PROVIDER_ADDRESS") {
        config.provider_address = v;
    }
    if let Ok(v) = std::env::var("PAY_GATE_PROXY_TARGET") {
        config.proxy.target = v;
    }
    if let Ok(v) = std::env::var("PAY_GATE_DEFAULT_ACTION") {
        match v.as_str() {
            "passthrough" => config.default_action = DefaultAction::Passthrough,
            "block" => config.default_action = DefaultAction::Block,
            _ => {} // validated later
        }
    }
    if let Ok(v) = std::env::var("PAY_GATE_FAIL_MODE") {
        match v.as_str() {
            "closed" => config.fail_mode = FailMode::Closed,
            "open" => config.fail_mode = FailMode::Open,
            _ => {}
        }
    }
    if let Ok(v) = std::env::var("PAY_GATE_LOG_LEVEL") {
        config.log.level = v;
    }
}

/// Validate the full config. Returns Err with a clear message on failure.
fn validate_config(config: &Config) -> Result<(), String> {
    validate_eth_address(&config.provider_address, "provider_address")?;
    validate_url(&config.proxy.target, "proxy.target")?;

    for (i, route) in config.routes.iter().enumerate() {
        let label = format!("routes[{}] ({})", i, route.path);
        if route.path.is_empty() {
            return Err(format!("{}: path cannot be empty", label));
        }
        if route.free {
            continue;
        }
        if route.price.is_none() && route.price_endpoint.is_none() {
            return Err(format!("{}: must have 'price' or 'price_endpoint'", label));
        }
        if let Some(ref p) = route.price {
            validate_price(p, &label)?;
        }
        if let Some(ref url) = route.price_endpoint {
            validate_url(url, &format!("{}.price_endpoint", label))?;
        }
    }

    Ok(())
}

fn validate_eth_address(addr: &str, field: &str) -> Result<(), String> {
    if addr.len() != 42 || !addr.starts_with("0x") {
        return Err(format!("{}: invalid Ethereum address '{}'", field, addr));
    }
    if !addr[2..].chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(format!("{}: invalid Ethereum address '{}'", field, addr));
    }
    Ok(())
}

fn validate_url(url: &str, field: &str) -> Result<(), String> {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err(format!("{}: invalid URL '{}'", field, url));
    }
    Ok(())
}

fn validate_price(price: &str, label: &str) -> Result<(), String> {
    let n: f64 = price.parse().map_err(|_| format!("{}: invalid price '{}'", label, price))?;
    if n <= 0.0 {
        return Err(format!("{}: price must be positive, got '{}'", label, price));
    }
    Ok(())
}

/// Convert dollar price to micro-USDC string.
pub fn price_to_micro_usdc(price: &str) -> String {
    let dollars: f64 = price.parse().unwrap_or(0.0);
    let micro = (dollars * 1_000_000.0).round() as u64;
    micro.to_string()
}

/// Auto-select settlement based on price.
pub fn auto_settlement(price: &str) -> Settlement {
    let dollars: f64 = price.parse().unwrap_or(0.0);
    if dollars <= 1.0 { Settlement::Tab } else { Settlement::Direct }
}

/// Chain ID for a given mode.
pub fn chain_id(mode: GateMode) -> u64 {
    match mode {
        GateMode::Production => 8453,
        GateMode::Dev | GateMode::Mock => 84532,
    }
}

/// USDC contract address for a given chain.
pub fn usdc_address(chain_id: u64) -> &'static str {
    match chain_id {
        8453 => "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        _ => "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    }
}

/// CAIP-2 network identifier.
pub fn caip2_network(chain_id: u64) -> String {
    format!("eip155:{chain_id}")
}

/// Facilitator URL for a given mode.
pub fn facilitator_url(mode: GateMode) -> &'static str {
    match mode {
        GateMode::Production => "https://pay-skill.com/x402",
        GateMode::Dev => "https://testnet.pay-skill.com/x402",
        GateMode::Mock => "http://localhost:0", // unused in mock mode
    }
}

/// Gate operating mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GateMode {
    Production,
    Dev,
    Mock,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_price_to_micro_usdc() {
        assert_eq!(price_to_micro_usdc("0.01"), "10000");
        assert_eq!(price_to_micro_usdc("1.00"), "1000000");
        assert_eq!(price_to_micro_usdc("5.00"), "5000000");
        assert_eq!(price_to_micro_usdc("0.001"), "1000");
    }

    #[test]
    fn test_auto_settlement() {
        assert_eq!(auto_settlement("0.01"), Settlement::Tab);
        assert_eq!(auto_settlement("1.00"), Settlement::Tab);
        assert_eq!(auto_settlement("1.01"), Settlement::Direct);
        assert_eq!(auto_settlement("5.00"), Settlement::Direct);
    }

    #[test]
    fn test_validate_eth_address() {
        assert!(validate_eth_address("0x1234567890abcdef1234567890abcdef12345678", "test").is_ok());
        assert!(validate_eth_address("0xinvalid", "test").is_err());
        assert!(validate_eth_address("not_an_address", "test").is_err());
    }

    #[test]
    fn test_validate_price() {
        assert!(validate_price("0.01", "test").is_ok());
        assert!(validate_price("5.00", "test").is_ok());
        assert!(validate_price("0.00", "test").is_err());
        assert!(validate_price("-1.00", "test").is_err());
        assert!(validate_price("abc", "test").is_err());
    }
}
