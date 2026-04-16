/**
 * Live-facilitator acceptance test for pay-gate (P28-2.1).
 *
 * Unlike gate.test.ts (which uses a mock facilitator on :9091 for speed),
 * this test exercises the full real path against Base Sepolia:
 *
 *     test wallet
 *         |
 *         |  wallet.request(gateUrl/api/v1/premium/data)
 *         v
 *     pay-gate (dev mode, :8405, acceptance/configs/live.yaml)
 *         |
 *         |  POST /verify
 *         v
 *     testnet.pay-skill.com/x402  (real facilitator)
 *         |
 *         |  tab + charge lookup against real PostgreSQL
 *         v
 *     pay-gate  ->  mock origin (:9090)
 *
 * Proves:
 *   - Gate serves 402 with the configured provider as payTo
 *   - Gate forwards PAYMENT-SIGNATURE to testnet.pay-skill.com/x402/verify
 *   - Facilitator validates a real tab_id + charge_id created via the
 *     server's /tabs and /tabs/{id}/charge endpoints
 *   - Gate proxies to the mock origin with X-Pay-* headers injected
 *
 * Unlocks Q101-Q108 (PARTIAL -> YES) in spec/ACCEPTANCE_QUESTIONS.md.
 *
 * Requires PAYSKILL_TESTNET_KEY env var with a funded Base Sepolia
 * private key. Without it, the whole describe block is skipped so the
 * file can still be compiled + ignored locally without a testnet key.
 * CI should set the secret; see acceptance.yml for the bash preflight.
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { Wallet, type Tab } from "@pay-skill/sdk";

const LIVE_GATE_PORT = parseInt(process.env["LIVE_GATE_PORT"] || "8405", 10);
const LIVE_ORIGIN_PORT = parseInt(process.env["MOCK_ORIGIN_PORT"] || "9090", 10);
const LIVE_GATE_URL = `http://localhost:${LIVE_GATE_PORT}`;
const LIVE_ORIGIN_URL = `http://localhost:${LIVE_ORIGIN_PORT}`;

// Must match provider_address in acceptance/configs/live.yaml.
const LIVE_PROVIDER_ADDRESS = "0x1111111111111111111111111111111111111111";

// USDC amount requested from the server's /mint endpoint at startup.
const MINT_AMOUNT_USDC = 100;

// Balance floor under which we proactively recycle the tab.
const STALE_TAB_FLOOR_USD = 1;

const testnetKey = process.env["PAYSKILL_TESTNET_KEY"];
const skip = !testnetKey;

/** True if the error looks like a /mint 1/wallet/hour rate-limit response. */
function isMintRateLimited(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /rate.?limit|rate_limited|429|too many requests/i.test(msg);
}

