use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::{Request, Response, Uri};

use crate::gate::GateDecision;

/// Proxy a request to the origin, injecting headers based on gate decision.
///
/// Streams request and response bodies without buffering.
pub async fn proxy_request(
    client: &hyper_util::client::legacy::Client<
        hyper_util::client::legacy::connect::HttpConnector,
        Incoming,
    >,
    origin: &str,
    mut req: Request<Incoming>,
    decision: &GateDecision,
) -> Result<Response<Incoming>, hyper::Error> {
    // Rewrite URI to origin
    let orig_uri = req.uri().clone();
    let target: Uri = format!(
        "{}{}{}",
        origin,
        orig_uri.path(),
        orig_uri.query().map_or(String::new(), |q| format!("?{}", q))
    ).parse().unwrap();
    *req.uri_mut() = target;

    // Remove host header — hyper will set it from the URI
    req.headers_mut().remove("host");

    // Strip payment headers — don't forward to origin
    req.headers_mut().remove("payment-signature");

    // Inject headers based on gate decision
    match decision {
        GateDecision::ProxyFree => {}
        GateDecision::ProxyAllowlisted { agent } => {
            req.headers_mut().insert("X-Pay-Verified", "allowlisted".parse().unwrap());
            req.headers_mut().insert("X-Pay-From", agent.parse().unwrap());
        }
        GateDecision::ProxyVerified { from, amount, settlement, tab, .. } => {
            req.headers_mut().insert("X-Pay-Verified", "true".parse().unwrap());
            req.headers_mut().insert("X-Pay-Amount", amount.parse().unwrap());
            req.headers_mut().insert("X-Pay-Settlement", settlement.parse().unwrap());
            if let Some(f) = from {
                req.headers_mut().insert("X-Pay-From", f.parse().unwrap());
            }
            if let Some(t) = tab {
                req.headers_mut().insert("X-Pay-Tab", t.parse().unwrap());
            }
        }
        GateDecision::Respond(_) => unreachable!("Respond decisions don't reach proxy"),
    }

    client.request(req).await
}

/// Add receipt header to the proxied response.
pub fn add_receipt_header(
    resp: &mut Response<Incoming>,
    receipt: Option<&str>,
) {
    if let Some(r) = receipt {
        resp.headers_mut().insert("PAYMENT-RESPONSE", r.parse().unwrap());
    }
}
