use bytes::Bytes;
use http_body_util::Full;
use hyper::{Request, Response};

use crate::config::{self, Settlement};
use crate::error::GateError;
use crate::gate::GateState;
use crate::response::{build_402, Build402Params, build_requirements, build_settlement_response};
use crate::routes::RouteMatch;
use crate::verify;

/// Handle POST /__pay/check for sidecar mode.
pub async fn handle_check(
    state: &GateState,
    req: &Request<hyper::body::Incoming>,
) -> Response<Full<Bytes>> {
    // Support nginx (X-Original-URI), Traefik (X-Forwarded-Uri), and Envoy
    // (path_prefix appends original path after /__pay/check).
    let req_path = req.uri().path_and_query().map(|pq| pq.as_str()).unwrap_or("/");
    // Envoy path_prefix: /__pay/check/weather?q=X → strip prefix to get /weather?q=X
    let envoy_fallback = req_path.strip_prefix("/__pay/check").unwrap_or(req_path);
    let original_uri_raw = req.headers()
        .get("x-original-uri")
        .or_else(|| req.headers().get("x-forwarded-uri"))
        .and_then(|v| v.to_str().ok())
        .unwrap_or(envoy_fallback);
    // Parse as URI to extract path only — matches gate.rs behavior (req.uri().path()).
    // Handles query strings, fragments, and percent-encoding consistently.
    let parsed_uri: Option<hyper::Uri> = original_uri_raw.parse().ok();
    let original_uri = parsed_uri.as_ref()
        .map(|u| u.path())
        .unwrap_or(original_uri_raw);
    let original_method = req.headers()
        .get("x-original-method")
        .or_else(|| req.headers().get("x-forwarded-method"))
        .and_then(|v| v.to_str().ok())
        .unwrap_or("GET");
    let agent = req.headers()
        .get("x-pay-agent")
        .and_then(|v| v.to_str().ok());
    let payment_sig = req.headers()
        .get("payment-signature")
        .and_then(|v| v.to_str().ok());

    let route_match = state.matcher.match_route(original_uri, original_method, agent);

    match route_match {
        RouteMatch::Free => ok_verified("free"),
        RouteMatch::Passthrough => ok_empty(),
        RouteMatch::Blocked => GateError::Forbidden.into_response(),
        RouteMatch::Allowlisted { ref agent } => {
            let mut resp = ok_empty();
            resp.headers_mut().insert("x-pay-verified", "allowlisted".parse().unwrap());
            resp.headers_mut().insert("x-pay-from", agent.parse().unwrap());
            resp
        }
        RouteMatch::Paid { route, price, settlement } => {
            handle_paid_check(
                state, &price, settlement, payment_sig, req, original_uri_raw,
                (route.description.as_deref(), route.mime_type.as_deref()),
            ).await
        }
    }
}

async fn handle_paid_check<'a>(
    state: &GateState,
    price: &str,
    settlement: Settlement,
    payment_sig: Option<&str>,
    req: &Request<hyper::body::Incoming>,
    original_uri: &str,
    meta: (Option<&'a str>, Option<&'a str>),
) -> Response<Full<Bytes>> {
    let (description, mime_type) = meta;
    let accept = req.headers().get("accept").and_then(|v| v.to_str().ok());
    let amount = config::price_to_micro_usdc(price);

    let Some(sig) = payment_sig else {
        return build_402(&Build402Params {
            amount: &amount, settlement,
            provider_address: &state.config.provider_address,
            facilitator_url: &state.facilitator_url,
            price_display: price, accept, reason: None,
            request_url: original_uri, chain_id: state.chain_id,
            description, mime_type,
        });
    };

    let requirements = build_requirements(
        &amount, settlement, &state.config.provider_address,
        &state.facilitator_url, state.chain_id,
    );

    let gate_domain = crate::gate::extract_domain(&state.config.proxy.target);
    let result = verify::verify_payment(
        &state.client,
        &state.facilitator_url,
        sig,
        &requirements,
        gate_domain.as_deref(),
    )
    .await;

    let Some(result) = result else {
        return match state.config.fail_mode {
            crate::config::FailMode::Open => ok_verified("free"),
            crate::config::FailMode::Closed => GateError::ServiceUnavailable.into_response(),
        };
    };

    if !result.is_valid {
        return build_402(&Build402Params {
            amount: &amount, settlement,
            provider_address: &state.config.provider_address,
            facilitator_url: &state.facilitator_url,
            price_display: price, accept,
            reason: result.invalid_reason.as_deref(),
            request_url: original_uri, chain_id: state.chain_id,
            description, mime_type,
        });
    }

    let settlement_str = match settlement {
        Settlement::Direct => "direct",
        Settlement::Tab => "tab",
    };

    let mut resp = ok_empty();
    resp.headers_mut().insert("x-pay-verified", "true".parse().unwrap());
    resp.headers_mut().insert("x-pay-amount", amount.parse().unwrap());
    resp.headers_mut().insert("x-pay-settlement", settlement_str.parse().unwrap());
    if let Some(ref f) = result.payer {
        resp.headers_mut().insert("x-pay-from", f.parse().unwrap());
    }
    let receipt = build_settlement_response(result.payer.as_deref(), state.chain_id);
    resp.headers_mut().insert("payment-response", receipt.parse().unwrap());
    resp
}

fn ok_empty() -> Response<Full<Bytes>> {
    Response::new(Full::new(Bytes::new()))
}

fn ok_verified(val: &str) -> Response<Full<Bytes>> {
    let mut resp = Response::new(Full::new(Bytes::new()));
    resp.headers_mut().insert("x-pay-verified", val.parse().unwrap());
    resp
}
