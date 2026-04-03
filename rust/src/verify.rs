use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::time::Duration;

/// Build a shared facilitator HTTP client.
pub fn build_client() -> Client {
    Client::builder()
        .timeout(Duration::from_secs(5))
        .connect_timeout(Duration::from_secs(2))
        .pool_idle_timeout(Duration::from_secs(60))
        .pool_max_idle_per_host(10)
        .build()
        .expect("Failed to build HTTP client")
}

#[derive(Debug, Serialize)]
pub struct VerifyRequest {
    pub payment: String,
    pub requirements: VerifyRequirements,
}

#[derive(Debug, Serialize)]
pub struct VerifyRequirements {
    pub scheme: String,
    pub amount: String,
    pub settlement: String,
    pub to: String,
}

#[derive(Debug, Deserialize)]
pub struct VerifyResponse {
    pub valid: bool,
    pub reason: Option<String>,
    pub receipt: Option<String>,
    pub from: Option<String>,
    pub tab: Option<String>,
    pub amount: Option<String>,
    pub settlement: Option<String>,
}

/// Call facilitator /verify. Returns None if unreachable/timeout.
pub async fn verify_payment(
    client: &Client,
    facilitator_url: &str,
    payment: &str,
    amount: &str,
    settlement: &str,
    to: &str,
) -> Option<VerifyResponse> {
    let body = VerifyRequest {
        payment: payment.to_string(),
        requirements: VerifyRequirements {
            scheme: "exact".to_string(),
            amount: amount.to_string(),
            settlement: settlement.to_string(),
            to: to.to_string(),
        },
    };

    let url = format!("{}/verify", facilitator_url);
    let resp = match client.post(&url).json(&body).send().await {
        Ok(r) => r,
        Err(e) => {
            if e.is_timeout() {
                tracing::error!("Facilitator timeout after 5s");
            } else {
                tracing::error!("Facilitator error: {}", e);
            }
            return None;
        }
    };

    if !resp.status().is_success() {
        tracing::error!("Facilitator returned {}", resp.status());
        return None;
    }

    match resp.json::<VerifyResponse>().await {
        Ok(v) => Some(v),
        Err(e) => {
            tracing::error!("Facilitator response parse error: {}", e);
            None
        }
    }
}

/// Check facilitator health (GET /supported).
pub async fn check_health(client: &Client, facilitator_url: &str) -> bool {
    let url = format!("{}/supported", facilitator_url);
    let result = client
        .get(&url)
        .timeout(Duration::from_secs(3))
        .send()
        .await;

    matches!(result, Ok(r) if r.status().is_success())
}
