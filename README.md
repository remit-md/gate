# pay-gate

Drop-in x402 payment gateway for any HTTP API. Deploy in front of your service, define pricing per route, and every request is gated via x402 with [Pay](https://pay-skill.com) as the facilitator.

```
Agent ──> pay-gate ──> Your API
             |
       pay-skill.com/x402
```

## Quick Start

### Cloudflare Worker

```bash
npm create pay-gate my-api-gate
cd my-api-gate
# Edit wrangler.toml: set PROVIDER_ADDRESS, PROXY_TARGET
# Create KV namespace: npx wrangler kv namespace create ROUTES
# Upload routes: npx wrangler kv bulk put routes.json --namespace-id <id>
npx wrangler deploy
```

### Rust Binary

```bash
cargo install pay-gate
pay-gate init          # generates pay-gate.yaml
# Edit pay-gate.yaml: set provider_address, proxy.target, routes
pay-gate start         # production (mainnet facilitator)
pay-gate dev           # development (testnet facilitator, verbose logs)
```

### Docker

```bash
docker run -v ./pay-gate.yaml:/etc/pay-gate/config.yaml -p 8402:8402 payskill/gate
```

### Sidecar (nginx, traefik, envoy, caddy)

```bash
pay-gate start --sidecar
# Configure your reverse proxy to subrequest http://127.0.0.1:8402/__pay/check
```

See `examples/` for proxy-specific configs.

### Sidecar Notes

All five sidecar configs are tested end-to-end with live x402 payment flows.

| Proxy | File | Notes |
|-------|------|-------|
| **nginx** | `nginx.conf` + `gate.js` | Requires njs module (`load_module modules/ngx_http_js_module.so`). Stock `auth_request` cannot forward 402. Add `subrequest_output_buffer_size 256k` for large API responses. |
| **OpenResty** | `openresty.conf` | Lua `access_by_lua_block`. Works on all platforms including Windows (njs does not). |
| **Traefik** | `traefik.yml` | `forwardAuth` handles 402 natively. Sends `X-Forwarded-Uri` (not `X-Original-URI`). |
| **Caddy** | `Caddyfile` | `forward_auth` handles 402 natively. Use `copy_headers` for `Payment-Signature` (not `header_up`, which sends empty values). |
| **Envoy** | `envoy.yml` | `ext_authz` with `path_prefix`. Requires `allowed_client_headers` for `payment-required` header passthrough. |

## Configuration

### Minimal

```yaml
version: 1
provider_address: "0x..."
proxy:
  target: "http://localhost:8080"
routes:
  - path: "/api/v1/*"
    price: "0.01"
```

### Full

```yaml
version: 1
provider_address: "0x..."

proxy:
  target: "http://localhost:8080"
  timeout: "30s"

routes:
  - path: "/api/v1/premium/*"
    price: "0.01"                    # $0.01/call, tab settlement (default for <=1)
  - path: "/api/v1/report"
    method: "POST"
    price: "5.00"
    settlement: "direct"             # on-chain per call (default for >$1)
  - path: "/api/v1/generate/*"
    price_endpoint: "http://localhost:8080/internal/pricing"
  - path: "/api/v1/health"
    free: true
  - path: "/api/v1/admin/*"
    free: true
    allowlist: ["0xaaaa..."]
  - path: "/weather"
    price: "0.01"
    proxy_rewrite: "/v1/forecast.json"   # CF Worker only: rewrite path to origin
    proxy_params:                         # CF Worker only: inject default query params
      key: "your-api-key"
      days: "3"

default_action: "passthrough"        # or "block" for unmatched routes
fail_mode: "closed"                  # "closed" = 503 if facilitator down, "open" = pass through

rate_limits:
  per_agent: "1000/min"
  verification: "100/s"

log:
  level: "info"
  format: "json"
```

### Environment Overrides

```
PAY_GATE_PROVIDER_ADDRESS=0x...
PAY_GATE_PROXY_TARGET=http://localhost:8080
PAY_GATE_DEFAULT_ACTION=passthrough
PAY_GATE_FAIL_MODE=closed
PAY_GATE_LOG_LEVEL=info
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `pay-gate start` | Production mode (mainnet facilitator) |
| `pay-gate dev` | Dev mode (testnet, verbose logs) |
| `pay-gate mock` | Mock mode (accepts all payments, no verification) |
| `pay-gate start --sidecar` | Sidecar mode for nginx/traefik/envoy/caddy |
| `pay-gate validate` | Check config without starting |
| `pay-gate init` | Generate starter config |
| `pay-gate version` | Print version |

## How It Works

### Unpaid request

```
GET /api/v1/premium/data → 402 Payment Required
  PAYMENT-REQUIRED: base64({ scheme: "exact", amount: "10000", settlement: "tab", ... })
```

### Paid request

```
GET /api/v1/premium/data
  PAYMENT-SIGNATURE: <x402 proof>
→ pay-gate calls POST pay-skill.com/x402/verify
→ { valid: true }
→ proxy to origin with X-Pay-Verified, X-Pay-From, X-Pay-Amount headers
```

### Origin headers

| Header | Value |
|--------|-------|
| `X-Pay-Verified` | `true` or `allowlisted` |
| `X-Pay-From` | Agent wallet `0x...` |
| `X-Pay-Amount` | Micro-USDC amount |
| `X-Pay-Settlement` | `direct` or `tab` |
| `X-Pay-Tab` | Tab ID (tab-backed only) |

## x402 Protocol

pay-gate implements x402 V2 exclusively.

| Header | Direction | Purpose |
|--------|-----------|---------|
| `PAYMENT-REQUIRED` | gateway -> agent | Payment requirements (base64 JSON, in 402) |
| `PAYMENT-SIGNATURE` | agent -> gateway | Payment proof (in retry) |
| `PAYMENT-RESPONSE` | gateway -> agent | Settlement receipt (in proxied response) |

Any x402 V2 agent SDK works for direct settlement. Tab settlement requires the Pay SDK.

## Settlement Modes

| Price | Default | Reason |
|-------|---------|--------|
| <= $1 | `tab` | Micropayments. Gas per call would exceed the price. |
| > $1 | `direct` | High-value. Immediate on-chain settlement. |

Override per route with `settlement: "direct"` or `settlement: "tab"`.

## Architecture

- **Stateless.** No database, no sessions, no local storage. All payment state in the facilitator.
- **One facilitator call per paid request.** POST /verify only (no /settle). Settlement is async.
- **Facilitator hardcoded.** `pay-skill.com/x402` (mainnet) or `testnet.pay-skill.com/x402` (dev).

## License

BSL-1.1 (converts to Apache-2.0 on 2036-04-03).
