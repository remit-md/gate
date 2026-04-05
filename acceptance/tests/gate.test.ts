/**
 * pay-gate acceptance tests — runs against both Rust binary and CF Worker.
 *
 * Prerequisites:
 *   1. Mock origin running on :9090 (mock-origin.ts)
 *   2. Mock facilitator running on :9091 (mock-facilitator.ts)
 *   3. Target gateway running on :8402 (Rust binary or CF Worker)
 *
 * Config expected (passthrough.yaml):
 *   - /api/v1/premium/* → $0.01, tab settlement
 *   - /api/v1/report (POST only) → $5.00, direct settlement
 *   - /api/v1/generate/* → dynamic pricing via price_endpoint
 *   - /api/v1/health → free
 *   - /api/v1/admin/* → free, allowlist: [0xaaaa...]
 *   - default_action: passthrough
 *   - fail_mode: closed
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  gateRequest,
  clearOriginRequests,
  getOriginRequests,
  setFacilitatorBehavior,
  resetFacilitator,
  getFacilitatorCallCount,
  setFacilitatorDown,
  decodePaymentRequired,
  encodePaymentSignature,
  getLastFacilitatorRequest,
  assertStatus,
} from "../setup.js";

/** Build a mock v2 PAYMENT-SIGNATURE header value. */
function mockPaymentSig(marker?: string): string {
  return encodePaymentSignature({
    x402Version: 2,
    accepted: { scheme: "exact", network: "eip155:84532", amount: "10000" },
    payload: { signature: marker || "0xmocksig" },
    extensions: {},
  });
}

