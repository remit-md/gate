/** Route configuration — loaded from KV or env. */
export interface RouteConfig {
  path: string;
  method?: string;
  price?: string;
  settlement?: "direct" | "tab";
  free?: boolean;
  allowlist?: string[];
  price_endpoint?: string;
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
}

/** x402 V2 payment requirements (base64-encoded in PAYMENT-REQUIRED header). */
export interface PaymentRequirements {
  scheme: "exact";
  amount: string;
  settlement: "direct" | "tab";
  to: string;
  facilitator: string;
  maxChargePerCall: string;
  network: "base";
}

/** Facilitator /verify request body. */
export interface VerifyRequest {
  payment: string;
  requirements: {
    scheme: "exact";
    amount: string;
    settlement: "direct" | "tab";
    to: string;
  };
}

/** Facilitator /verify response body. */
export interface VerifyResponse {
  valid: boolean;
  reason?: string;
  receipt?: string;
  from?: string;
  tab?: string;
  amount?: string;
  settlement?: string;
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
