import type { PaymentRequired, PaymentRequirementsV2, SettlementResponse, GateError } from "./types";
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
): PaymentRequired {
  return {
    x402Version: 2,
    resource: {
      url: requestUrl,
      description: "Paid API endpoint",
      mimeType: "application/json",
    },
    accepts: [reqs],
    extensions: {},
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
    extra: {
      name: "USDC",
      version: "2",
      facilitator: facilitatorUrl,
      settlement,
    },
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
): Response {
  const pr = buildPaymentRequired(reqs, requestUrl);
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
