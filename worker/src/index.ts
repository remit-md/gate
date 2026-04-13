import { Hono } from "hono";
import type { Env, RouteConfig } from "./types";
import { loadRoutes, validateEnv, facilitatorUrl, priceToMicroUsdc, autoSettlement, chainId, usdcAddress } from "./config";
import { matchRoute, extractAgentAddress } from "./gate";
import { verifyPayment, checkFacilitatorHealth } from "./verify";
import { make402Response, make403Response, make429Response, make503Response, buildRequirements, buildSettlementResponse } from "./response";
import { sendHeartbeat } from "./heartbeat";

const app = new Hono<{ Bindings: Env }>();

// In-memory rate limit counters (per-isolate, reset on deploy)
const rateCounts = new Map<string, { count: number; resetAt: number }>();

// ── Health endpoint ─────────────────────────────────────────────
app.get("/__pay/health", async (c) => {
  const start = Date.now();
  const url = facilitatorUrl(c.env);
  const chain = chainId(c.env);
  const network = chain === 8453 ? "mainnet" : "testnet";
  const reachable = await checkFacilitatorHealth(url);
  return c.json({
    status: reachable ? "ok" : "degraded",
    facilitator: reachable ? "reachable" : "unreachable",
    network,
    chain_id: chain,
    version: "0.1.0",
    uptime: Math.floor((Date.now() - start) / 1000),
  });
});

// ── x402 well-known descriptor (IETF draft) ────────────────────
app.get("/.well-known/x402", async (c) => {
  let routes: RouteConfig[];
  try {
    validateEnv(c.env);
    routes = await loadRoutes(c.env);
  } catch (err) {
    return c.json({ error: "config_error", message: String(err) }, 500);
  }

  const chain = chainId(c.env);
  const asset = usdcAddress(chain);
  const network = `eip155:${chain}`;

  const endpoints = routes
    .filter((r) => !r.free && r.price)
    .map((r) => {
      const settlement = r.settlement || autoSettlement(r.price!);
      const entry: Record<string, unknown> = {
        path: r.path,
        method: (r.method || "GET").toUpperCase(),
        paymentRequirements: {
          scheme: "exact",
          network,
          amount: priceToMicroUsdc(r.price!),
          asset,
          payTo: c.env.PROVIDER_ADDRESS,
          maxTimeoutSeconds: 60,
          extra: { settlement, facilitator: facilitatorUrl(c.env) },
        },
      };
      if (r.description) entry.description = r.description;
      if (r.mime_type) entry.mimeType = r.mime_type;
      if (r.info) entry.info = r.info;
      return entry;
    });

  return c.json({
    x402Version: 2,
    payTo: c.env.PROVIDER_ADDRESS,
    network,
    asset,
    endpoints,
  });
});

// ── Sidecar check endpoint ──────────────────────────────────────
app.post("/__pay/check", async (c) => {
  const originalUri = c.req.header("x-original-uri") || "/";
  const originalMethod = c.req.header("x-original-method") || "GET";
  const paymentSig = c.req.header("payment-signature");

  let routes: RouteConfig[];
  try {
    validateEnv(c.env);
    routes = await loadRoutes(c.env);
  } catch (err) {
    return c.json({ error: "config_error", message: String(err) }, 500);
  }

  const agentAddr = extractAgentAddress(c.req.raw.headers);
  const match = matchRoute(originalUri, originalMethod, routes, c.env, agentAddr);

  if (match.kind === "free") {
    return new Response(null, {
      status: 200,
      headers: { "X-Pay-Verified": "free" },
    });
  }

  if (match.kind === "passthrough") {
    return new Response(null, { status: 200 });
  }

  if (match.kind === "blocked") {
    return make403Response();
  }

  if (match.kind === "allowlisted") {
    return new Response(null, {
      status: 200,
      headers: {
        "X-Pay-Verified": "allowlisted",
        "X-Pay-From": match.agent,
      },
    });
  }

  // Paid route
  return handlePaidRequest(c.env, match, paymentSig, c.req.header("accept"), originalUri);
});

