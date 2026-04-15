#![deny(warnings)]

mod config;
mod error;
mod gate;
mod health;
mod heartbeat;
mod manifest;
mod proxy;
mod rate_limit;
mod response;
mod routes;
mod sidecar;
mod validate;
mod verify;

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use bytes::Bytes;
use clap::{Parser, Subcommand};
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response};
use hyper_util::rt::TokioIo;
use tokio::net::TcpListener;

use crate::config::{GateMode, load_config};
use crate::gate::{GateDecision, GateState};

#[derive(Parser)]
#[command(name = "pay-gate", version = "0.1.0")]
#[command(about = "x402 payment gateway — reverse proxy with Pay facilitator")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Start gateway (production mode, mainnet facilitator)
    Start {
        #[arg(short, long, default_value = "pay-gate.yaml")]
        config: PathBuf,
        #[arg(short, long, default_value = "8402")]
        port: u16,
        #[arg(long)]
        sidecar: bool,
    },
    /// Start gateway (dev mode, testnet facilitator, verbose logs)
    Dev {
        #[arg(short, long, default_value = "pay-gate.yaml")]
        config: PathBuf,
        #[arg(short, long, default_value = "8402")]
        port: u16,
        /// Override facilitator URL (dev/test only)
        #[arg(long, env = "PAY_GATE_FACILITATOR_URL")]
        facilitator_url: Option<String>,
    },
    /// Start gateway (mock mode, no verification, accepts all payments)
    Mock {
        #[arg(short, long, default_value = "pay-gate.yaml")]
        config: PathBuf,
        #[arg(short, long, default_value = "8402")]
        port: u16,
        /// Override facilitator URL (dev/test only)
        #[arg(long, env = "PAY_GATE_FACILITATOR_URL")]
        facilitator_url: Option<String>,
    },
    /// Check config without starting
    Validate {
        #[arg(short, long, default_value = "pay-gate.yaml")]
        config: PathBuf,
    },
    /// Generate starter pay-gate.yaml
    Init,
    /// Print version
    Version,
}

#[tokio::main]
async fn main() {
    let cli = Cli::parse();

    match cli.command {
        Command::Version => {
            println!("pay-gate 0.1.0");
        }
        Command::Init => {
            let example = include_str!("../pay-gate.example.yaml");
            std::fs::write("pay-gate.yaml", example).expect("Failed to write pay-gate.yaml");
            println!("Created pay-gate.yaml — edit it with your provider address, origin, and routes.");
        }
        Command::Validate { config } => {
            match load_config(&config) {
                Ok(_) => println!("Config is valid."),
                Err(e) => {
                    eprintln!("Config error: {}", e);
                    std::process::exit(1);
                }
            }
        }
        Command::Start { config, port, sidecar } => {
            run_server(config, port, GateMode::Production, sidecar, None).await;
        }
        Command::Dev { config, port, facilitator_url } => {
            run_server(config, port, GateMode::Dev, false, facilitator_url).await;
        }
        Command::Mock { config, port, facilitator_url } => {
            run_server(config, port, GateMode::Mock, false, facilitator_url).await;
        }
    }
}

