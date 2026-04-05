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

  it("accepts[0].extra.facilitator is a valid URL", async () => {
    const resp = await gateRequest("/api/v1/premium/data");
    assertStatus(resp, 402);
    const decoded = decodePaymentRequired(resp.headers.get("payment-required")!);
    const reqs = (decoded["accepts"] as Record<string, unknown>[])[0]!;
    const extra = reqs["extra"] as Record<string, unknown>;
    assert.ok((extra["facilitator"] as string).startsWith("http"));
  });

  it("accepts[0].extra.name is 'USDC'", async () => {
    const resp = await gateRequest("/api/v1/premium/data");
    assertStatus(resp, 402);
    const decoded = decodePaymentRequired(resp.headers.get("payment-required")!);
    const reqs = (decoded["accepts"] as Record<string, unknown>[])[0]!;
    const extra = reqs["extra"] as Record<string, unknown>;
    assert.equal(extra["name"], "USDC");
  });

  it("resource.url contains the requested path", async () => {
    const resp = await gateRequest("/api/v1/premium/data");
    assertStatus(resp, 402);
    const decoded = decodePaymentRequired(resp.headers.get("payment-required")!);
    const resource = decoded["resource"] as Record<string, unknown>;
    assert.ok((resource["url"] as string).includes("/api/v1/premium/data"));
  });

  it("resource.mimeType is 'application/json'", async () => {
    const resp = await gateRequest("/api/v1/premium/data");
    assertStatus(resp, 402);
    const decoded = decodePaymentRequired(resp.headers.get("payment-required")!);
    const resource = decoded["resource"] as Record<string, unknown>;
    assert.equal(resource["mimeType"], "application/json");
  });

  it("extensions is a plain object", async () => {
    const resp = await gateRequest("/api/v1/premium/data");
    assertStatus(resp, 402);
    const decoded = decodePaymentRequired(resp.headers.get("payment-required")!);
    assert.ok(typeof decoded["extensions"] === "object");
    assert.ok(!Array.isArray(decoded["extensions"]));
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