describe(
  "pay-gate live facilitator (P28-2.1)",
  { skip },
  () => {
    let wallet: Wallet;

    before(async () => {
      wallet = new Wallet({ privateKey: testnetKey as string, testnet: true });
      console.log(`  wallet:   ${wallet.address}`);
      console.log(`  gate:     ${LIVE_GATE_URL}`);
      console.log(`  origin:   ${LIVE_ORIGIN_URL}`);
      console.log(`  provider: ${LIVE_PROVIDER_ADDRESS}`);

      // Fund the wallet. Server /mint is rate-limited to 1/wallet/hour;
      // back-to-back CI runs will 429, which we treat as "already funded".
      // We deliberately do NOT check wallet.balance() — SDK 0.2.3 has a
      // latent bug where balance() divides a dollar-formatted string by
      // 1_000_000 (see P28 plan SDK balance() parsing bug section).
      try {
        const mintResult = await wallet.mint(MINT_AMOUNT_USDC);
        console.log(`  mint tx:  ${mintResult.txHash}`);
      } catch (err) {
        if (!isMintRateLimited(err)) throw err;
        console.log(`  mint rate-limited -- funded by a previous run, proceeding`);
      }

      // Proactively recycle a near-empty tab so wallet.request() below
      // doesn't hit an insufficient-balance error after ~500 runs. Each
      // run spends $0.01 against a $5 tab; at 1 run/day that's more than
      // a year, but CI parallel runs and backfills burn it faster.
      const tabs: Tab[] = await wallet.listTabs();
      const stale = tabs.find(
        (t) =>
          t.provider.toLowerCase() === LIVE_PROVIDER_ADDRESS.toLowerCase() &&
          t.status === "open" &&
          t.effectiveBalance < STALE_TAB_FLOOR_USD,
      );
      if (stale) {
        console.log(
          `  closing stale tab ${stale.id} (effectiveBalance $${stale.effectiveBalance.toFixed(2)})`,
        );
        await wallet.closeTab(stale.id);
      }
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

      // Sanity-check that this gate really is pointed at the live testnet
      // facilitator, not the mock on :9091 that test-rust uses.
      const extra = offer["extra"] as Record<string, unknown>;
      assert.equal(extra["settlement"], "tab");
      assert.equal(extra["facilitator"], "https://testnet.pay-skill.com/x402");

      // Drain the body so the TCP connection returns to the pool.
      await resp.text();
    });

    it("end-to-end tab-settled request against live facilitator", async () => {
      // Clear origin recorder so we can assert exactly one request landed.
      await fetch(`${LIVE_ORIGIN_URL}/__test/clear`);

      // wallet.request() runs the full x402 dance:
      //   1. GET /api/v1/premium/data -> 402 from gate
      //   2. SDK parses 402, finds/opens a tab with LIVE_PROVIDER_ADDRESS
      //      on testnet.pay-skill.com (real on-chain tab open via relayer)
      //   3. SDK POSTs /tabs/{id}/charge, receives charge_id
      //   4. SDK retries gate request with PAYMENT-SIGNATURE containing
      //      { extensions: { pay: { settlement, tabId, chargeId } } }
      //   5. Gate forwards the signature to testnet.pay-skill.com/x402/verify
      //   6. Facilitator verify_tab() loads the tab, confirms status=open,
      //      balance >= amount, and that tab_charges has the charge_id
      //   7. Facilitator returns { isValid: true, payer }
      //   8. Gate proxies to mock origin with X-Pay-* headers injected
      const resp = await wallet.request(`${LIVE_GATE_URL}/api/v1/premium/data`);
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

      // PAYMENT-RESPONSE base64 -> { success, network, payer, ... }.
      // payer must be the test wallet address, case-insensitive (server
      // lowercases, SDK uses viem's EIP-55 checksum form).
      const prHeader = resp.headers.get("payment-response");
      assert.ok(prHeader, "Missing PAYMENT-RESPONSE header");
      const settlement = JSON.parse(atob(prHeader)) as Record<string, unknown>;
      assert.equal(settlement["success"], true);
      assert.match(settlement["network"] as string, /^eip155:\d+$/);
      assert.equal(
        (settlement["payer"] as string).toLowerCase(),
        wallet.address.toLowerCase(),
      );

      // Confirm exactly one request landed on the origin.
      const recResp = await fetch(`${LIVE_ORIGIN_URL}/__test/requests`);
      const recorded = (await recResp.json()) as Array<{
        url: string;
        headers: Record<string, string | undefined>;
      }>;
      const gated = recorded.filter(
        (r) => r.url === "/api/v1/premium/data",
      );
      assert.equal(gated.length, 1, "Origin should see exactly one proxied request");
      assert.equal(gated[0]!.headers["x-pay-verified"], "true");
    });

    it("free route bypasses facilitator even on the live gate", async () => {
      await fetch(`${LIVE_ORIGIN_URL}/__test/clear`);

      const resp = await fetch(`${LIVE_GATE_URL}/api/v1/health`);
      assert.equal(resp.status, 200);

      const body = (await resp.json()) as Record<string, unknown>;
      assert.equal(body["echo"], true);

      // Free routes must not call the facilitator. We can't easily verify
      // that side from a live server (it isn't a mock), but we can verify
      // the origin received the request with no payment headers.
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
