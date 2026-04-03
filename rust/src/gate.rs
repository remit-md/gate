use std::sync::Arc;

use bytes::Bytes;
use http_body_util::Full;
use hyper::{Request, Response};

use crate::config::{self, Config, FailMode, GateMode, Settlement};
use crate::error::GateError;
use crate::response::build_402;
use crate::routes::{RouteMatch, RouteMatcher};
use crate::verify;

/// Shared state passed to each request handler.
pub struct GateState {
    pub config: Config,
    pub matcher: Arc<RouteMatcher>,
    pub client: reqwest::Client,
    pub mode: GateMode,
    pub facilitator_url: String,
    pub start_time: std::time::Instant,
}

/// Process an incoming request through the gate.
///
/// Returns the response to send back to the client.
/// Body type is `Full<Bytes>` for generated responses; proxy responses
/// are built in proxy.rs and returned through a different path.
pub async fn handle_request(
    state: &GateState,
    req: &Request<hyper::body::Incoming>,
) -> Result<GateDecision, GateError> {
    let path = req.uri().path();
    let method = req.method().as_str();

    // Extract agent address for allowlist checks
    let agent = req.headers()
        .get("x-pay-agent")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    let route_match = state.matcher.match_route(path, method, agent.as_deref());

    match route_match {
        RouteMatch::Free => Ok(GateDecision::ProxyFree),

        RouteMatch::Passthrough => Ok(GateDecision::ProxyFree),

        RouteMatch::Blocked => Err(GateError::Forbidden),

        RouteMatch::Allowlisted { agent } => {
            Ok(GateDecision::ProxyAllowlisted { agent })
        }

        RouteMatch::Paid { route, price, settlement } => {
            // Check for dynamic pricing
            let (final_price, final_settlement) = if let Some(ref endpoint) = route.price_endpoint {
                match fetch_dynamic_price(&state.client, endpoint, path, method).await {
                    Some(p) => {
                        let s = route.settlement.unwrap_or_else(|| config::auto_settlement(&p));
                        (p, s)
                    }
                    None if !price.is_empty() => (price, settlement),
                    None => return Err(GateError::ServiceUnavailable),
                }
            } else {
                (price, settlement)
            };

            let payment_sig = req.headers()
                .get("payment-signature")
                .and_then(|v| v.to_str().ok());

            match payment_sig {
                None => {
                    let accept = req.headers()
                        .get("accept")
                        .and_then(|v| v.to_str().ok());
                    let amount = config::price_to_micro_usdc(&final_price);
                    let resp = build_402(
                        &amount, final_settlement, &state.config.provider_address,
                        &state.facilitator_url, &final_price, accept, None,
                    );
                    Ok(GateDecision::Respond(resp))
                }
                Some(sig) => {
                    handle_verification(state, sig, &final_price, final_settlement, req).await
                }
            }
        }
    }
}

/// What the gate decided to do with a request.
pub enum GateDecision {
    /// Proxy to origin with no extra headers (free/passthrough).
    ProxyFree,
    /// Proxy to origin with allowlisted headers.
    ProxyAllowlisted { agent: String },
    /// Proxy to origin with payment verification headers.
    ProxyVerified {
        from: Option<String>,
        amount: String,
        settlement: String,
        tab: Option<String>,
        receipt: Option<String>,
    },
    /// Return this response directly (402, 403, etc).
    Respond(Response<Full<Bytes>>),
}

async fn handle_verification(
    state: &GateState,
    payment_sig: &str,
    price: &str,
    settlement: Settlement,
    req: &Request<hyper::body::Incoming>,
) -> Result<GateDecision, GateError> {
    if state.mode == GateMode::Mock {
        return Ok(GateDecision::ProxyVerified {
            from: Some("0xmock".to_string()),
            amount: config::price_to_micro_usdc(price),
            settlement: settlement_str(settlement).to_string(),
            tab: None,
            receipt: None,
        });
    }

    let amount = config::price_to_micro_usdc(price);
    let result = verify::verify_payment(
        &state.client,
        &state.facilitator_url,
        payment_sig,
        &amount,
        settlement_str(settlement),
        &state.config.provider_address,
    ).await;

    match result {
        None => {
            // Facilitator unreachable
            match state.config.fail_mode {
                FailMode::Open => {
                    tracing::warn!("Facilitator unreachable, fail_mode=open, passing through");
                    Ok(GateDecision::ProxyFree)
                }
                FailMode::Closed => Err(GateError::ServiceUnavailable),
            }
        }
        Some(resp) if !resp.valid => {
            let accept = req.headers()
                .get("accept")
                .and_then(|v| v.to_str().ok());
            let resp_402 = build_402(
                &amount, settlement, &state.config.provider_address,
                &state.facilitator_url, price, accept, resp.reason.as_deref(),
            );
            Ok(GateDecision::Respond(resp_402))
        }
        Some(resp) => {
            Ok(GateDecision::ProxyVerified {
                from: resp.from,
                amount,
                settlement: settlement_str(settlement).to_string(),
                tab: resp.tab,
                receipt: resp.receipt,
            })
        }
    }
}

fn settlement_str(s: Settlement) -> &'static str {
    match s {
        Settlement::Direct => "direct",
        Settlement::Tab => "tab",
    }
}

async fn fetch_dynamic_price(
    client: &reqwest::Client,
    endpoint: &str,
    path: &str,
    method: &str,
) -> Option<String> {
    let body = serde_json::json!({ "method": method, "path": path });
    let resp = client
        .post(endpoint)
        .json(&body)
        .timeout(std::time::Duration::from_secs(3))
        .send()
        .await
        .ok()?;

    if !resp.status().is_success() {
        return None;
    }

    let json: serde_json::Value = resp.json().await.ok()?;
    json.get("price")?.as_str().map(|s| s.to_string())
}
