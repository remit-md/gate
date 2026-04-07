// k6 throughput benchmark for pay-gate.
//
// Prerequisites:
//   1. pay-gate running in mock mode:
//      cargo run -- mock -c pay-gate.yaml -p 8402
//   2. A simple origin server (e.g. the acceptance mock-origin):
//      node acceptance/mock-origin.ts
//   3. k6 installed: https://k6.io/docs/get-started/installation/
//
// Usage:
//   k6 run bench/k6-throughput.js
//   k6 run --vus 50 --duration 30s bench/k6-throughput.js
//
// What this measures:
//   - Free route throughput (pure proxy overhead)
//   - Paid route 402 generation throughput (no payment sig)
//   - Paid route with mock verification (payment sig present)

import http from "k6/http";
import { check, group } from "k6";
import { Rate, Trend } from "k6/metrics";

const BASE = __ENV.GATE_URL || "http://localhost:8402";

// Custom metrics
const freeLatency = new Trend("free_route_latency", true);
const paidNoSigLatency = new Trend("paid_402_latency", true);
const paidWithSigLatency = new Trend("paid_verified_latency", true);
const errorRate = new Rate("error_rate");

// A fake base64-encoded payment payload (mock mode accepts anything)
const MOCK_PAYMENT_SIG = "eyJhY2NlcHRlZCI6eyJuZXR3b3JrIjoiZWlwMTU1Ojg0NTMyIn19";

export const options = {
  scenarios: {
    free_routes: {
      executor: "constant-vus",
      vus: 10,
      duration: "15s",
      exec: "freeRoute",
    },
    paid_402: {
      executor: "constant-vus",
      vus: 10,
      duration: "15s",
      exec: "paid402",
      startTime: "16s",
    },
    paid_verified: {
      executor: "constant-vus",
      vus: 10,
      duration: "15s",
      exec: "paidVerified",
      startTime: "32s",
    },
  },
  thresholds: {
    free_route_latency: ["p(95)<50"],
    paid_402_latency: ["p(95)<50"],
    error_rate: ["rate<0.01"],
  },
};

export function freeRoute() {
  const res = http.get(`${BASE}/health`);
  freeLatency.add(res.timings.duration);
  const ok = check(res, {
    "free: status 200": (r) => r.status === 200,
  });
  if (!ok) errorRate.add(1);
  else errorRate.add(0);
}

export function paid402() {
  const res = http.get(`${BASE}/api/v1/weather?q=NYC`);
  paidNoSigLatency.add(res.timings.duration);
  const ok = check(res, {
    "paid: status 402": (r) => r.status === 402,
    "paid: has payment-required": (r) => r.headers["Payment-Required"] !== undefined,
  });
  if (!ok) errorRate.add(1);
  else errorRate.add(0);
}

export function paidVerified() {
  const res = http.get(`${BASE}/api/v1/weather?q=NYC`, {
    headers: {
      "Payment-Signature": MOCK_PAYMENT_SIG,
    },
  });
  paidWithSigLatency.add(res.timings.duration);
  const ok = check(res, {
    "verified: status 200": (r) => r.status === 200,
    "verified: has payment-response": (r) => r.headers["Payment-Response"] !== undefined,
  });
  if (!ok) errorRate.add(1);
  else errorRate.add(0);
}

export function handleSummary(data) {
  const fmt = (trend) => {
    if (!trend || !trend.values) return "N/A";
    const v = trend.values;
    return `avg=${v.avg.toFixed(2)}ms p95=${v["p(95)"].toFixed(2)}ms p99=${v["p(99)"].toFixed(2)}ms`;
  };

  const summary = [
    "=== pay-gate throughput benchmark ===",
    "",
    `Free route:     ${fmt(data.metrics.free_route_latency)}`,
    `Paid 402:       ${fmt(data.metrics.paid_402_latency)}`,
    `Paid verified:  ${fmt(data.metrics.paid_verified_latency)}`,
    "",
    `Total requests: ${data.metrics.http_reqs?.values?.count || 0}`,
    `Error rate:     ${((data.metrics.error_rate?.values?.rate || 0) * 100).toFixed(2)}%`,
    "",
  ].join("\n");

  return { stdout: summary };
}