// ── CORS preflight — always pass through ────────────────────────
app.options("*", () => {
  return new Response(null, { status: 204 });
});

// ── Gate middleware for all other routes ─────────────────────────
app.all("*", async (c) => {
  let routes: RouteConfig[];
  try {
    validateEnv(c.env);
    routes = await loadRoutes(c.env);
  } catch (err) {
    return c.json({ error: "config_error", message: String(err) }, 500);
  }

  const path = new URL(c.req.url).pathname;
  const method = c.req.method;
  const agentAddr = extractAgentAddress(c.req.raw.headers);
  const match = matchRoute(path, method, routes, c.env, agentAddr);

  // Free route — proxy directly
  if (match.kind === "free") {
    return proxyToOrigin(c.env, c.req.raw, undefined, match.route);
  }
  if (match.kind === "passthrough") {
    return proxyToOrigin(c.env, c.req.raw);
  }

  // Blocked
  if (match.kind === "blocked") {
    return make403Response();
  }

  // Allowlisted agent — proxy with headers
  if (match.kind === "allowlisted") {
    return proxyToOrigin(c.env, c.req.raw, {
      "X-Pay-Verified": "allowlisted",
      "X-Pay-From": match.agent,
    });
  }

  // Paid route — check for dynamic pricing first
  let price = match.price;
  let settlement = match.settlement;

  if (match.route.price_endpoint) {
    const dynamic = await fetchDynamicPrice(match.route.price_endpoint, path, method, c.req.raw.headers);
    if (dynamic) {
      price = dynamic;
      settlement = match.route.settlement || autoSettlement(dynamic);
    } else if (!match.route.price) {
      return make503Response();
    }
  }

  // Rate limit check (per source IP)
  const clientIp = c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for") || "unknown";
  if (isRateLimited(clientIp, c.env)) {
    return make429Response();
  }

  const paymentSig = c.req.header("payment-signature");
  const chain = chainId(c.env);
  const asset = usdcAddress(chain);
  const facUrl = facilitatorUrl(c.env);
  const amount = priceToMicroUsdc(price);
  const reqs = buildRequirements(amount, settlement, c.env.PROVIDER_ADDRESS, facUrl, chain, asset);

  if (!paymentSig) {
    return make402Response(reqs, path, price, c.req.header("accept"),
      undefined, match.route.description, match.route.mime_type, match.route.info);
  }

  // Verify payment with facilitator
  const result = await verifyPayment(facUrl, paymentSig, reqs);

  // Facilitator unreachable
  if (!result) {
    if (c.env.FAIL_MODE === "open") {
      console.warn("Facilitator unreachable, fail_mode=open, passing through");
      return proxyToOrigin(c.env, c.req.raw, undefined, match.route);
    }
    return make503Response();
  }

  // Verification failed
  if (!result.isValid) {
    return make402Response(reqs, path, price, c.req.header("accept"),
      result.invalidReason, match.route.description, match.route.mime_type, match.route.info);
  }

  // Verification succeeded — proxy with payment headers
  const extraHeaders: Record<string, string> = {
    "X-Pay-Verified": "true",
    "X-Pay-Amount": amount,
    "X-Pay-Settlement": settlement,
  };
  if (result.payer) extraHeaders["X-Pay-From"] = result.payer;

  const resp = await proxyToOrigin(c.env, c.req.raw, extraHeaders, match.route);

  // Add v2 settlement response as PAYMENT-RESPONSE header
  const receipt = buildSettlementResponse(result.payer, chain);
  const newResp = new Response(resp.body, resp);
  newResp.headers.set("PAYMENT-RESPONSE", receipt);
  return newResp;
});

// ── Helpers ─────────────────────────────────────────────────────

