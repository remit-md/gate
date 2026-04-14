/** Route configuration — loaded from KV or env. */
export interface RouteConfig {
  path: string;
  method?: string;
  price?: string;
  settlement?: "direct" | "tab";
  free?: boolean;
  allowlist?: string[];
  price_endpoint?: string;
  /** Rewrite the path before proxying to origin. e.g. "/v1/forecast.json" */
  proxy_rewrite?: string;
  /** Default query params injected into every proxied request. e.g. {"key": "abc", "days": "3"} */
  proxy_params?: Record<string, string>;
  /** Resource description for x402 402 response. e.g. "Weather forecast data" */
  description?: string;
  /** Response MIME type for x402 402 response. Defaults to "application/json". */
  mime_type?: string;
  /** Bazaar info block — structured input/output description for agents. Replaces hint. */
  info?: BazaarInfo;
  /** Route template with named path params (e.g. "/users/:id"). When set, used for matching instead of path. */
  route_template?: string;
}

/** Bazaar info block — describes how to call and what to expect from an endpoint. */
export interface BazaarInfo {
  input: BazaarInput;
  output?: BazaarOutput;
}

/** Discriminated union on input.type: "http" or "mcp". */
export type BazaarInput = HttpQueryInput | HttpBodyInput | McpInput;

export interface HttpQueryInput {
  type: "http";
  method: "GET" | "HEAD" | "DELETE";
  /** Path parameter descriptions (e.g. { id: { type: "string", description: "User ID" } }). Validation deferred to P26-4 routeTemplate. */
  pathParams?: Record<string, ParamDef>;
  queryParams?: Record<string, ParamDef>;
  headers?: Record<string, string>;
}

export interface HttpBodyInput {
  type: "http";
  method: "POST" | "PUT" | "PATCH";
  bodyType: "json" | "form-data" | "text";
  /** JSON Schema (draft 2020-12) describing the request body. Use standard `required` array at object level. */
  body: Record<string, unknown>;
  /** Path parameter descriptions. Validation deferred to P26-4 routeTemplate. */
  pathParams?: Record<string, ParamDef>;
  queryParams?: Record<string, ParamDef>;
  headers?: Record<string, string>;
}

export interface McpInput {
  type: "mcp";
  tool: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  transport?: "streamable-http" | "sse";
  example?: Record<string, unknown>;
}

export interface ParamDef {
  type: string;
  description?: string;
  required?: boolean;
  [key: string]: unknown;
}

export interface BazaarOutput {
  type: string;
  format?: string;
  example?: unknown;
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
    /** Pay extension: settlement mode for this route. */
    settlement?: string;
    /** Pay extension: facilitator URL for payment verification. */
    facilitator?: string;
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
