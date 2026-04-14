use bytes::Bytes;
use http_body_util::Full;
use hyper::{Response, StatusCode, Uri};
use serde_json::json;

const DOCS_URL: &str = "https://pay-skill.com/docs/gate";

/// Validate request against the route's info block (query params + content-type).
///
/// Body field validation is deferred — hyper Incoming bodies are consumed on read,
/// and restructuring the proxy pipeline is Phase G2 scope.
/// pathParams validation is deferred to P26-4 (routeTemplate).
pub fn validate_request(
    uri: &Uri,
    headers: &hyper::HeaderMap,
    info: &serde_json::Value,
) -> Option<Response<Full<Bytes>>> {
    let input = info.get("input")?;
    let input_type = input.get("type")?.as_str()?;

    if input_type != "http" {
        return None; // MCP — transport validates its own payloads
    }

    if let Some(resp) = validate_query_params(uri, input) {
        return Some(resp);
    }

    if let Some(resp) = validate_content_type(headers, input) {
        return Some(resp);
    }

    None
}

/// Validate required query params are present in the URI.
fn validate_query_params(
    uri: &Uri,
    input: &serde_json::Value,
) -> Option<Response<Full<Bytes>>> {
    let qp = input.get("queryParams")?.as_object()?;
    let query = uri.query().unwrap_or("");

    for (name, def) in qp {
        let required = def.get("required").and_then(|v| v.as_bool()).unwrap_or(false);
        if required && !query_has_param(query, name) {
            return Some(error_response(&format!(
                "Missing required query parameter: {name}"
            )));
        }
    }
    None
}

/// Check Content-Type header matches the declared bodyType (POST/PUT/PATCH).
fn validate_content_type(
    headers: &hyper::HeaderMap,
    input: &serde_json::Value,
) -> Option<Response<Full<Bytes>>> {
    let body_type = input.get("bodyType")?.as_str()?;
    let ct = headers
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    let expected = match body_type {
        "json" => "application/json",
        "form-data" => "multipart/form-data",
        "text" => "text/",
        _ => return None,
    };

    if !ct.contains(expected) {
        return Some(error_response(&format!(
            "Expected Content-Type containing {expected}, got: {}",
            if ct.is_empty() { "(none)" } else { ct }
        )));
    }
    None
}

/// Check if a query string contains a given parameter name.
fn query_has_param(query: &str, name: &str) -> bool {
    for pair in query.split('&') {
        let key = pair.split('=').next().unwrap_or("");
        if key == name {
            return true;
        }
    }
    false
}

/// Build a 400 JSON response with structured error.
fn error_response(message: &str) -> Response<Full<Bytes>> {
    let body = json!({
        "error": "invalid_request",
        "message": message,
        "docs": DOCS_URL,
    });
    let bytes = Bytes::from(body.to_string());
    let mut resp = Response::new(Full::new(bytes));
    *resp.status_mut() = StatusCode::BAD_REQUEST;
    resp.headers_mut().insert(
        "content-type",
        "application/json".parse().unwrap(),
    );
    resp
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_query_has_param() {
        assert!(query_has_param("q=london&units=metric", "q"));
        assert!(query_has_param("q=london&units=metric", "units"));
        assert!(!query_has_param("q=london&units=metric", "missing"));
        assert!(query_has_param("q=", "q"));
        assert!(!query_has_param("", "q"));
    }

    #[test]
    fn test_missing_required_query_param() {
        let uri: Uri = "/weather?units=metric".parse().unwrap();
        let info = serde_json::json!({
            "input": {
                "type": "http",
                "method": "GET",
                "queryParams": {
                    "q": { "type": "string", "required": true },
                    "units": { "type": "string", "required": false }
                }
            }
        });
        let resp = validate_request(&uri, &hyper::HeaderMap::new(), &info);
        assert!(resp.is_some());
        assert_eq!(resp.unwrap().status(), StatusCode::BAD_REQUEST);
    }

    #[test]
    fn test_all_required_params_present() {
        let uri: Uri = "/weather?q=london&units=metric".parse().unwrap();
        let info = serde_json::json!({
            "input": {
                "type": "http",
                "method": "GET",
                "queryParams": {
                    "q": { "type": "string", "required": true },
                    "units": { "type": "string", "required": false }
                }
            }
        });
        let resp = validate_request(&uri, &hyper::HeaderMap::new(), &info);
        assert!(resp.is_none());
    }

    #[test]
    fn test_wrong_content_type() {
        let uri: Uri = "/api/data".parse().unwrap();
        let info = serde_json::json!({
            "input": {
                "type": "http",
                "method": "POST",
                "bodyType": "json",
                "body": { "type": "object" }
            }
        });
        let mut headers = hyper::HeaderMap::new();
        headers.insert("content-type", "text/plain".parse().unwrap());
        let resp = validate_request(&uri, &headers, &info);
        assert!(resp.is_some());
        assert_eq!(resp.unwrap().status(), StatusCode::BAD_REQUEST);
    }

    #[test]
    fn test_correct_content_type() {
        let uri: Uri = "/api/data".parse().unwrap();
        let info = serde_json::json!({
            "input": {
                "type": "http",
                "method": "POST",
                "bodyType": "json",
                "body": { "type": "object" }
            }
        });
        let mut headers = hyper::HeaderMap::new();
        headers.insert("content-type", "application/json".parse().unwrap());
        let resp = validate_request(&uri, &headers, &info);
        assert!(resp.is_none());
    }

    #[test]
    fn test_mcp_input_skipped() {
        let uri: Uri = "/mcp".parse().unwrap();
        let info = serde_json::json!({
            "input": {
                "type": "mcp",
                "tool": "weather",
                "inputSchema": {}
            }
        });
        let resp = validate_request(&uri, &hyper::HeaderMap::new(), &info);
        assert!(resp.is_none());
    }

    #[test]
    fn test_no_query_params_defined() {
        let uri: Uri = "/weather".parse().unwrap();
        let info = serde_json::json!({
            "input": {
                "type": "http",
                "method": "GET"
            }
        });
        let resp = validate_request(&uri, &hyper::HeaderMap::new(), &info);
        assert!(resp.is_none());
    }
}
