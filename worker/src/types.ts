/** Route configuration — loaded from KV or env. */
export interface RouteConfig {
  path: string;
  method?: string;
  price?: string;
  settlement?: "direct" | "tab";
  free?: boolean;
  allowlist?: string[];
  price_endpoint?: string;
  /** Free-form usage hint for agents. e.g. "?q={city}" or '{"prompt": "string"}' */
  hint?: string;
  /** Rewrite the path before proxying to origin. e.g. "/v1/forecast.json" */
  proxy_rewrite?: string;
  /** Default query params injected into every proxied request. e.g. {"key": "abc", "days": "3"} */
  proxy_params?: Record<string, string>;
}

/** Top-level env bindings for the CF Worker. */
export interface Env {
  ROUTES: KVNamespace;
  PROVIDER_ADDRESS: string;
  PROXY_TARGET: string;
  DEFAULT_ACTION: string;
  FAIL_MODE: string;
  FACILITATOR_URL?: string;
  LOG_LEVEL?: string;
  RATE_LIMIT_PER_AGENT?: string;
  RATE_LIMIT_VERIFICATION?: string;
  GLOBAL_ALLOWLIST?: string;
  /** Discovery config — set these to register in pay discover catalog. */
  DISCOVERY_BASE_URL?: string;
  DISCOVERY_NAME?: string;
  DISCOVERY_DESCRIPTION?: string;
  DISCOVERY_KEYWORDS?: string;
  DISCOVERY_CATEGORY?: string;
  DISCOVERY_DOCS_URL?: string;
  DISCOVERY_WEBSITE?: string;
}

/** Heartbeat payload sent to facilitator for service discovery. */
export interface HeartbeatPayload {
  domain: string;
  base_url: string;
  provider_address: string;
  name: string;
  description: string;
  keywords: string[];
  category: string;
  website?: string;
  docs_url?: string;
  routes: HeartbeatRoute[];
  pricing: Record<string, unknown>;
  settlement_mode: string;
  gate_version: string;
}

export interface HeartbeatRoute {
  path: string;
  method: string;
  price?: string;
  settlement: string;
  hint?: string;
}

/** x402 v2 top-level 402 response (base64-encoded in PAYMENT-REQUIRED header). */
export interface PaymentRequired {
  x402Version: 2;
  resource: { url: string; description?: string; mimeType?: string };
  accepts: PaymentRequirementsV2[];
  extensions: Record<string, unknown>;
}

/** x402 v2 payment requirements (one entry in the `accepts` array). */
export interface PaymentRequirementsV2 {
  scheme: "exact";
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: {
    name?: string;
    version?: string;
    facilitator?: string;
    settlement?: string;
  };
}

/** x402 v2 facilitator /verify request body. */
export interface VerifyRequestV2 {
  x402Version: 2;
  paymentPayload: unknown;
  paymentRequirements: PaymentRequirementsV2;
}

/** x402 v2 facilitator /verify response body. */
export interface VerifyResponseV2 {
  isValid: boolean;
  invalidReason?: string;
  payer?: string;
}

/** x402 v2 settlement response (base64-encoded in PAYMENT-RESPONSE header). */
export interface SettlementResponse {
  success: boolean;
  errorReason?: string;
  transaction: string;
  network: string;
  payer?: string;
  extensions: Record<string, unknown>;
}

/** Result of matching a request against route config. */
export type RouteMatch =
  | { kind: "paid"; route: RouteConfig; price: string; settlement: "direct" | "tab" }
  | { kind: "free"; route: RouteConfig }
  | { kind: "allowlisted"; agent: string }
  | { kind: "passthrough" }
  | { kind: "blocked" };

/** Structured gate error for responses. */
export interface GateError {
  error: string;
  message: string;
  reason?: string;
  docs?: string;
}
