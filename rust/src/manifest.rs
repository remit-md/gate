use bytes::Bytes;
use http_body_util::Full;
use hyper::Response;
use serde_json::json;

use crate::config;
use crate::gate::GateState;

/// Handle GET /__pay/manifest — public service descriptor.
/// Returns routes, pricing, discovery metadata. No secrets.
pub fn handle_manifest(state: &GateState) -> Response<Full<Bytes>> {
    let routes: Vec<serde_json::Value> = state
        .config
        .routes
        .iter()
        .map(|r| {
            json!({
                "path": r.path,
                "method": r.method,
                "price": r.price,
                "settlement": r.settlement,
                "free": r.free,
                "description": r.description,
                "mime_type": r.mime_type,
            })
        })
        .collect();

    let discovery = state.config.discovery.as_ref().map(|d| {
        json!({
            "name": d.name,
            "description": d.description,
            "keywords": d.keywords,
            "category": d.category,
            "website": d.website,
            "docs_url": d.docs_url,
            "base_url": d.base_url,
        })
    });

    let body = json!({
        "routes": routes,
        "default_action": format!("{:?}", state.config.default_action).to_lowercase(),
        "discovery": discovery,
        "version": "0.1.0",
    });

    json_response(body)
}

/// Handle GET /.well-known/x402 — IETF draft x402 descriptor.
/// Lists paid endpoints with full x402 v2 payment requirements.
pub fn handle_well_known_x402(state: &GateState) -> Response<Full<Bytes>> {
    let network = config::caip2_network(state.chain_id);
    let asset = config::usdc_address(state.chain_id);

    let endpoints: Vec<serde_json::Value> = state
        .config
        .routes
        .iter()
        .filter(|r| !r.free && r.price.is_some())
        .map(|r| {
            let price = r.price.as_deref().unwrap_or("0");
            let settlement = r.settlement
                .unwrap_or_else(|| config::auto_settlement(price));
            let settlement_str = match settlement {
                config::Settlement::Direct => "direct",
                config::Settlement::Tab => "tab",
            };
            let mut entry = json!({
                "path": r.path,
                "method": r.method.as_deref().unwrap_or("GET").to_uppercase(),
                "paymentRequirements": {
                    "scheme": "exact",
                    "network": &network,
                    "amount": config::price_to_micro_usdc(price),
                    "asset": asset,
                    "payTo": &state.config.provider_address,
                    "maxTimeoutSeconds": 60,
                    "extra": { "settlement": settlement_str, "facilitator": &state.facilitator_url },
                },
            });
            if let Some(ref d) = r.description {
                entry["description"] = json!(d);
            }
            if let Some(ref m) = r.mime_type {
                entry["mimeType"] = json!(m);
            }
            if let Some(ref h) = r.hint {
                entry["hint"] = json!(h);
            }
            entry
        })
        .collect();

    let body = json!({
        "x402Version": 2,
        "payTo": &state.config.provider_address,
        "network": &network,
        "asset": asset,
        "endpoints": endpoints,
    });

    json_response(body)
}

fn json_response(body: serde_json::Value) -> Response<Full<Bytes>> {
    let mut resp = Response::new(Full::new(Bytes::from(body.to_string())));
    resp.headers_mut()
        .insert("content-type", "application/json".parse().unwrap());
    resp
}
