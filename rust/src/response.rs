use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use bytes::Bytes;
use http_body_util::Full;
use hyper::Response;
use serde::Serialize;
use serde_json::json;

use crate::config::{self, Settlement};
use crate::error::GateError;

/// x402 v2 top-level 402 response payload.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaymentRequired {
    pub x402_version: u32,
    pub resource: ResourceInfo,
    pub accepts: Vec<PaymentRequirementsV2>,
    pub extensions: serde_json::Value,
}

/// Resource info in a 402 response.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceInfo {
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
}

/// x402 v2 payment requirements (one entry in the `accepts` array).
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PaymentRequirementsV2 {
    pub scheme: String,
    pub network: String,
    pub amount: String,
    pub asset: String,
    pub pay_to: String,
    pub max_timeout_seconds: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extra: Option<serde_json::Value>,
}

/// x402 v2 settlement response (base64-encoded in PAYMENT-RESPONSE header).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettlementResponse {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_reason: Option<String>,
    pub transaction: String,
    pub network: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payer: Option<String>,
    pub extensions: serde_json::Value,
}

/// Parameters for building a 402 response.
pub struct Build402Params<'a> {
    pub amount: &'a str,
    pub settlement: Settlement,
    pub provider_address: &'a str,
    pub facilitator_url: &'a str,
    pub price_display: &'a str,
    pub accept: Option<&'a str>,
    pub reason: Option<&'a str>,
    pub request_url: &'a str,
    pub chain_id: u64,
    pub description: Option<&'a str>,
    pub mime_type: Option<&'a str>,
    pub info: Option<&'a serde_json::Value>,
    pub route_template: Option<&'a str>,
}

/// Build a 402 Payment Required response with v2 wire format.
#[allow(clippy::too_many_arguments)]
pub fn build_402(p: &Build402Params<'_>) -> Response<Full<Bytes>> {
    let settlement_str = match p.settlement {
        Settlement::Direct => "direct",
        Settlement::Tab => "tab",
    };
    let network = config::caip2_network(p.chain_id);
    let asset = config::usdc_address(p.chain_id).to_string();

    let reqs = PaymentRequirementsV2 {
        scheme: "exact".to_string(),
        network: network.clone(),
        amount: p.amount.to_string(),
        asset,
        pay_to: p.provider_address.to_string(),
        max_timeout_seconds: 60,
        extra: Some(json!({
            "settlement": settlement_str,
            "facilitator": p.facilitator_url,
        })),
    };

    let extensions = if p.info.is_some() || p.route_template.is_some() {
        let mut bazaar = json!({});
        if let Some(info) = p.info {
            bazaar["info"] = info.clone();
            bazaar["schema"] = build_info_schema(info);
        }
        if let Some(tmpl) = p.route_template {
            bazaar["routeTemplate"] = json!(tmpl);
        }
        json!({ "bazaar": bazaar })
    } else {
        json!({})
    };

    let payment_required = PaymentRequired {
        x402_version: 2,
        resource: ResourceInfo {
            url: p.request_url.to_string(),
            description: p.description.map(|s| s.to_string()),
            mime_type: p.mime_type.map(|s| s.to_string()),
        },
        accepts: vec![reqs],
        extensions,
    };

    let header_value = BASE64.encode(
        serde_json::to_string(&payment_required).unwrap_or_default(),
    );
    let wants_html =
        p.accept.is_some_and(|a| a.contains("text/html") && !a.contains("application/json"));

    if wants_html {
        let html = build_402_html(p.price_display);
        GateError::PaymentRequired {
            payment_required_header: header_value,
            body: html,
            content_type: "text/html; charset=utf-8".to_string(),
        }
        .into_response()
    } else {
        let mut body = json!({
            "error": "payment_required",
            "message": format!("This endpoint requires payment. ${} per request.", p.price_display),
            "docs": "https://pay-skill.com/gate",
        });
        if let Some(r) = p.reason {
            body["reason"] = serde_json::Value::String(r.to_string());
        }
        GateError::PaymentRequired {
            payment_required_header: header_value,
            body: body.to_string(),
            content_type: "application/json".to_string(),
        }
        .into_response()
    }
}

