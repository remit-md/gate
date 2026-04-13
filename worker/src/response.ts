import type { BazaarInfo, PaymentRequired, PaymentRequirementsV2, SettlementResponse, GateError } from "./types";
import { caip2Network } from "./config";

/**
 * Build a base64-encoded v2 PAYMENT-REQUIRED header value.
 */
export function buildPaymentRequiredHeader(pr: PaymentRequired): string {
  return btoa(JSON.stringify(pr));
}

/**
 * Build a v2 PaymentRequired object.
 */
export function buildPaymentRequired(
  reqs: PaymentRequirementsV2,
  requestUrl: string,
  description?: string,
  mimeType?: string,
  info?: BazaarInfo,
): PaymentRequired {
  const resource: PaymentRequired["resource"] = { url: requestUrl };
  if (description) resource.description = description;
  if (mimeType) resource.mimeType = mimeType;
  const extensions: Record<string, unknown> = {};
  if (info) {
    extensions.bazaar = { info, schema: buildInfoSchema(info) };
  }
  return {
    x402Version: 2,
    resource,
    accepts: [reqs],
    extensions,
  };
}

/**
 * Build a v2 PaymentRequirementsV2 object.
 */
export function buildRequirements(
  amount: string,
  settlement: "direct" | "tab",
  providerAddress: string,
  facilitatorUrl: string,
  chain: number,
  asset: string,
): PaymentRequirementsV2 {
  return {
    scheme: "exact",
    network: caip2Network(chain),
    amount,
    asset,
    payTo: providerAddress,
    maxTimeoutSeconds: 60,
    extra: { settlement, facilitator: facilitatorUrl },
  };
}

/**
 * Build a base64-encoded v2 SettlementResponse for the PAYMENT-RESPONSE header.
 */
export function buildSettlementResponse(payer: string | undefined, chain: number): string {
  const resp: SettlementResponse = {
    success: true,
    transaction: "",
    network: caip2Network(chain),
    payer,
    extensions: {},
  };
  return btoa(JSON.stringify(resp));
}

/**
 * Build a 402 JSON response body.
 */
export function build402JsonBody(price: string, reason?: string): GateError {
  const body: GateError = {
    error: "payment_required",
    message: `This endpoint requires payment. $${price} per request.`,
    docs: "https://pay-skill.com/gate",
  };
  if (reason) body.reason = reason;
  return body;
}

/**
 * Build a 402 HTML response body for browser clients.
 */
export function build402Html(price: string): string {
  return [
    "<html><head><title>Payment Required</title></head><body>",
    "<h1>Payment Required</h1>",
    `<p>This endpoint requires a payment of $${price} per request.</p>`,
    "<p>Use an x402-compatible agent or SDK to access this API.</p>",
    '<p><a href="https://pay-skill.com/gate">Learn more about pay-gate</a></p>',
    "</body></html>",
  ].join("\n");
}

/**
 * Check if request accepts HTML (browser detection).
 */
export function wantsHtml(accept: string | null | undefined): boolean {
  if (!accept) return false;
  return accept.includes("text/html") && !accept.includes("application/json");
}

/**
 * Build a full 402 Response with v2 PAYMENT-REQUIRED header.
 */
export function make402Response(
  reqs: PaymentRequirementsV2,
  requestUrl: string,
  price: string,
  accept: string | null | undefined,
  reason?: string,
  description?: string,
  mimeType?: string,
  info?: BazaarInfo,
): Response {
  const pr = buildPaymentRequired(reqs, requestUrl, description, mimeType, info);
  const header = buildPaymentRequiredHeader(pr);

  if (wantsHtml(accept)) {
    return new Response(build402Html(price), {
      status: 402,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "PAYMENT-REQUIRED": header,
      },
    });
  }

  return new Response(JSON.stringify(build402JsonBody(price, reason)), {
    status: 402,
    headers: {
      "Content-Type": "application/json",
      "PAYMENT-REQUIRED": header,
    },
  });
}

/** Build a 403 Forbidden response (blocked by default_action). */
export function make403Response(): Response {
  return new Response(
    JSON.stringify({ error: "forbidden", message: "This endpoint is not available." }),
    { status: 403, headers: { "Content-Type": "application/json" } },
  );
}

/** Build a 429 Too Many Requests response. */
export function make429Response(): Response {
  return new Response(
    JSON.stringify({ error: "rate_limited", message: "Too many requests." }),
    { status: 429, headers: { "Content-Type": "application/json" } },
  );
}

/** Build a 503 Service Unavailable response (facilitator down, fail_mode closed). */
export function make503Response(): Response {
  return new Response(
    JSON.stringify({ error: "service_unavailable", message: "Payment facilitator is unreachable." }),
    { status: 503, headers: { "Content-Type": "application/json" } },
  );
}

/**
 * Build a JSON Schema Draft 2020-12 from a BazaarInfo block.
 * Deterministic: same info always produces the same schema.
 */
function buildInfoSchema(info: BazaarInfo): Record<string, unknown> {
  const schema: Record<string, unknown> = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: { input: buildInputSchema(info.input) },
    required: ["input"],
  };
  if (info.output) {
    (schema.properties as Record<string, unknown>).output = {
      type: "object",
      properties: { type: { type: "string" } },
    };
  }
  return schema;
}

function buildInputSchema(input: BazaarInfo["input"]): Record<string, unknown> {
  if (input.type === "http") {
    const props: Record<string, unknown> = {
      type: { const: "http" },
      method: { const: input.method },
    };
    const required = ["type", "method"];
    if ("queryParams" in input && input.queryParams) {
      props.queryParams = buildParamsSchema(input.queryParams);
    }
    if ("bodyType" in input && input.bodyType) {
      props.bodyType = { const: input.bodyType };
      required.push("bodyType");
    }
    if ("body" in input && input.body) {
      props.body = { type: "object" };
      required.push("body");
    }
    return { type: "object", properties: props, required };
  }
  // mcp
  return {
    type: "object",
    properties: {
      type: { const: "mcp" },
      tool: { type: "string" },
      inputSchema: { type: "object" },
    },
    required: ["type", "tool", "inputSchema"],
  };
}

function buildParamsSchema(params: Record<string, unknown>): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, def] of Object.entries(params)) {
    const d = def as Record<string, unknown>;
    props[key] = { type: d.type || "string" };
    if (d.required) required.push(key);
  }
  const schema: Record<string, unknown> = { type: "object", properties: props };
  if (required.length > 0) schema.required = required;
  return schema;
}
