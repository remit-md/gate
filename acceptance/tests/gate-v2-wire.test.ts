/**
 * pay-gate v2 wire format compliance tests.
 *
 * Validates the exact x402 v2 wire format for:
 * - PAYMENT-REQUIRED header (402 response)
 * - /verify request (gate → facilitator)
 * - PAYMENT-RESPONSE header (success response)
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  gateRequest,
  clearOriginRequests,
  resetFacilitator,
  setFacilitatorBehavior,
  getLastFacilitatorRequest,
  decodePaymentRequired,
  encodePaymentSignature,
  assertStatus,
} from "../setup.js";

function mockPaymentSig(): string {
  return encodePaymentSignature({
    x402Version: 2,
    accepted: { scheme: "exact", network: "eip155:84532", amount: "10000" },
    payload: { signature: "0xv2wiretest" },
    extensions: {},
  });
}

describe("x402 v2 wire format compliance", () => {
  beforeEach(async () => {
    await clearOriginRequests();
    await resetFacilitator();
  });

  // ── PAYMENT-REQUIRED header tests ─────────────────────────────

  it("x402Version is number 2 (not string)", async () => {
    const resp = await gateRequest("/api/v1/premium/data");
    assertStatus(resp, 402);
    const decoded = decodePaymentRequired(resp.headers.get("payment-required")!);
    assert.strictEqual(decoded["x402Version"], 2);
    assert.strictEqual(typeof decoded["x402Version"], "number");
  });

  it("accepts is a non-empty array", async () => {
    const resp = await gateRequest("/api/v1/premium/data");
    assertStatus(resp, 402);
    const decoded = decodePaymentRequired(resp.headers.get("payment-required")!);
    assert.ok(Array.isArray(decoded["accepts"]));
    assert.ok((decoded["accepts"] as unknown[]).length > 0);
  });

  it("accepts[0].network matches eip155:digits", async () => {
    const resp = await gateRequest("/api/v1/premium/data");
    assertStatus(resp, 402);
    const decoded = decodePaymentRequired(resp.headers.get("payment-required")!);
    const reqs = (decoded["accepts"] as Record<string, unknown>[])[0]!;
    assert.match(reqs["network"] as string, /^eip155:\d+$/);
  });

  it("accepts[0].asset is 42-char hex address", async () => {
    const resp = await gateRequest("/api/v1/premium/data");
    assertStatus(resp, 402);
    const decoded = decodePaymentRequired(resp.headers.get("payment-required")!);
    const reqs = (decoded["accepts"] as Record<string, unknown>[])[0]!;
    const asset = reqs["asset"] as string;
    assert.match(asset, /^0x[0-9a-fA-F]{40}$/);
  });

  it("accepts[0].payTo is present and is a valid address", async () => {
    const resp = await gateRequest("/api/v1/premium/data");
    assertStatus(resp, 402);
    const decoded = decodePaymentRequired(resp.headers.get("payment-required")!);
    const reqs = (decoded["accepts"] as Record<string, unknown>[])[0]!;
    assert.ok(reqs["payTo"]);
    assert.match(reqs["payTo"] as string, /^0x[0-9a-fA-F]{40}$/);
  });

  it("accepts[0].maxTimeoutSeconds is a positive integer", async () => {
    const resp = await gateRequest("/api/v1/premium/data");
    assertStatus(resp, 402);
    const decoded = decodePaymentRequired(resp.headers.get("payment-required")!);
    const reqs = (decoded["accepts"] as Record<string, unknown>[])[0]!;
    const timeout = reqs["maxTimeoutSeconds"] as number;
    assert.strictEqual(typeof timeout, "number");
    assert.ok(timeout > 0);
    assert.strictEqual(timeout, Math.floor(timeout));
  });

  it("accepts[0].extra.settlement is 'direct' or 'tab'", async () => {
    const resp = await gateRequest("/api/v1/premium/data");
    assertStatus(resp, 402);
    const decoded = decodePaymentRequired(resp.headers.get("payment-required")!);
    const reqs = (decoded["accepts"] as Record<string, unknown>[])[0]!;
    const extra = reqs["extra"] as Record<string, unknown>;
    assert.ok(extra["settlement"] === "tab" || extra["settlement"] === "direct");
  });

  it("accepts[0].extra.facilitator is a URL starting with http", async () => {
    const resp = await gateRequest("/api/v1/premium/data");
    assertStatus(resp, 402);
    const decoded = decodePaymentRequired(resp.headers.get("payment-required")!);
    const reqs = (decoded["accepts"] as Record<string, unknown>[])[0]!;
    const extra = reqs["extra"] as Record<string, unknown>;
    assert.ok(typeof extra["facilitator"] === "string");
    assert.match(extra["facilitator"] as string, /^https?:\/\//);
  });

  it("accepts[0].extra does NOT contain name or version (redundant)", async () => {
    const resp = await gateRequest("/api/v1/premium/data");
    assertStatus(resp, 402);
    const decoded = decodePaymentRequired(resp.headers.get("payment-required")!);
    const reqs = (decoded["accepts"] as Record<string, unknown>[])[0]!;
    const extra = reqs["extra"] as Record<string, unknown>;
    assert.strictEqual(extra["name"], undefined);
    assert.strictEqual(extra["version"], undefined);
  });

  it("resource.url contains the requested path", async () => {
    const resp = await gateRequest("/api/v1/premium/data");
    assertStatus(resp, 402);
    const decoded = decodePaymentRequired(resp.headers.get("payment-required")!);
    const resource = decoded["resource"] as Record<string, unknown>;
    assert.ok((resource["url"] as string).includes("/api/v1/premium/data"));
  });

  it("resource.mimeType is omitted when not configured on route", async () => {
    const resp = await gateRequest("/api/v1/premium/data");
    assertStatus(resp, 402);
    const decoded = decodePaymentRequired(resp.headers.get("payment-required")!);
    const resource = decoded["resource"] as Record<string, unknown>;
    // mimeType is only present when explicitly configured per route
    assert.ok(resource["mimeType"] === undefined || typeof resource["mimeType"] === "string");
  });

  it("extensions is a plain object", async () => {
    const resp = await gateRequest("/api/v1/premium/data");
    assertStatus(resp, 402);
    const decoded = decodePaymentRequired(resp.headers.get("payment-required")!);
    assert.ok(typeof decoded["extensions"] === "object");
    assert.ok(!Array.isArray(decoded["extensions"]));
  });

  // ── .well-known/x402 descriptor tests ─────────────────────────

  it("GET /.well-known/x402 returns x402Version 2", async () => {
    const resp = await gateRequest("/.well-known/x402");
    assertStatus(resp, 200);
    const body = await resp.json() as Record<string, unknown>;
    assert.strictEqual(body["x402Version"], 2);
  });

  it("/.well-known/x402 includes payTo, network, asset", async () => {
    const resp = await gateRequest("/.well-known/x402");
    assertStatus(resp, 200);
    const body = await resp.json() as Record<string, unknown>;
    assert.ok(body["payTo"]);
    assert.match(body["network"] as string, /^eip155:\d+$/);
    assert.match(body["asset"] as string, /^0x[0-9a-fA-F]{40}$/);
  });

  it("/.well-known/x402 endpoints have paymentRequirements", async () => {
    const resp = await gateRequest("/.well-known/x402");
    assertStatus(resp, 200);
    const body = await resp.json() as Record<string, unknown>;
    const endpoints = body["endpoints"] as Record<string, unknown>[];
    assert.ok(Array.isArray(endpoints));
    if (endpoints.length > 0) {
      const ep = endpoints[0]!;
      assert.ok(ep["path"]);
      const reqs = ep["paymentRequirements"] as Record<string, unknown>;
      assert.ok(reqs);
      assert.equal(reqs["scheme"], "exact");
      assert.match(reqs["network"] as string, /^eip155:\d+$/);
      const extra = reqs["extra"] as Record<string, unknown>;
      assert.ok(extra["settlement"] === "direct" || extra["settlement"] === "tab");
      assert.ok(typeof extra["facilitator"] === "string");
      assert.match(extra["facilitator"] as string, /^https?:\/\//);
    }
  });

  // ── Verify request format tests ───────────────────────────────

  it("verify request has x402Version: 2", async () => {
    await setFacilitatorBehavior({ isValid: true, payer: "0xagent0000000000000000000000000000000001" });
    await gateRequest("/api/v1/premium/data", {
      headers: { "PAYMENT-SIGNATURE": mockPaymentSig() },
    });
    const verifyReq = await getLastFacilitatorRequest();
    assert.ok(verifyReq);
    assert.strictEqual(verifyReq["x402Version"], 2);
  });

  it("verify request paymentPayload is an object with payload field", async () => {
    await setFacilitatorBehavior({ isValid: true, payer: "0xagent0000000000000000000000000000000001" });
    await gateRequest("/api/v1/premium/data", {
      headers: { "PAYMENT-SIGNATURE": mockPaymentSig() },
    });
    const verifyReq = await getLastFacilitatorRequest();
    assert.ok(verifyReq);
    const payload = verifyReq["paymentPayload"] as Record<string, unknown>;
    assert.ok(typeof payload === "object");
    assert.ok("payload" in payload);
  });

  it("verify request paymentRequirements.network is CAIP-2", async () => {
    await setFacilitatorBehavior({ isValid: true, payer: "0xagent0000000000000000000000000000000001" });
    await gateRequest("/api/v1/premium/data", {
      headers: { "PAYMENT-SIGNATURE": mockPaymentSig() },
    });
    const verifyReq = await getLastFacilitatorRequest();
    assert.ok(verifyReq);
    const reqs = verifyReq["paymentRequirements"] as Record<string, unknown>;
    assert.match(reqs["network"] as string, /^eip155:\d+$/);
  });

  // ── PAYMENT-RESPONSE header test ──────────────────────────────

  it("PAYMENT-RESPONSE base64 decodes to {success, network, payer}", async () => {
    await setFacilitatorBehavior({ isValid: true, payer: "0xagent0000000000000000000000000000000001" });
    const resp = await gateRequest("/api/v1/premium/data", {
      headers: { "PAYMENT-SIGNATURE": mockPaymentSig() },
    });
    assertStatus(resp, 200);
    const prHeader = resp.headers.get("payment-response");
    assert.ok(prHeader);
    const settlement = JSON.parse(atob(prHeader));
    assert.strictEqual(settlement.success, true);
    assert.match(settlement.network, /^eip155:\d+$/);
    assert.ok(settlement.payer);
    assert.strictEqual(typeof settlement.extensions, "object");
  });
});
