use hyper::{Response, StatusCode};
use http_body_util::Full;
use bytes::Bytes;
use serde_json::json;

/// Structured error types for pay-gate responses.
#[derive(Debug)]
pub enum GateError {
    PaymentRequired {
        payment_required_header: String,
        body: String,
        content_type: String,
    },
    Forbidden,
    RateLimited,
    BadGateway(String),
    ServiceUnavailable,
    ConfigError(String),
}

impl GateError {
    pub fn into_response(self) -> Response<Full<Bytes>> {
        match self {
            GateError::PaymentRequired { payment_required_header, body, content_type } => {
                let mut resp = Response::new(Full::new(Bytes::from(body)));
                *resp.status_mut() = StatusCode::PAYMENT_REQUIRED;
                resp.headers_mut().insert("PAYMENT-REQUIRED", payment_required_header.parse().unwrap());
                resp.headers_mut().insert("content-type", content_type.parse().unwrap());
                resp
            }
            GateError::Forbidden => json_response(
                StatusCode::FORBIDDEN,
                json!({"error": "forbidden", "message": "This endpoint is not available."}),
            ),
            GateError::RateLimited => json_response(
                StatusCode::TOO_MANY_REQUESTS,
                json!({"error": "rate_limited", "message": "Too many requests."}),
            ),
            GateError::BadGateway(msg) => json_response(
                StatusCode::BAD_GATEWAY,
                json!({"error": "bad_gateway", "message": msg}),
            ),
            GateError::ServiceUnavailable => json_response(
                StatusCode::SERVICE_UNAVAILABLE,
                json!({"error": "service_unavailable", "message": "Payment facilitator is unreachable."}),
            ),
            GateError::ConfigError(msg) => json_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                json!({"error": "config_error", "message": msg}),
            ),
        }
    }
}

fn json_response(status: StatusCode, body: serde_json::Value) -> Response<Full<Bytes>> {
    let bytes = Bytes::from(body.to_string());
    let mut resp = Response::new(Full::new(bytes));
    *resp.status_mut() = status;
    resp.headers_mut().insert("content-type", "application/json".parse().unwrap());
    resp
}
