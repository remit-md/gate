use bytes::Bytes;
use http_body_util::Full;
use hyper::Response;
use serde_json::json;

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

    let mut resp = Response::new(Full::new(Bytes::from(body.to_string())));
    resp.headers_mut()
        .insert("content-type", "application/json".parse().unwrap());
    resp
}