async fn run_server(
    config_path: PathBuf,
    port: u16,
    mode: GateMode,
    _sidecar: bool,
    facilitator_url_override: Option<String>,
) {
    // Init tracing
    let subscriber = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"))
        );
    if mode == GateMode::Dev {
        subscriber.pretty().init();
    } else {
        subscriber.json().init();
    }

    let config = match load_config(&config_path) {
        Ok(c) => c,
        Err(e) => {
            tracing::error!("Config error: {}", e);
            std::process::exit(1);
        }
    };

    let matcher = match routes::RouteMatcher::new(&config) {
        Ok(m) => m,
        Err(e) => {
            tracing::error!("Route compilation error: {}", e);
            std::process::exit(1);
        }
    };

    let facilitator_url = facilitator_url_override
        .unwrap_or_else(|| config::facilitator_url(mode).to_string());
    let client = verify::build_client();

    // Build rate limiters
    let agent_limiter = rate_limit::build_agent_limiter(&config.rate_limits.per_agent);
    let verify_limiter = rate_limit::build_verify_limiter(&config.rate_limits.verification);

    let state = Arc::new(GateState {
        config: config.clone(),
        matcher,
        client,
        mode,
        facilitator_url,
        start_time: Instant::now(),
        chain_id: config::chain_id(mode),
    });

    let agent_limiter = Arc::clone(&agent_limiter);
    let verify_limiter = Arc::clone(&verify_limiter);

    // Periodic rate limit cleanup (every 5 minutes)
    let al = Arc::clone(&agent_limiter);
    let vl = Arc::clone(&verify_limiter);
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(300)).await;
            rate_limit::retain_recent(&al);
            rate_limit::retain_recent(&vl);
        }
    });

    // Testnet warning — loud and clear
    if mode != GateMode::Production {
        tracing::warn!("========================================================");
        tracing::warn!("  TESTNET MODE — payments use worthless test USDC.");
        tracing::warn!("  Use `pay-gate start` for production (mainnet).");
        tracing::warn!("========================================================");
    }

    // Start discovery heartbeat (P11) — sends on startup + every 1h
    heartbeat::spawn(
        verify::build_client(),
        state.facilitator_url.clone(),
        state.config.clone(),
        mode,
    );

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = TcpListener::bind(addr).await.expect("Failed to bind");
    let network_name = match mode {
        GateMode::Production => "mainnet (eip155:8453)",
        _ => "testnet (eip155:84532)",
    };
    tracing::info!(
        "pay-gate {} listening on {} (mode: {:?}, network: {}, origin: {})",
        "0.1.0", addr, mode, network_name, config.proxy.target
    );

    // Build hyper client for proxying
    let http_connector = hyper_util::client::legacy::connect::HttpConnector::new();
    let proxy_client = hyper_util::client::legacy::Client::builder(
        hyper_util::rt::TokioExecutor::new()
    ).build(http_connector);

    loop {
        let (stream, remote_addr) = match listener.accept().await {
            Ok(v) => v,
            Err(e) => {
                tracing::error!("Accept error: {}", e);
                continue;
            }
        };
        let io = TokioIo::new(stream);
        let state = Arc::clone(&state);
        let al = Arc::clone(&agent_limiter);
        let vl = Arc::clone(&verify_limiter);
        let proxy_client = proxy_client.clone();

        tokio::spawn(async move {
            let service = service_fn(move |req: Request<Incoming>| {
                let state = Arc::clone(&state);
                let al = Arc::clone(&al);
                let vl = Arc::clone(&vl);
                let proxy_client = proxy_client.clone();
                let remote_addr = remote_addr;

                async move {
                    dispatch(req, &state, &al, &vl, &proxy_client, remote_addr).await
                }
            });

            if let Err(e) = http1::Builder::new()
                .serve_connection(io, service)
                .await
            {
                if !e.to_string().contains("connection closed") {
                    tracing::error!("Connection error: {}", e);
                }
            }
        });
    }
}

