import type { BazaarInfo, Env, RouteConfig } from "./types";

const ETH_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const URL_RE = /^https?:\/\/.+/;

/** Load and validate route config from KV (or fallback to empty). */
export async function loadRoutes(env: Env): Promise<RouteConfig[]> {
  const raw = await env.ROUTES.get("routes", "json");
  if (!raw || !Array.isArray(raw)) return [];
  return validateRoutes(raw as RouteConfig[]);
}

/** Validate an array of route configs. Throws on invalid. */
export function validateRoutes(routes: RouteConfig[]): RouteConfig[] {
  for (const r of routes) {
    if (!r.path || typeof r.path !== "string") {
      throw new Error(`Route missing 'path'`);
    }
    if (r.free) continue;
    if (r.price_endpoint && !URL_RE.test(r.price_endpoint)) {
      throw new Error(`Route ${r.path}: invalid price_endpoint URL`);
    }
    if (!r.price && !r.price_endpoint) {
      throw new Error(`Route ${r.path}: must have 'price' or 'price_endpoint'`);
    }
    if (r.price) validatePrice(r.price, r.path);
    if (r.settlement && r.settlement !== "direct" && r.settlement !== "tab") {
      throw new Error(`Route ${r.path}: settlement must be 'direct' or 'tab'`);
    }
    if (r.method) {
      const m = r.method.toUpperCase();
      if (!["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].includes(m)) {
        throw new Error(`Route ${r.path}: invalid method '${r.method}'`);
      }
    }
    if (r.info) validateInfo(r.info, r.path);
  }
  return routes;
}

/** Validate a price string: positive decimal, not "0.00". */
function validatePrice(price: string, path: string): void {
  const n = parseFloat(price);
  if (isNaN(n) || n <= 0) {
    throw new Error(`Route ${path}: price must be a positive number, got '${price}'`);
  }
}

/** Validate top-level env config. Throws on invalid. */
export function validateEnv(env: Env): void {
  if (!ETH_ADDRESS_RE.test(env.PROVIDER_ADDRESS)) {
    throw new Error(`Invalid PROVIDER_ADDRESS: '${env.PROVIDER_ADDRESS}'`);
  }
  if (!URL_RE.test(env.PROXY_TARGET)) {
    throw new Error(`Invalid PROXY_TARGET: '${env.PROXY_TARGET}'`);
  }
  if (env.DEFAULT_ACTION !== "passthrough" && env.DEFAULT_ACTION !== "block") {
    throw new Error(`DEFAULT_ACTION must be 'passthrough' or 'block', got '${env.DEFAULT_ACTION}'`);
  }
  if (env.FAIL_MODE !== "closed" && env.FAIL_MODE !== "open") {
    throw new Error(`FAIL_MODE must be 'closed' or 'open', got '${env.FAIL_MODE}'`);
  }
}

/** Get facilitator URL (mainnet default). */
export function facilitatorUrl(env: Env): string {
  return env.FACILITATOR_URL || "https://pay-skill.com/x402";
}

/** Parse global allowlist from comma-separated env var. */
export function globalAllowlist(env: Env): string[] {
  const raw = env.GLOBAL_ALLOWLIST;
  if (!raw) return [];
  return raw.split(",").map((a) => a.trim().toLowerCase()).filter(Boolean);
}

/** Convert dollar price string to micro-USDC string (6 decimals). */
export function priceToMicroUsdc(price: string): string {
  const dollars = parseFloat(price);
  const micro = Math.round(dollars * 1_000_000);
  return micro.toString();
}

/** Auto-select settlement mode based on price. */
export function autoSettlement(price: string): "direct" | "tab" {
  const dollars = parseFloat(price);
  return dollars <= 1.0 ? "tab" : "direct";
}

/** Derive chain ID from facilitator URL. */
export function chainId(env: Env): number {
  const url = facilitatorUrl(env);
  return url.includes("testnet") ? 84532 : 8453;
}

/** USDC contract address for a given chain. */
export function usdcAddress(chain: number): string {
  return chain === 8453
    ? "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
    : "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
}

/** CAIP-2 network identifier. */
export function caip2Network(chain: number): string {
  return `eip155:${chain}`;
}

const HTTP_QUERY_METHODS = ["GET", "HEAD", "DELETE"];
const HTTP_BODY_METHODS = ["POST", "PUT", "PATCH"];

/** Validate a Bazaar info block. Throws on invalid. */
function validateInfo(info: BazaarInfo, path: string): void {
  const label = `Route ${path}.info`;
  if (!info.input || typeof info.input !== "object") {
    throw new Error(`${label}: 'input' is required`);
  }
  const { input } = info;
  if (input.type === "http") {
    if (!input.method) {
      throw new Error(`${label}.input: 'method' is required for type 'http'`);
    }
    const m = input.method.toUpperCase();
    if (HTTP_BODY_METHODS.includes(m)) {
      const body = input as unknown as Record<string, unknown>;
      if (!body.bodyType) {
        throw new Error(`${label}.input: 'bodyType' is required for ${m}`);
      }
      if (!body.body || typeof body.body !== "object") {
        throw new Error(`${label}.input: 'body' is required for ${m}`);
      }
    } else if (!HTTP_QUERY_METHODS.includes(m)) {
      throw new Error(`${label}.input: invalid method '${input.method}'`);
    }
  } else if (input.type === "mcp") {
    if (!input.tool) {
      throw new Error(`${label}.input: 'tool' is required for type 'mcp'`);
    }
    if (!input.inputSchema || typeof input.inputSchema !== "object") {
      throw new Error(`${label}.input: 'inputSchema' is required for type 'mcp'`);
    }
  } else {
    throw new Error(`${label}.input.type: must be 'http' or 'mcp', got '${(input as Record<string, unknown>).type}'`);
  }
}
