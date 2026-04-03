# pay-gate — Dev Rules

## What This Is
x402 payment gateway. Stateless reverse proxy gating HTTP APIs via x402 payments using Pay as facilitator.

## Source of Truth
- Spec: `../spec/gate.md`
- Tracker: `../spec/TRACKER.md` under `## Gate`
- Dev guide: `../spec/guides/GATE.md`

## Two Codebases
- `rust/` — Rust binary (hyper 1.x, NOT Axum)
- `worker/` — CF Worker (Hono, TypeScript)
- `acceptance/` — Shared tests (TypeScript, runs against both)

## Key Constraints
- **No Axum** — hyper only for the proxy
- **No body buffering** — stream through
- **V2 only** — PAYMENT-REQUIRED/PAYMENT-SIGNATURE/PAYMENT-RESPONSE headers
- **Stateless** — no database, no local storage
- **One facilitator call** — POST /verify only, no /settle
- **Facilitator hardcoded** — pay-skill.com/x402 (mainnet), testnet.pay-skill.com/x402 (dev)
- **Functions <= 40 lines, CC <= 10, files <= 300 lines**

## No Local Forge
Never run `cargo build`/`cargo test` locally on Windows. Push to CI.

## Commits
No Co-Authored-By lines. Branch workflow: task/{id} branches.