async fn dispatch(
    req: Request<Incoming>,
    state: &GateState,
    agent_limiter: &rate_limit::KeyedLimiter,
    _verify_limiter: &rate_limit::KeyedLimiter,
    proxy_client: &hyper_util::client::legacy::Client<
        hyper_util::client::legacy::connect::HttpConnector,
        Incoming,
    >,
    remote_addr: SocketAddr,
) -> Result<Response<Full<Bytes>>, hyper::Error> {
    let path = req.uri().path().to_string();
    let method = req.method().clone();

    // Internal endpoints — not proxied, not rate limited
    if path == "/__pay/health" && method == hyper::Method::GET {
        return Ok(health::handle_health(state).await);
    }
    if path == "/__pay/manifest" && method == hyper::Method::GET {
        return Ok(manifest::handle_manifest(state));
    }
    if path == "/.well-known/x402" && method == hyper::Method::GET {
        return Ok(manifest::handle_well_known_x402(state));
    }
    if (path == "/__pay/check" || path.starts_with("/__pay/check/"))
        && (method == hyper::Method::POST || method == hyper::Method::GET)
    {
        return Ok(sidecar::handle_check(state, &req).await);
    }

    // CORS preflight — pass through
    if method == hyper::Method::OPTIONS {
        return Ok(Response::builder()
            .status(204)
            .body(Full::new(Bytes::new()))
            .unwrap());
    }

    // Rate limit check
    let ip = remote_addr.ip().to_string();
    if rate_limit::is_rate_limited(agent_limiter, &ip) {
        return Ok(error::GateError::RateLimited.into_response());
    }

    // Gate logic
    let decision = match gate::handle_request(state, &req).await {
        Ok(d) => d,
        Err(e) => return Ok(e.into_response()),
    };

    // If decision is a direct response (402, etc.), return it
    if let GateDecision::Respond(resp) = decision {
        return Ok(resp);
    }

    // Validate request against info block (query params + content-type, no body read)
    if let GateDecision::ProxyVerified {
        info: Some(ref info_val),
        ..
    } = decision
    {
        if let Some(err_resp) =
            validate::validate_request(req.uri(), req.headers(), info_val)
        {
            return Ok(err_resp);
        }
    }

    // Proxy to origin
    // NOTE: proxy.rs expects to consume the request with Incoming body.
    // For now, we create a simple forwarding approach.
    let origin = &state.config.proxy.target;
    match proxy_to_origin(proxy_client, origin, req, &decision).await {
        Ok(resp) => Ok(resp),
        Err(e) => {
            tracing::error!("Proxy error: {}", e);
            Ok(error::GateError::BadGateway(format!("Origin unreachable: {}", e)).into_response())
        }
    }
}

async fn proxy_to_origin(
    client: &hyper_util::client::legacy::Client<
        hyper_util::client::legacy::connect::HttpConnector,
        Incoming,
    >,
    origin: &str,
    mut req: Request<Incoming>,
    decision: &GateDecision,
) -> Result<Response<Full<Bytes>>, Box<dyn std::error::Error + Send + Sync>> {
    // Rewrite URI
    let orig_uri = req.uri().clone();
    let path_and_query = orig_uri.path_and_query()
        .map(|pq| pq.as_str())
        .unwrap_or("/");
    let target: hyper::Uri = format!("{}{}", origin, path_and_query).parse()?;
    *req.uri_mut() = target;

    // Fix headers
    req.headers_mut().remove("host");
    req.headers_mut().remove("payment-signature");

    // Inject gate headers
    match decision {
        GateDecision::ProxyFree => {}
        GateDecision::ProxyAllowlisted { agent } => {
            req.headers_mut().insert("x-pay-verified", "allowlisted".parse().unwrap());
            req.headers_mut().insert("x-pay-from", agent.parse().unwrap());
        }
        GateDecision::ProxyVerified { payer, amount, settlement, .. } => {
            req.headers_mut().insert("x-pay-verified", "true".parse().unwrap());
            req.headers_mut().insert("x-pay-amount", amount.parse().unwrap());
            req.headers_mut().insert("x-pay-settlement", settlement.parse().unwrap());
            if let Some(f) = payer {
                req.headers_mut().insert("x-pay-from", f.parse().unwrap());
            }
        }
        GateDecision::Respond(_) => unreachable!(),
    }

    let resp = client.request(req).await?;
    let (parts, body) = resp.into_parts();

    // Collect response body (for now; streaming optimization in Phase G2)
    let body_bytes = body.collect().await?.to_bytes();

    let mut final_resp = Response::from_parts(parts, Full::new(body_bytes));

    // Add v2 settlement response as PAYMENT-RESPONSE header
    if let GateDecision::ProxyVerified { ref receipt, .. } = decision {
        final_resp.headers_mut().insert("payment-response", receipt.parse().unwrap());
    }

    Ok(final_resp)
}
