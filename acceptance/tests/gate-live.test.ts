/**
 * Live-facilitator acceptance test for pay-gate (P28-2.1).
 *
 * Exercises the full real path against Base Sepolia:
 *
 *     test wallet  --(wallet.openTab)-->  testnet.pay-skill.com/api/v1
 *     test wallet  --(wallet.chargeTab)--> testnet.pay-skill.com/api/v1
 *     test wallet  --(fetch + PAYMENT-SIGNATURE)-->  pay-gate (:8405)
 *     pay-gate     --(POST /verify)-->  testnet.pay-skill.com/x402
 *     pay-gate     -->  mock origin (:9090)
 *
 * NOTE: We cannot use wallet.request() end-to-end because SDK 0.2.3 has
 * two latent bugs that combine to make tab settlement impossible:
 *   1. balance() divides the server's dollar-formatted string by 1M (sdk#86 fixed but not published)
 *   2. parseTab reads raw.tab_id but list_tabs returns { id }, so settleViaTab
 *      looks up /tabs/undefined/charge (same bug Python had — fixed in sdk#77, TS not yet)
 *
 * Instead we call openTab + chargeTab explicitly (both accept direct
 * args, no listTabs), then construct the PAYMENT-SIGNATURE manually.
 *
 * Unlocks Q101-Q108 (PARTIAL -> YES) in spec/ACCEPTANCE_QUESTIONS.md.
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { Wallet } from "@pay-skill/sdk";

const LIVE_GATE_PORT = parseInt(process.env["LIVE_GATE_PORT"] || "8405", 10);
const LIVE_ORIGIN_PORT = parseInt(process.env["MOCK_ORIGIN_PORT"] || "9090", 10);
const LIVE_GATE_URL = `http://localhost:${LIVE_GATE_PORT}`;
const LIVE_ORIGIN_URL = `http://localhost:${LIVE_ORIGIN_PORT}`;

// Must match provider_address in acceptance/configs/live.yaml.
const LIVE_PROVIDER_ADDRESS = "0x1111111111111111111111111111111111111111";

const MINT_AMOUNT_USDC = 100;
const TAB_AMOUNT_USD = 5;
const TAB_MAX_CHARGE_USD = 0.01;

const testnetKey = process.env["PAYSKILL_TESTNET_KEY"];
const skip = !testnetKey;

function isMintRateLimited(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /rate.?limit|rate_limited|429|too many requests/i.test(msg);
}

describe(
  "pay-gate live facilitator (P28-2.1)",
  { skip },
  () => {
    let wallet: Wallet;
    let tabId: string;

    before(async () => {
      wallet = new Wallet({ privateKey: testnetKey as string, testnet: true });
      console.log(`  wallet:   ${wallet.address}`);
      console.log(`  gate:     ${LIVE_GATE_URL}`);
      console.log(`  provider: ${LIVE_PROVIDER_ADDRESS}`);

      // Fund. Swallow rate-limit (previous run already funded this hour).
      try {
        const r = await wallet.mint(MINT_AMOUNT_USDC);
        console.log(`  mint tx:  ${r.txHash}`);
      } catch (err) {
        if (!isMintRateLimited(err)) throw err;
        console.log(`  mint rate-limited -- funded by a previous run, proceeding`);
      }

      // Open a $5 tab. We accept leaking one tab per CI run because the
      // SDK's listTabs() is broken (parseTab reads raw.tab_id but the
      // server's list_tabs returns { id }). Tab auto-closes after 30 days.
      // With 100 USDC from mint, we can open ~19 tabs before exhaustion;
      // at 1 CI push/day that's ~19 days. Mint refills after 1 hour.
      //
      // Once the SDK publishes the parseTab fix (tab_id → id fallback),
      // the before() hook should listTabs, reuse an open tab, and only
      // openTab when none exists. TODO: revisit after SDK 0.2.4.
      console.log(`  opening $${TAB_AMOUNT_USD} tab with ${LIVE_PROVIDER_ADDRESS}`);
      const tab = await wallet.openTab(
        LIVE_PROVIDER_ADDRESS,
        TAB_AMOUNT_USD,
        TAB_MAX_CHARGE_USD,
      );
      tabId = tab.id;
      console.log(`  opened tab ${tabId}`);
    });

    it("unpaid request returns 402 with the configured provider as payTo", async () => {
      const resp = await fetch(`${LIVE_GATE_URL}/api/v1/premium/data`);
      assert.equal(resp.status, 402);

      const prHeader = resp.headers.get("payment-required");
      assert.ok(prHeader, "Missing PAYMENT-REQUIRED header");

      const decoded = JSON.parse(atob(prHeader)) as Record<string, unknown>;
      const accepts = decoded["accepts"] as Record<string, unknown>[];
      assert.ok(accepts.length > 0);

      const offer = accepts[0]!;
      assert.equal(
        (offer["payTo"] as string).toLowerCase(),
        LIVE_PROVIDER_ADDRESS.toLowerCase(),
      );
      assert.equal(offer["amount"], "10000"); // $0.01 micro-USDC

      const extra = offer["extra"] as Record<string, unknown>;
      assert.equal(extra["settlement"], "tab");
      assert.equal(extra["facilitator"], "https://testnet.pay-skill.com/x402");

      await resp.text(); // drain body
    });

    it("end-to-end tab-settled request against live facilitator", async () => {
      await fetch(`${LIVE_ORIGIN_URL}/__test/clear`);

      // Step 1: get 402 from gate to extract paymentRequirements
      const initial = await fetch(`${LIVE_GATE_URL}/api/v1/premium/data`);
      assert.equal(initial.status, 402);
      const prHeader = initial.headers.get("payment-required");
      assert.ok(prHeader);
      const decoded = JSON.parse(atob(prHeader)) as Record<string, unknown>;
      const offer = (decoded["accepts"] as Record<string, unknown>[])[0]!;
      await initial.text(); // drain

      // Step 2: charge the tab via server API (SDK method works — takes explicit tabId)
      const charge = await wallet.chargeTab(tabId, { micro: 10000 });
      assert.ok(charge.chargeId, "chargeTab should return a chargeId");

      // Step 3: construct PAYMENT-SIGNATURE manually (avoids SDK's broken settleViaTab)
      const paymentPayload = {
        x402Version: 2,
        accepted: {
          scheme: offer["scheme"],
          network: offer["network"],
          amount: offer["amount"],
          payTo: offer["payTo"],
        },
        payload: {
          authorization: { from: wallet.address },
        },
        extensions: {
          pay: {
            settlement: "tab",
            tabId,
            chargeId: charge.chargeId,
          },
        },
      };
      const sig = btoa(JSON.stringify(paymentPayload));

      // Step 4: retry gate request with signed payment
      const resp = await fetch(`${LIVE_GATE_URL}/api/v1/premium/data`, {
        headers: { "PAYMENT-SIGNATURE": sig },
      });
      assert.equal(
        resp.status,
        200,
        `expected 200 from gate, got ${resp.status} -- live facilitator rejected the payment`,
      );

      const body = (await resp.json()) as Record<string, unknown>;
      assert.equal(body["echo"], true);

      const headers = body["headers"] as Record<string, string | undefined>;
      assert.equal(headers["x-pay-verified"], "true");
      assert.equal(headers["x-pay-settlement"], "tab");
      assert.equal(headers["x-pay-amount"], "10000");

      // PAYMENT-RESPONSE: { success, network, payer }
      const prResp = resp.headers.get("payment-response");
      assert.ok(prResp, "Missing PAYMENT-RESPONSE header");
      const settlement = JSON.parse(atob(prResp)) as Record<string, unknown>;
      assert.equal(settlement["success"], true);
      assert.match(settlement["network"] as string, /^eip155:\d+$/);
      assert.equal(
        (settlement["payer"] as string).toLowerCase(),
        wallet.address.toLowerCase(),
      );

      // Origin should have received exactly one proxied request
      const recResp = await fetch(`${LIVE_ORIGIN_URL}/__test/requests`);
      const recorded = (await recResp.json()) as Array<{
        url: string;
        headers: Record<string, string | undefined>;
      }>;
      const gated = recorded.filter((r) => r.url === "/api/v1/premium/data");
      assert.equal(gated.length, 1, "Origin should see exactly one proxied request");
      assert.equal(gated[0]!.headers["x-pay-verified"], "true");
    });

    it("free route bypasses facilitator even on the live gate", async () => {
      await fetch(`${LIVE_ORIGIN_URL}/__test/clear`);

      const resp = await fetch(`${LIVE_GATE_URL}/api/v1/health`);
      assert.equal(resp.status, 200);

      const body = (await resp.json()) as Record<string, unknown>;
      assert.equal(body["echo"], true);

      const recResp = await fetch(`${LIVE_ORIGIN_URL}/__test/requests`);
      const recorded = (await recResp.json()) as Array<{
        url: string;
        headers: Record<string, string | undefined>;
      }>;
      const gated = recorded.filter((r) => r.url === "/api/v1/health");
      assert.equal(gated.length, 1);
      assert.equal(gated[0]!.headers["x-pay-verified"], undefined);
    });
  },
);
