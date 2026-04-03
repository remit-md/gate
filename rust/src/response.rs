use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use bytes::Bytes;
use http_body_util::Full;
use hyper::Response;
use serde::Serialize;
use serde_json::json;

use crate::config::Settlement;
use crate::error::GateError;

/// x402 V2 payment requirements.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaymentRequirements {
    pub scheme: String,
    pub amount: String,
    pub settlement: String,
    pub to: String,
    pub facilitator: String,
    pub max_charge_per_call: String,
    pub network: String,
}

/// Build a 402 Payment Required response.
pub fn build_402(
    amount: &str,
    settlement: Settlement,
    to: &str,
    facilitator: &str,
    price_display: &str,
    accept: Option<&str>,
    reason: Option<&str>,
) -> Response<Full<Bytes>> {
    let settlement_str = match settlement {
        Settlement::Direct => "direct",
        Settlement::Tab => "tab",
    };

    let reqs = PaymentRequirements {
        scheme: "exact".to_string(),
        amount: amount.to_string(),
        settlement: settlement_str.to_string(),
        to: to.to_string(),
        facilitator: facilitator.to_string(),
        max_charge_per_call: amount.to_string(),
        network: "base".to_string(),
    };

    let header_value = BASE64.encode(serde_json::to_string(&reqs).unwrap());
    let wants_html = accept.map_or(false, |a| a.contains("text/html") && !a.contains("application/json"));

    if wants_html {
        let html = build_402_html(price_display);
        GateError::PaymentRequired {
            payment_required_header: header_value,
            body: html,
            content_type: "text/html; charset=utf-8".to_string(),
        }.into_response()
    } else {
        let mut body = json!({
            "error": "payment_required",
            "message": format!("This endpoint requires payment. ${} per request.", price_display),
            "docs": "https://pay-skill.com/gate",
        });
        if let Some(r) = reason {
            body["reason"] = serde_json::Value::String(r.to_string());
        }
        GateError::PaymentRequired {
            payment_required_header: header_value,
            body: body.to_string(),
            content_type: "application/json".to_string(),
        }.into_response()
    }
}

fn build_402_html(price: &str) -> String {
    format!(
        "<html><head><title>Payment Required</title></head><body>\n\
         <h1>Payment Required</h1>\n\
         <p>This endpoint requires a payment of ${} per request.</p>\n\
         <p>Use an x402-compatible agent or SDK to access this API.</p>\n\
         <p><a href=\"https://pay-skill.com/gate\">Learn more about pay-gate</a></p>\n\
         </body></html>",
        price
    )
}
