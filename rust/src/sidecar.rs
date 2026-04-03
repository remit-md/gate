use bytes::Bytes;
use http_body_util::Full;
use hyper::{Request, Response};

use crate::config::{self, Settlement};
use crate::error::GateError;
use crate::gate::GateState;
use crate::response::build_402;
use crate::routes::RouteMatch;
use crate::verify;

/// Handle POST /__pay/check for sidecar mode (nginx auth_request, traefik forwardAuth, etc).
///
/// Reads X-Original-URI and X-Original-Method headers to determine the route.
/// Returns 200 with X-Pay-* headers on success, 402 on payment required, 403 on blocked.
pub async fn handle_check(
    state: &GateState,
    req: &Request<hyper::body::Incoming>,
) -> Response<Full<Bytes>> {
    let original_uri = req.headers()
        .get("x-original-uri")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("/");
    let original_method = req.headers()
        .get("x-original-method")
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
        RouteMatch::Free => ok_with_header("X-Pay-Verified", "free"),

        RouteMatch::Passthrough => ok_empty(),

        RouteMatch::Blocked => GateError::Forbidden.into_response(),

        RouteMatch::Allowlisted { ref agent } => {
            let mut resp = ok_empty();
            resp.headers_mut().insert("X-Pay-Verified", "allowlisted".parse().unwrap());
            resp.headers_mut().insert("X-Pay-From", agent.parse().unwrap());
            resp
        }

        RouteMatch::Paid { route, price, settlement } => {
            handle_paid_check(state, &price, settlement, payment_sig, req).await
        }
    }
}

async fn handle_paid_check(
    state: &GateState,
    price: &str,
    settlement: Settlement,
    payment_sig: Option<&str>,
    req: &Request<hyper::body::Incoming>,
) -> Response<Full<Bytes>> {
    let accept = req.headers().get("accept").and_then(|v| v.to_str().ok());
    let amount = config::price_to_micro_usdc(price);
    let settlement_str = match settlement {
        Settlement::Direct => "direct",
        Settlement::Tab => "tab",
    };

    let Some(sig) = payment_sig else {
        return build_402(
            &amount, settlement, &state.config.provider_address,
            &state.facilitator_url, price, accept, None,
        );
    };

    let result = verify::verify_payment(
        &state.client, &state.facilitator_url,
        sig, &amount, settlement_str, &state.config.provider_address,
    ).await;

    let Some(result) = result else {
        return match state.config.fail_mode {
            crate::config::FailMode::Open => ok_with_header("X-Pay-Verified", "free"),
            crate::config::FailMode::Closed => GateError::ServiceUnavailable.into_response(),
        };
    };

    if !result.valid {
        return build_402(
            &amount, settlement, &state.config.provider_address,
            &state.facilitator_url, price, accept, result.reason.as_deref(),
        );
    }

    let mut resp = ok_empty();
    resp.headers_mut().insert("X-Pay-Verified", "true".parse().unwrap());
    resp.headers_mut().insert("X-Pay-Amount", amount.parse().unwrap());
    resp.headers_mut().insert("X-Pay-Settlement", settlement_str.parse().unwrap());
    if let Some(ref f) = result.from {
        resp.headers_mut().insert("X-Pay-From", f.parse().unwrap());
    }
    if let Some(ref t) = result.tab {
        resp.headers_mut().insert("X-Pay-Tab", t.parse().unwrap());
    }
    resp
}

fn ok_empty() -> Response<Full<Bytes>> {
    Response::new(Full::new(Bytes::new()))
}

fn ok_with_header(key: &str, val: &str) -> Response<Full<Bytes>> {
    let mut resp = Response::new(Full::new(Bytes::new()));
    resp.headers_mut().insert(key, val.parse().unwrap());
    resp
}
