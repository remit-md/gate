//! Discovery heartbeat sender (P11).
//!
//! Sends service metadata to the facilitator on startup + every 24h.
//! Non-blocking: failures are logged and retried next cycle.

use std::time::Duration;

use reqwest::Client;
use serde::Serialize;

use crate::config::{Config, DiscoveryConfig, GateMode, Settlement};

#[derive(Serialize)]
struct HeartbeatPayload {
    domain: String,
    provider_address: String,
    name: String,
    description: String,
    keywords: Vec<String>,
    category: String,
    website: Option<String>,
    routes: Vec<HeartbeatRoute>,
    pricing: serde_json::Value,
    settlement_mode: String,
    gate_version: String,
}

#[derive(Serialize)]
struct HeartbeatRoute {
    path: String,
    method: Option<String>,
    price: Option<String>,
    settlement: String,
}

fn build_payload(config: &Config, discovery: &DiscoveryConfig) -> Option<HeartbeatPayload> {
    let domain = crate::gate::extract_domain(&config.proxy.target)?;

    let routes: Vec<HeartbeatRoute> = config
        .routes
        .iter()
        .filter(|r| !r.free)
        .map(|r| HeartbeatRoute {
            path: r.path.clone(),
            method: r.method.clone(),
            price: r.price.clone(),
            settlement: match r.settlement {
                Some(Settlement::Direct) => "direct".to_string(),
                Some(Settlement::Tab) => "tab".to_string(),
                None => "auto".to_string(),
            },
        })
        .collect();

    // Determine primary settlement mode
    let settlement_mode = if routes.iter().any(|r| r.settlement == "tab") {
        "tab"
    } else {
        "direct"
    };

    Some(HeartbeatPayload {
        domain,
        provider_address: config.provider_address.clone(),
        name: discovery.name.clone(),
        description: discovery.description.clone(),
        keywords: discovery.keywords.clone(),
        category: discovery.category.clone(),
        website: discovery.website.clone(),
        routes,
        pricing: serde_json::json!({}),
        settlement_mode: settlement_mode.to_string(),
        gate_version: "0.1.0".to_string(),
    })
}

async fn send_heartbeat(client: &Client, facilitator_url: &str, payload: &HeartbeatPayload) {
    let url = format!(
        "{}/heartbeat",
        facilitator_url
            .replace("/x402", "/api/v1/discover")
    );

    for attempt in 0..3u32 {
        match client.post(&url).json(payload).send().await {
            Ok(resp) if resp.status().is_success() => {
                tracing::info!("Discovery heartbeat sent to {}", url);
                return;
            }
            Ok(resp) => {
                tracing::warn!(
                    attempt,
                    status = %resp.status(),
                    "Discovery heartbeat rejected"
                );
            }
            Err(e) => {
                tracing::warn!(attempt, error = %e, "Discovery heartbeat failed");
            }
        }

        if attempt < 2 {
            let delay = Duration::from_secs(2u64.pow(attempt + 1));
            tokio::time::sleep(delay).await;
        }
    }

    tracing::error!("Discovery heartbeat failed after 3 attempts");
}

/// Spawn heartbeat background task. Sends immediately, then every 24h.
pub fn spawn(client: Client, facilitator_url: String, config: Config, mode: GateMode) {
    let discovery = match (&config.discovery, mode) {
        (Some(d), _) if d.discoverable => d.clone(),
        _ => return, // Not discoverable or no config
    };

    // Don't send heartbeats in mock mode
    if mode == GateMode::Mock {
        return;
    }

    let payload = match build_payload(&config, &discovery) {
        Some(p) => p,
        None => {
            tracing::warn!("Could not build heartbeat payload (no domain in proxy target)");
            return;
        }
    };

    tokio::spawn(async move {
        // Send immediately on startup
        send_heartbeat(&client, &facilitator_url, &payload).await;

        // Then every 24 hours
        loop {
            tokio::time::sleep(Duration::from_secs(86400)).await;
            send_heartbeat(&client, &facilitator_url, &payload).await;
        }
    });
}
