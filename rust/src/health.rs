use bytes::Bytes;
use http_body_util::Full;
use hyper::Response;
use serde_json::json;

use crate::gate::GateState;
use crate::verify;

/// Handle GET /__pay/health.
pub async fn handle_health(state: &GateState) -> Response<Full<Bytes>> {
    let reachable = verify::check_health(&state.client, &state.facilitator_url).await;
    let uptime = state.start_time.elapsed().as_secs();
    let network = match state.mode {
        crate::config::GateMode::Production => "mainnet",
        _ => "testnet",
    };

    let body = json!({
        "status": if reachable { "ok" } else { "degraded" },
        "facilitator": if reachable { "reachable" } else { "unreachable" },
        "network": network,
        "chain_id": state.chain_id,
        "uptime": uptime,
        "version": "0.1.0",
    });

    let mut resp = Response::new(Full::new(Bytes::from(body.to_string())));
    resp.headers_mut().insert("content-type", "application/json".parse().unwrap());
    resp
}
