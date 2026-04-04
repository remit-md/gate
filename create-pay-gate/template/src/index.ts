import { Hono } from "hono";
import type { Env, RouteConfig, PaymentRequirements } from "./types";
import { loadRoutes, validateEnv, facilitatorUrl, priceToMicroUsdc, autoSettlement } from "./config";
import { matchRoute, extractAgentAddress } from "./gate";
import { verifyPayment, checkFacilitatorHealth } from "./verify";
import { make402Response, make403Response, make429Response, make503Response } from "./response";

const app = new Hono<{ Bindings: Env }>();

// In-memory rate limit counters (per-isolate, reset on deploy)
const rateCounts = new Map<string, { count: number; resetAt: number }>();

// ── Health endpoint ─────────────────────────────────────────────
app.get("/__pay/health", async (c) => {
  const start = Date.now();
  const url = facilitatorUrl(c.env);
  const reachable = await checkFacilitatorHealth(url);
  return c.json({
    status: reachable ? "ok" : "degraded",
    facilitator: reachable ? "reachable" : "unreachable",
    version: "0.1.0",
    uptime: Math.floor((Date.now() - start) / 1000),
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
  return handlePaidRequest(c.env, match, paymentSig, c.req.header("accept"));
});

// ── CORS preflight — always pass through ────────────────────────
app.options("*", (c) => {
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
  if (match.kind === "free" || match.kind === "passthrough") {
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

  if (!paymentSig) {
    return make402(c.env, price, settlement, c.req.header("accept"));
  }

  // Verify payment with facilitator
  const facUrl = facilitatorUrl(c.env);
  const result = await verifyPayment(facUrl, paymentSig, {
    scheme: "exact",
    amount: priceToMicroUsdc(price),
    settlement,
    to: c.env.PROVIDER_ADDRESS,
  });

  // Facilitator unreachable
  if (!result) {
    if (c.env.FAIL_MODE === "open") {
      console.warn("Facilitator unreachable, fail_mode=open, passing through");
      return proxyToOrigin(c.env, c.req.raw);
    }
    return make503Response();
  }

  // Verification failed
  if (!result.valid) {
    return make402(c.env, price, settlement, c.req.header("accept"), result.reason);
  }

  // Verification succeeded — proxy with payment headers
  const extraHeaders: Record<string, string> = {
    "X-Pay-Verified": "true",
    "X-Pay-Amount": priceToMicroUsdc(price),
    "X-Pay-Settlement": settlement,
  };
  if (result.from) extraHeaders["X-Pay-From"] = result.from;
  if (result.tab) extraHeaders["X-Pay-Tab"] = result.tab;

  const resp = await proxyToOrigin(c.env, c.req.raw, extraHeaders);

  // Add receipt to response
  if (result.receipt) {
    const newResp = new Response(resp.body, resp);
    newResp.headers.set("PAYMENT-RESPONSE", result.receipt);
    return newResp;
  }

  return resp;
});

// ── Helpers ─────────────────────────────────────────────────────

function make402(
  env: Env,
  price: string,
  settlement: "direct" | "tab",
  accept: string | null | undefined,
  reason?: string,
): Response {
  const reqs: PaymentRequirements = {
    scheme: "exact",
    amount: priceToMicroUsdc(price),
    settlement,
    to: env.PROVIDER_ADDRESS,
    facilitator: facilitatorUrl(env),
    maxChargePerCall: priceToMicroUsdc(price),
    network: "base",
  };
  return make402Response(reqs, price, accept, reason);
}

async function handlePaidRequest(
  env: Env,
  match: Extract<import("./types").RouteMatch, { kind: "paid" }>,
  paymentSig: string | null | undefined,
  accept: string | null | undefined,
): Promise<Response> {
  if (!paymentSig) {
    return make402(env, match.price, match.settlement, accept);
  }

  const facUrl = facilitatorUrl(env);
  const result = await verifyPayment(facUrl, paymentSig, {
    scheme: "exact",
    amount: priceToMicroUsdc(match.price),
    settlement: match.settlement,
    to: env.PROVIDER_ADDRESS,
  });

  if (!result) {
    return env.FAIL_MODE === "open"
      ? new Response(null, { status: 200, headers: { "X-Pay-Verified": "free" } })
      : make503Response();
  }

  if (!result.valid) {
    return make402(env, match.price, match.settlement, accept, result.reason);
  }

  const headers: Record<string, string> = {
    "X-Pay-Verified": "true",
    "X-Pay-Amount": priceToMicroUsdc(match.price),
    "X-Pay-Settlement": match.settlement,
  };
  if (result.from) headers["X-Pay-From"] = result.from;
  if (result.tab) headers["X-Pay-Tab"] = result.tab;

  return new Response(null, { status: 200, headers });
}

async function proxyToOrigin(
  env: Env,
  req: Request,
  extraHeaders?: Record<string, string>,
): Promise<Response> {
  const url = new URL(req.url);
  const target = new URL(env.PROXY_TARGET);
  url.protocol = target.protocol;
  url.hostname = target.hostname;
  url.port = target.port;

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

export default app;