async function handlePaidRequest(
  env: Env,
  match: Extract<import("./types").RouteMatch, { kind: "paid" }>,
  paymentSig: string | null | undefined,
  accept: string | null | undefined,
  requestUrl: string,
): Promise<Response> {
  const chain = chainId(env);
  const asset = usdcAddress(chain);
  const facUrl = facilitatorUrl(env);
  const amount = priceToMicroUsdc(match.price);
  const reqs = buildRequirements(amount, match.settlement, env.PROVIDER_ADDRESS, facUrl, chain, asset);

  if (!paymentSig) {
    return make402Response(reqs, requestUrl, match.price, accept,
      undefined, match.route.description, match.route.mime_type, match.route.info);
  }

  const result = await verifyPayment(facUrl, paymentSig, reqs);

  if (!result) {
    return env.FAIL_MODE === "open"
      ? new Response(null, { status: 200, headers: { "X-Pay-Verified": "free" } })
      : make503Response();
  }

  if (!result.isValid) {
    return make402Response(reqs, requestUrl, match.price, accept,
      result.invalidReason, match.route.description, match.route.mime_type, match.route.info);
  }

  const headers: Record<string, string> = {
    "X-Pay-Verified": "true",
    "X-Pay-Amount": amount,
    "X-Pay-Settlement": match.settlement,
  };
  if (result.payer) headers["X-Pay-From"] = result.payer;

  const receipt = buildSettlementResponse(result.payer, chain);
  headers["PAYMENT-RESPONSE"] = receipt;

  return new Response(null, { status: 200, headers });
}

async function proxyToOrigin(
  env: Env,
  req: Request,
  extraHeaders?: Record<string, string>,
  route?: import("./types").RouteConfig,
): Promise<Response> {
  const url = new URL(req.url);
  const target = new URL(env.PROXY_TARGET);
  url.protocol = target.protocol;
  url.hostname = target.hostname;
  url.port = target.port;

  // Apply route-level path rewrite (e.g. /weather → /v1/forecast.json)
  if (route?.proxy_rewrite) {
    url.pathname = route.proxy_rewrite;
  }

  // Inject route-level default query params (e.g. key=xxx&days=3)
  if (route?.proxy_params) {
    for (const [k, v] of Object.entries(route.proxy_params)) {
      if (!url.searchParams.has(k)) {
        url.searchParams.set(k, v);
      }
    }
  }

  const headers = new Headers(req.headers);
  headers.delete("host");
  headers.set("host", target.hostname);

  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) {
      headers.set(k, v);
    }
  }

  // Strip payment headers — don't forward to origin
  headers.delete("payment-signature");

  const proxyReq = new Request(url.toString(), {
    method: req.method,
    headers,
    body: req.body,
    redirect: "manual",
  });

  try {
    return await fetch(proxyReq);
  } catch (err) {
    console.error("Origin proxy error:", err);
    return new Response(
      JSON.stringify({ error: "bad_gateway", message: "Origin server unreachable." }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    );
  }
}

async function fetchDynamicPrice(
  endpoint: string,
  path: string,
  method: string,
  headers: Headers,
): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3_000);
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        method,
        path,
        headers: Object.fromEntries(headers.entries()),
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!resp.ok) return null;
    const body = (await resp.json()) as { price?: string };
    return body.price || null;
  } catch {
    return null;
  }
}

function isRateLimited(key: string, env: Env): boolean {
  const limitStr = env.RATE_LIMIT_PER_AGENT || "1000";
  const limit = parseInt(limitStr, 10) || 1000;
  const now = Date.now();
  const entry = rateCounts.get(key);

  if (!entry || now >= entry.resetAt) {
    rateCounts.set(key, { count: 1, resetAt: now + 60_000 });
    return false;
  }

  entry.count++;
  return entry.count > limit;
}

function logNetworkWarning(env: Env): void {
  const chain = chainId(env);
  if (chain !== 8453) {
    console.warn("========================================================");
    console.warn("  TESTNET MODE — payments use worthless test USDC.");
    console.warn("  Set FACILITATOR_URL to https://pay-skill.com/x402");
    console.warn("  for production (mainnet).");
    console.warn("========================================================");
  }
}

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext) {
    logNetworkWarning(env);
    await sendHeartbeat(env);
  },
};