describe("pay-gate acceptance", () => {
  beforeEach(async () => {
    await clearOriginRequests();
    await resetFacilitator();
  });

  // ── 1. Unpaid request → 402 ──────────────────────────────────
  it("returns 402 with v2 PAYMENT-REQUIRED header for unpaid request", async () => {
    const resp = await gateRequest("/api/v1/premium/data");

    assertStatus(resp, 402);
    const prHeader = resp.headers.get("payment-required");
    assert.ok(prHeader, "Missing PAYMENT-REQUIRED header");

    const decoded = decodePaymentRequired(prHeader);
    assert.equal(decoded["x402Version"], 2);
    assert.ok(Array.isArray(decoded["accepts"]));
    const accepts = decoded["accepts"] as Record<string, unknown>[];
    assert.ok(accepts.length > 0);

    const reqs = accepts[0]!;
    assert.equal(reqs["scheme"], "exact");
    assert.equal(reqs["amount"], "10000"); // $0.01 = 10000 micro-USDC
    assert.ok((reqs["network"] as string).startsWith("eip155:"));
    assert.ok((reqs["asset"] as string).startsWith("0x"));
    assert.ok(reqs["payTo"], "Missing 'payTo' field");
    assert.equal(typeof reqs["maxTimeoutSeconds"], "number");

    const extra = reqs["extra"] as Record<string, unknown>;
    assert.ok(extra);
    assert.equal(extra["settlement"], "tab");
    assert.ok((extra["facilitator"] as string).startsWith("http"));
    assert.equal(extra["name"], "USDC");

    const resource = decoded["resource"] as Record<string, unknown>;
    assert.ok(resource);
    assert.ok(resource["url"]);

    const body = await resp.json() as Record<string, unknown>;
    assert.equal(body["error"], "payment_required");
    assert.ok((body["message"] as string).includes("$0.01"));
  });

  // ── 2. Paid request (valid) → proxied ───────────────────────
  it("proxies valid paid request with X-Pay-* headers", async () => {
    await setFacilitatorBehavior({
      isValid: true,
      payer: "0xagent0000000000000000000000000000000001",
    });

    const resp = await gateRequest("/api/v1/premium/data", {
      headers: { "PAYMENT-SIGNATURE": mockPaymentSig() },
    });

    assertStatus(resp, 200);

    // PAYMENT-RESPONSE is now a base64-encoded v2 settlement response
    const prHeader = resp.headers.get("payment-response");
    assert.ok(prHeader, "Missing PAYMENT-RESPONSE header");
    const settlement = JSON.parse(atob(prHeader));
    assert.equal(settlement.success, true);
    assert.ok(settlement.network.startsWith("eip155:"));
    assert.equal(settlement.payer, "0xagent0000000000000000000000000000000001");

    // Verify origin received correct headers
    const reqs = await getOriginRequests() as Array<{ headers: Record<string, string> }>;
    assert.ok(reqs.length > 0, "Origin received no requests");
    const last = reqs[reqs.length - 1]!;
    assert.equal(last.headers["x-pay-verified"], "true");
    assert.equal(last.headers["x-pay-from"], "0xagent0000000000000000000000000000000001");
    assert.equal(last.headers["x-pay-amount"], "10000");
    assert.equal(last.headers["x-pay-settlement"], "tab");
  });

  // ── 3. Paid request (valid tab) → proxied with tab proof ────
  it("proxies tab-backed payment", async () => {
    await setFacilitatorBehavior({
      isValid: true,
      payer: "0xagent0000000000000000000000000000000002",
    });

    const tabSig = encodePaymentSignature({
      x402Version: 2,
      accepted: { scheme: "exact" },
      payload: {},
      extensions: { pay: { settlement: "tab", tabId: "tab_abc123", chargeId: "ch_1" } },
    });

    const resp = await gateRequest("/api/v1/premium/data", {
      headers: { "PAYMENT-SIGNATURE": tabSig },
    });

    assertStatus(resp, 200);

    // Verify facilitator received v2 format
    const verifyReq = await getLastFacilitatorRequest();
    assert.ok(verifyReq);
    assert.equal(verifyReq["x402Version"], 2);
    assert.ok(typeof verifyReq["paymentPayload"] === "object");
    const reqs = verifyReq["paymentRequirements"] as Record<string, unknown>;
    assert.ok((reqs["network"] as string).startsWith("eip155:"));
    assert.ok(reqs["payTo"]);
  });

  // ── 4. Paid request (invalid) → 402 with reason ──────────────
  it("returns 402 with reason for invalid payment", async () => {
    await setFacilitatorBehavior({
      isValid: false,
      invalidReason: "insufficient_balance",
    });

    const resp = await gateRequest("/api/v1/premium/data", {
      headers: { "PAYMENT-SIGNATURE": mockPaymentSig() },
    });

    assertStatus(resp, 402);
    const body = await resp.json() as Record<string, unknown>;
    assert.equal(body["reason"], "insufficient_balance");
  });

  // ── 5. Free route → proxied without payment ──────────────────
  it("proxies free route without payment check", async () => {
    const countBefore = await getFacilitatorCallCount();
    const resp = await gateRequest("/api/v1/health");

    assertStatus(resp, 200);
    const body = await resp.json() as Record<string, unknown>;
    assert.equal(body["echo"], true);

    // Verify facilitator was NOT called
    const countAfter = await getFacilitatorCallCount();
    assert.equal(countAfter, countBefore, "Facilitator should not be called for free routes");
  });

  // ── 6. Allowlisted agent → proxied without payment ───────────
  it("proxies allowlisted agent without payment", async () => {
    const resp = await gateRequest("/api/v1/admin/settings", {
      headers: { "X-Pay-Agent": "0xaaaa000000000000000000000000000000000000" },
    });

    assertStatus(resp, 200);

    const reqs = await getOriginRequests() as Array<{ headers: Record<string, string> }>;
    const last = reqs[reqs.length - 1]!;
    assert.equal(last.headers["x-pay-verified"], "allowlisted");
  });

  // ── 7. Dynamic pricing → correct amount in 402 ───────────────
  it("uses dynamic pricing endpoint for 402 amount", async () => {
    const resp = await gateRequest("/api/v1/generate/image");

    assertStatus(resp, 402);
    const prHeader = resp.headers.get("payment-required");
    assert.ok(prHeader);
    const decoded = decodePaymentRequired(prHeader);
    const accepts = decoded["accepts"] as Record<string, unknown>[];
    assert.equal(accepts[0]!["amount"], "50000"); // $0.05 = 50000 micro-USDC
  });

  // ── 8. Rate limited → 429 ────────────────────────────────────
  it("returns 429 when rate limited", async () => {
    // Test config has per_agent: 50/s — send rapid requests until 429
    let got429 = false;
    for (let i = 0; i < 200; i++) {
      const resp = await gateRequest("/api/v1/premium/data");
      if (resp.status === 429) {
        got429 = true;
        break;
      }
      await resp.text();
    }
    assert.ok(got429, "Expected 429 within 200 requests (rate limit: 50/s)");
  });

  // ── 9. Facilitator down + fail_mode closed → 503 ─────────────
  it("returns 503 when facilitator is down and fail_mode is closed", async () => {
    await setFacilitatorDown();

    const resp = await gateRequest("/api/v1/premium/data", {
      headers: { "PAYMENT-SIGNATURE": mockPaymentSig() },
    });

    assertStatus(resp, 503);
    const body = await resp.json() as Record<string, unknown>;
    assert.equal(body["error"], "service_unavailable");
  });

  // ── 10. Health endpoint → 200 ────────────────────────────────
  it("health endpoint returns 200 with status", async () => {
    const resp = await gateRequest("/__pay/health");

    assertStatus(resp, 200);
    const body = await resp.json() as Record<string, unknown>;
    assert.ok(body["status"]);
    assert.ok(body["version"]);
    assert.ok("facilitator" in body);
  });

  // ── 11. Sidecar mode → same behavior via /__pay/check ────────
  it("sidecar check returns 402 for unpaid request", async () => {
    const resp = await gateRequest("/__pay/check", {
      method: "POST",
      headers: {
        "X-Original-URI": "/api/v1/premium/data",
        "X-Original-Method": "GET",
      },
    });

    assertStatus(resp, 402);
    const prHeader = resp.headers.get("payment-required");
    assert.ok(prHeader);
    const decoded = decodePaymentRequired(prHeader);
    assert.equal(decoded["x402Version"], 2);
  });

  it("sidecar check returns 200 for free route", async () => {
    const resp = await gateRequest("/__pay/check", {
      method: "POST",
      headers: {
        "X-Original-URI": "/api/v1/health",
        "X-Original-Method": "GET",
      },
    });

    assertStatus(resp, 200);
    assert.equal(resp.headers.get("x-pay-verified"), "free");
  });

  // ── 12. Browser request → HTML 402 page ──────────────────────
  it("returns HTML 402 for Accept: text/html", async () => {
    const resp = await gateRequest("/api/v1/premium/data", {
      headers: { Accept: "text/html" },
    });

    assertStatus(resp, 402);
    const contentType = resp.headers.get("content-type") || "";
    assert.ok(contentType.includes("text/html"), `Expected HTML, got ${contentType}`);

    const body = await resp.text();
    assert.ok(body.includes("Payment Required"));
    assert.ok(body.includes("$0.01"));
    assert.ok(body.includes("pay-skill.com/gate"));
  });

  // ── 13. Unmatched route + passthrough → proxied ───────────────
  it("passes through unmatched routes when default_action is passthrough", async () => {
    const resp = await gateRequest("/some/unmatched/path");

    assertStatus(resp, 200);
    const body = await resp.json() as Record<string, unknown>;
    assert.equal(body["echo"], true);
  });

  // ── 14. Method-specific routes ────────────────────────────────
  it("method-specific route only matches specified method", async () => {
    // POST /api/v1/report → 402 (paid, $5.00, direct)
    const postResp = await gateRequest("/api/v1/report", { method: "POST" });
    assertStatus(postResp, 402);
    const prHeader = postResp.headers.get("payment-required");
    assert.ok(prHeader);
    const decoded = decodePaymentRequired(prHeader);
    const accepts = decoded["accepts"] as Record<string, unknown>[];
    assert.equal(accepts[0]!["amount"], "5000000"); // $5.00
    const extra = accepts[0]!["extra"] as Record<string, unknown>;
    assert.equal(extra["settlement"], "direct");

    // GET /api/v1/report → passthrough (no route match)
    const getResp = await gateRequest("/api/v1/report", { method: "GET" });
    assertStatus(getResp, 200);
  });

  // ── Additional: CORS preflight passes through ─────────────────
  it("OPTIONS requests pass through without payment", async () => {
    const resp = await gateRequest("/api/v1/premium/data", {
      method: "OPTIONS",
    });
    assert.ok(resp.status === 200 || resp.status === 204);
  });

  // ── Additional: payment-signature not forwarded to origin ─────
  it("strips PAYMENT-SIGNATURE header from proxied requests", async () => {
    await setFacilitatorBehavior({
      isValid: true,
      payer: "0xagent0000000000000000000000000000000003",
    });

    await gateRequest("/api/v1/premium/data", {
      headers: { "PAYMENT-SIGNATURE": mockPaymentSig() },
    });

    const reqs = await getOriginRequests() as Array<{ headers: Record<string, string> }>;
    const last = reqs[reqs.length - 1]!;
    assert.equal(last.headers["payment-signature"], undefined,
      "PAYMENT-SIGNATURE should not be forwarded to origin");
  });

  // ── Additional: PAYMENT-RESPONSE header on proxied response ──
  it("adds v2 PAYMENT-RESPONSE header to successful paid response", async () => {
    await setFacilitatorBehavior({
      isValid: true,
      payer: "0xagent0000000000000000000000000000000004",
    });

    const resp = await gateRequest("/api/v1/premium/data", {
      headers: { "PAYMENT-SIGNATURE": mockPaymentSig() },
    });

    assertStatus(resp, 200);
    const prHeader = resp.headers.get("payment-response");
    assert.ok(prHeader, "Missing PAYMENT-RESPONSE header");
    const settlement = JSON.parse(atob(prHeader));
    assert.equal(settlement.success, true);
    assert.ok(settlement.network.startsWith("eip155:"));
    assert.equal(settlement.payer, "0xagent0000000000000000000000000000000004");
  });

  // ── Verify request format check ──────────────────────────────
  it("sends v2 format to facilitator /verify", async () => {
    await setFacilitatorBehavior({
      isValid: true,
      payer: "0xagent0000000000000000000000000000000005",
    });

    await gateRequest("/api/v1/premium/data", {
      headers: { "PAYMENT-SIGNATURE": mockPaymentSig("0xtest-verify-format") },
    });

    const verifyReq = await getLastFacilitatorRequest();
    assert.ok(verifyReq, "No verify request recorded");
    assert.equal(verifyReq["x402Version"], 2);
    assert.ok(typeof verifyReq["paymentPayload"] === "object");
    const reqs = verifyReq["paymentRequirements"] as Record<string, unknown>;
    assert.ok(reqs);
    assert.ok((reqs["network"] as string).startsWith("eip155:"));
    assert.ok(reqs["payTo"]);
    assert.ok(reqs["asset"]);
    assert.equal(reqs["scheme"], "exact");
  });
});
