import type { RouteConfig, RouteMatch } from "./types";
import { autoSettlement, globalAllowlist } from "./config";
import type { Env } from "./types";

/**
 * Match a request against route config. First match wins.
 * Returns the match result (paid, free, allowlisted, passthrough, or blocked).
 */
export function matchRoute(
  path: string,
  method: string,
  routes: RouteConfig[],
  env: Env,
  agentAddress?: string,
): RouteMatch {
  // Check global allowlist first
  if (agentAddress) {
    const global = globalAllowlist(env);
    if (global.includes(agentAddress.toLowerCase())) {
      return { kind: "allowlisted", agent: agentAddress };
    }
  }

  for (const route of routes) {
    if (!pathMatches(route.path, path)) continue;
    if (route.method && route.method.toUpperCase() !== method.toUpperCase()) continue;

    // Per-route allowlist check
    if (agentAddress && route.allowlist) {
      const lower = route.allowlist.map((a) => a.toLowerCase());
      if (lower.includes(agentAddress.toLowerCase())) {
        return { kind: "allowlisted", agent: agentAddress };
      }
    }

    if (route.free) return { kind: "free", route };

    const price = route.price || "0";
    const settlement = route.settlement || autoSettlement(price);
    return { kind: "paid", route, price, settlement };
  }

  // No route matched — use default action
  return env.DEFAULT_ACTION === "passthrough"
    ? { kind: "passthrough" }
    : { kind: "blocked" };
}

/** Glob-style path matching. Supports * (one segment) and ** (any). */
export function pathMatches(pattern: string, path: string): boolean {
  // Exact match
  if (pattern === path) return true;

  // Convert glob to regex
  const parts = pattern.split("/");
  let regex = "^";
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (part === "**") {
      regex += "/.*";
    } else if (part === "*") {
      regex += "/[^/]+";
    } else if (part.endsWith("*")) {
      // e.g. "premium*" → match any segment starting with "premium"
      const prefix = escapeRegex(part.slice(0, -1));
      regex += "/" + prefix + "[^/]*";
    } else if (part === "") {
      // leading slash
      continue;
    } else {
      regex += "/" + escapeRegex(part);
    }
  }
  regex += "$";

  return new RegExp(regex).test(path);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Extract agent address from request.
 * Checks X-Pay-Agent header (for allowlist lookups on unpaid requests).
 */
export function extractAgentAddress(headers: Headers): string | undefined {
  return headers.get("x-pay-agent") || undefined;
}
