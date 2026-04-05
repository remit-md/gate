/**
 * pay-gate acceptance tests — block mode.
 *
 * Requires gateway running with block.yaml config (default_action: block).
 * Gateway port via GATE_PORT env var (default 8403 to avoid conflict with main tests).
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  clearOriginRequests,
  resetFacilitator,
  decodePaymentRequired,
  assertStatus,
} from "../setup.js";

const BLOCK_GATE_PORT = parseInt(process.env["BLOCK_GATE_PORT"] || "8403", 10);
const BLOCK_GATE_URL = `http://localhost:${BLOCK_GATE_PORT}`;

async function blockGateRequest(path: string, options: RequestInit = {}): Promise<Response> {
  return fetch(`${BLOCK_GATE_URL}${path}`, options);
}

describe("pay-gate block mode", () => {
  beforeEach(async () => {
    await clearOriginRequests();
    await resetFacilitator();
  });

  it("blocks unmatched routes when default_action is block", async () => {
    const resp = await blockGateRequest("/some/unmatched/path");

    assertStatus(resp, 403);
    const body = await resp.json() as Record<string, unknown>;
    assert.equal(body["error"], "forbidden");
  });

  it("still allows paid routes in block mode", async () => {
    const resp = await blockGateRequest("/api/v1/premium/data");

    // Should still return 402 (route matched, just unpaid)
    assertStatus(resp, 402);
    const prHeader = resp.headers.get("payment-required");
    assert.ok(prHeader);
    const decoded = decodePaymentRequired(prHeader);
    assert.equal(decoded["x402Version"], 2);
    assert.ok(Array.isArray(decoded["accepts"]));
  });

  it("still allows free routes in block mode", async () => {
    const resp = await blockGateRequest("/api/v1/health");

    assertStatus(resp, 200);
    const body = await resp.json() as Record<string, unknown>;
    assert.equal(body["echo"], true);
  });
});
