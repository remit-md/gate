import type { Env, HeartbeatPayload, HeartbeatRoute, RouteConfig } from "./types";
import { facilitatorUrl, loadRoutes, autoSettlement } from "./config";

/** Send a heartbeat to the facilitator's discover endpoint. */
export async function sendHeartbeat(env: Env): Promise<void> {
  if (!env.DISCOVERY_BASE_URL || !env.DISCOVERY_NAME) return;

  const baseUrl = env.DISCOVERY_BASE_URL.trim();
  if (!baseUrl.startsWith("https://")) {
    console.warn("DISCOVERY_BASE_URL must use HTTPS, skipping heartbeat");
    return;
  }

  const domain = extractDomain(baseUrl);
  if (!domain) {
    console.warn("Could not extract domain from DISCOVERY_BASE_URL, skipping heartbeat");
    return;
  }

  let routes: RouteConfig[];
  try {
    routes = await loadRoutes(env);
  } catch {
    console.warn("Could not load routes for heartbeat");
    return;
  }

  const heartbeatRoutes = buildRoutes(routes);
  const settlementMode = heartbeatRoutes.some((r) => r.settlement === "tab") ? "tab" : "direct";

  const payload: HeartbeatPayload = {
    domain,
    base_url: baseUrl,
    provider_address: env.PROVIDER_ADDRESS,
    name: env.DISCOVERY_NAME,
    description: env.DISCOVERY_DESCRIPTION || "",
    keywords: env.DISCOVERY_KEYWORDS ? env.DISCOVERY_KEYWORDS.split(",").map((k) => k.trim()).filter(Boolean) : [],
    category: env.DISCOVERY_CATEGORY || "other",
    website: env.DISCOVERY_WEBSITE || undefined,
    docs_url: env.DISCOVERY_DOCS_URL || undefined,
    routes: heartbeatRoutes,
    pricing: {},
    settlement_mode: settlementMode,
    gate_version: "0.1.0",
  };

  const facUrl = facilitatorUrl(env);
  const url = facUrl.replace("/x402", "/api/v1/discover") + "/heartbeat";

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (resp.ok) {
        console.log(`Discovery heartbeat sent to ${url}`);
        return;
      }
      console.warn(`Heartbeat rejected (attempt ${attempt + 1}): ${resp.status}`);
    } catch (err) {
      console.warn(`Heartbeat failed (attempt ${attempt + 1}):`, err);
    }
  }

  console.error("Discovery heartbeat failed after 3 attempts");
}

function buildRoutes(routes: RouteConfig[]): HeartbeatRoute[] {
  return routes
    .filter((r) => !r.free)
    .map((r) => ({
      path: r.path,
      method: r.method || "*",
      price: r.price,
      settlement: r.settlement || (r.price ? autoSettlement(r.price) : "auto"),
      hint: r.hint,
    }));
}

function extractDomain(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}