/// Build a base64-encoded v2 SettlementResponse for the PAYMENT-RESPONSE header.
pub fn build_settlement_response(payer: Option<&str>, chain_id: u64) -> String {
    let resp = SettlementResponse {
        success: true,
        error_reason: None,
        transaction: String::new(),
        network: config::caip2_network(chain_id),
        payer: payer.map(|s| s.to_string()),
        extensions: json!({}),
    };
    BASE64.encode(serde_json::to_string(&resp).unwrap_or_default())
}

/// Build the v2 PaymentRequirementsV2 struct for use in verify requests.
pub fn build_requirements(
    amount: &str,
    settlement: Settlement,
    provider_address: &str,
    facilitator_url: &str,
    chain_id: u64,
) -> PaymentRequirementsV2 {
    build_requirements_with_base_url(
        amount, settlement, provider_address, facilitator_url, chain_id, None,
    )
}

/// Build requirements with optional base_url for auto-catalog in facilitator.
pub fn build_requirements_with_base_url(
    amount: &str,
    settlement: Settlement,
    provider_address: &str,
    facilitator_url: &str,
    chain_id: u64,
    base_url: Option<&str>,
) -> PaymentRequirementsV2 {
    let settlement_str = match settlement {
        Settlement::Direct => "direct",
        Settlement::Tab => "tab",
    };
    let mut extra = json!({
        "settlement": settlement_str,
        "facilitator": facilitator_url,
    });
    if let Some(url) = base_url {
        extra["base_url"] = json!(url);
    }
    PaymentRequirementsV2 {
        scheme: "exact".to_string(),
        network: config::caip2_network(chain_id),
        amount: amount.to_string(),
        asset: config::usdc_address(chain_id).to_string(),
        pay_to: provider_address.to_string(),
        max_timeout_seconds: 60,
        extra: Some(extra),
    }
}

/// Build a JSON Schema Draft 2020-12 from a Bazaar info block.
fn build_info_schema(info: &serde_json::Value) -> serde_json::Value {
    let empty = json!({});
    let input = info.get("input").unwrap_or(&empty);
    let input_schema = build_input_schema(input);
    let mut schema = json!({
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": { "input": input_schema },
        "required": ["input"],
    });
    if info.get("output").is_some() {
        schema["properties"]["output"] = json!({
            "type": "object",
            "properties": { "type": { "type": "string" } },
        });
    }
    schema
}

fn build_input_schema(input: &serde_json::Value) -> serde_json::Value {
    let input_type = input.get("type").and_then(|v| v.as_str()).unwrap_or("");
    if input_type == "http" {
        let method = input.get("method").and_then(|v| v.as_str()).unwrap_or("GET");
        let mut props = json!({
            "type": { "const": "http" },
            "method": { "const": method },
        });
        let mut required = vec!["type", "method"];
        if let Some(qp) = input.get("queryParams").and_then(|v| v.as_object()) {
            props["queryParams"] = build_params_schema(qp);
        }
        if let Some(bt) = input.get("bodyType").and_then(|v| v.as_str()) {
            props["bodyType"] = json!({ "const": bt });
            required.push("bodyType");
        }
        if input.get("body").is_some_and(|v| v.is_object()) {
            props["body"] = json!({ "type": "object" });
            required.push("body");
        }
        json!({ "type": "object", "properties": props, "required": required })
    } else {
        json!({
            "type": "object",
            "properties": {
                "type": { "const": "mcp" },
                "tool": { "type": "string" },
                "inputSchema": { "type": "object" },
            },
            "required": ["type", "tool", "inputSchema"],
        })
    }
}

fn build_params_schema(params: &serde_json::Map<String, serde_json::Value>) -> serde_json::Value {
    let mut props = json!({});
    let mut required: Vec<&str> = vec![];
    for (key, def) in params {
        let param_type = def.get("type").and_then(|v| v.as_str()).unwrap_or("string");
        props[key] = json!({ "type": param_type });
        if def.get("required").and_then(|v| v.as_bool()).unwrap_or(false) {
            required.push(key);
        }
    }
    let mut schema = json!({ "type": "object", "properties": props });
    if !required.is_empty() {
        schema["required"] = json!(required);
    }
    schema
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
