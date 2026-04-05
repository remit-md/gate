/**
 * pay-gate acceptance tests — fail-open mode.
 *
 * Requires gateway running with fail-open.yaml config (fail_mode: open).
 * Gateway port via FAILOPEN_GATE_PORT env var (default 8404).
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  clearOriginRequests,
  getOriginRequests,
  resetFacilitator,
  setFacilitatorDown,
  encodePaymentSignature,
  assertStatus,
} from "../setup.js";

const FAILOPEN_GATE_PORT = parseInt(process.env["FAILOPEN_GATE_PORT"] || "8404", 10);
const FAILOPEN_GATE_URL = `http://localhost:${FAILOPEN_GATE_PORT}`;

async function failopenGateRequest(path: string, options: RequestInit = {}): Promise<Response> {
  return fetch(`${FAILOPEN_GATE_URL}${path}`, options);
}

describe("pay-gate fail-open mode", () => {
  beforeEach(async () => {
    await clearOriginRequests();
    await resetFacilitator();
  });

  it("proxies through when facilitator is down and fail_mode is open", async () => {
    await setFacilitatorDown();

    const sig = encodePaymentSignature({
      x402Version: 2,
      accepted: { scheme: "exact" },
      payload: { signature: "0xfailopen" },
      extensions: {},
    });
    const resp = await failopenGateRequest("/api/v1/premium/data", {
      headers: { "PAYMENT-SIGNATURE": sig },
    });

    // fail_mode=open → proxy to origin unpaid
    assertStatus(resp, 200);
    const body = await resp.json() as Record<string, unknown>;
    assert.equal(body["echo"], true);

    // Verify origin received the request
    const reqs = await getOriginRequests() as Array<{ headers: Record<string, string> }>;
    assert.ok(reqs.length > 0, "Origin should have received the request");
  });
});
