use std::sync::Arc;

use bytes::Bytes;
use http_body_util::Full;
use hyper::{Request, Response};

use crate::config::{self, Config, FailMode, GateMode, Settlement};
use crate::error::GateError;
use crate::response::{build_402, Build402Params, build_requirements, build_settlement_response};
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
    pub chain_id: u64,
}

/// Process an incoming request through the gate.
pub async fn handle_request(
    state: &GateState,
    req: &Request<hyper::body::Incoming>,
) -> Result<GateDecision, GateError> {
    let path = req.uri().path();
    let method = req.method().as_str();

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
            let (final_price, final_settlement) = resolve_price(
                state, route, &price, settlement, path, method,
            ).await?;

            let payment_sig = req.headers()
                .get("payment-signature")
                .and_then(|v| v.to_str().ok());

            let request_url = req.uri().to_string();

            match payment_sig {
                None => {
                    let accept = req.headers()
                        .get("accept")
                        .and_then(|v| v.to_str().ok());
                    let amount = config::price_to_micro_usdc(&final_price);
                    let resp = build_402(&Build402Params {
                        amount: &amount, settlement: final_settlement,
                        provider_address: &state.config.provider_address,
                        facilitator_url: &state.facilitator_url,
                        price_display: &final_price, accept, reason: None,
                        request_url: &request_url, chain_id: state.chain_id,
                        description: route.description.as_deref(),
                        mime_type: route.mime_type.as_deref(),
                    });
                    Ok(GateDecision::Respond(resp))
                }
                Some(sig) => {
                    handle_verification(
                        state, sig, &final_price, final_settlement, req, &request_url,
                        (route.description.as_deref(), route.mime_type.as_deref()),
                    ).await
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
        payer: Option<String>,
        amount: String,
        settlement: String,
        receipt: String,
    },
    /// Return this response directly (402, 403, etc).
    Respond(Response<Full<Bytes>>),
}

async fn resolve_price(
    state: &GateState,
    route: &crate::config::RouteConfig,
    price: &str,
    settlement: Settlement,
    path: &str,
    method: &str,
) -> Result<(String, Settlement), GateError> {
    if let Some(ref endpoint) = route.price_endpoint {
        match fetch_dynamic_price(&state.client, endpoint, path, method).await {
            Some(p) => {
                let s = route.settlement.unwrap_or_else(|| config::auto_settlement(&p));
                Ok((p, s))
            }
            None if !price.is_empty() => Ok((price.to_string(), settlement)),
            None => Err(GateError::ServiceUnavailable),
        }
    } else {
        Ok((price.to_string(), settlement))
    }
}

async fn handle_verification<'a>(
    state: &GateState,
    payment_sig: &str,
    price: &str,
    settlement: Settlement,
    req: &Request<hyper::body::Incoming>,
    request_url: &str,
    meta: (Option<&'a str>, Option<&'a str>),
) -> Result<GateDecision, GateError> {
    let (description, mime_type) = meta;
    let amount = config::price_to_micro_usdc(price);

    if state.mode == GateMode::Mock {
        let receipt = build_settlement_response(Some("0xmock"), state.chain_id);
        return Ok(GateDecision::ProxyVerified {
            payer: Some("0xmock".to_string()),
            amount,
            settlement: settlement_str(settlement).to_string(),
            receipt,
        });
    }

    let requirements = build_requirements(
        &amount, settlement, &state.config.provider_address,
        &state.facilitator_url, state.chain_id,
    );

    // Extract domain from proxy target for volume tracking (P11)
    let gate_domain = extract_domain(&state.config.proxy.target);
    let result = verify::verify_payment(
        &state.client,
        &state.facilitator_url,
        payment_sig,
        &requirements,
        gate_domain.as_deref(),
    )
    .await;

    match result {
        None => match state.config.fail_mode {
            FailMode::Open => {
                tracing::warn!("Facilitator unreachable, fail_mode=open, passing through");
                Ok(GateDecision::ProxyFree)
            }
            FailMode::Closed => Err(GateError::ServiceUnavailable),
        },
        Some(resp) if !resp.is_valid => {
            let accept = req.headers()
                .get("accept")
                .and_then(|v| v.to_str().ok());
            let resp_402 = build_402(&Build402Params {
                amount: &amount, settlement,
                provider_address: &state.config.provider_address,
                facilitator_url: &state.facilitator_url,
                price_display: price, accept,
                reason: resp.invalid_reason.as_deref(),
                request_url, chain_id: state.chain_id,
                description, mime_type,
            });
            Ok(GateDecision::Respond(resp_402))
        }
        Some(resp) => {
            let receipt = build_settlement_response(
                resp.payer.as_deref(), state.chain_id,
            );
            Ok(GateDecision::ProxyVerified {
                payer: resp.payer,
                amount,
                settlement: settlement_str(settlement).to_string(),
                receipt,
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

/// Extract domain from a URL (e.g. "https://api.weather.com" → "api.weather.com").
pub fn extract_domain(url: &str) -> Option<String> {
    let without_scheme = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))?;
    let host = without_scheme.split('/').next()?;
    let domain = host.split(':').next()?;
    if domain.is_empty() {
        return None;
    }
    Some(domain.to_lowercase())
}
