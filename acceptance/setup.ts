/**
 * Shared test harness for pay-gate acceptance tests.
 * Spawns mock origin, mock facilitator, and the target (Rust binary or CF Worker).
 */

const GATE_PORT = parseInt(process.env["GATE_PORT"] || "8402", 10);
const ORIGIN_PORT = parseInt(process.env["MOCK_ORIGIN_PORT"] || "9090", 10);
const FACILITATOR_PORT = parseInt(process.env["MOCK_FACILITATOR_PORT"] || "9091", 10);

export const GATE_URL = `http://localhost:${GATE_PORT}`;
export const ORIGIN_URL = `http://localhost:${ORIGIN_PORT}`;
export const FACILITATOR_URL = `http://localhost:${FACILITATOR_PORT}`;

/** GET/POST/PUT/etc against the gate. */
export async function gateRequest(
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  return fetch(`${GATE_URL}${path}`, options);
}

/** GET origin's recorded requests (for asserting injected headers). */
export async function getOriginRequests(): Promise<unknown[]> {
  const resp = await fetch(`${ORIGIN_URL}/__test/requests`);
  return resp.json() as Promise<unknown[]>;
}

/** Clear origin request log. */
export async function clearOriginRequests(): Promise<void> {
  await fetch(`${ORIGIN_URL}/__test/clear`);
}

/** Set mock facilitator default behavior (v2 format). */
export async function setFacilitatorBehavior(behavior: {
  isValid: boolean;
  invalidReason?: string;
  payer?: string;
}): Promise<void> {
  await fetch(`${FACILITATOR_URL}/__mock/set-default`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(behavior),
  });
}

/** Set mock facilitator override for a specific payment value. */
export async function setFacilitatorOverride(
  payment: string,
  behavior: { isValid: boolean; invalidReason?: string },
): Promise<void> {
  await fetch(`${FACILITATOR_URL}/__mock/set-override`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ payment, behavior }),
  });
}

/** Reset mock facilitator to defaults. */
export async function resetFacilitator(): Promise<void> {
  await fetch(`${FACILITATOR_URL}/__mock/reset`, { method: "POST" });
}

/** Set mock facilitator to "down" mode (returns 500 on /verify). */
export async function setFacilitatorDown(): Promise<void> {
  await fetch(`${FACILITATOR_URL}/__mock/set-down`, { method: "POST" });
}

/** Restore mock facilitator from "down" mode. */
export async function setFacilitatorUp(): Promise<void> {
  await fetch(`${FACILITATOR_URL}/__mock/set-up`, { method: "POST" });
}

/** Get facilitator /verify call count (to verify free routes skip facilitator). */
export async function getFacilitatorCallCount(): Promise<number> {
  const resp = await fetch(`${FACILITATOR_URL}/__mock/call-count`);
  const data = await resp.json() as { count: number };
  return data.count;
}

/** Get the last verify request received by the mock facilitator. */
export async function getLastFacilitatorRequest(): Promise<Record<string, unknown> | null> {
  const resp = await fetch(`${FACILITATOR_URL}/__mock/last-request`);
  return resp.json() as Promise<Record<string, unknown> | null>;
}

/** Get all verify requests received by the mock facilitator. */
export async function getFacilitatorRequests(): Promise<unknown[]> {
  const resp = await fetch(`${FACILITATOR_URL}/__mock/requests`);
  return resp.json() as Promise<unknown[]>;
}

/** Decode PAYMENT-REQUIRED header (base64 JSON). */
export function decodePaymentRequired(header: string): Record<string, unknown> {
  return JSON.parse(atob(header));
}

/** Base64-encode a v2 payment payload for PAYMENT-SIGNATURE header. */
export function encodePaymentSignature(payload: Record<string, unknown>): string {
  return btoa(JSON.stringify(payload));
}

/** Helper: assert status code. */
export function assertStatus(resp: Response, expected: number, context?: string): void {
  if (resp.status !== expected) {
    throw new Error(
      `Expected status ${expected}, got ${resp.status}${context ? ` (${context})` : ""}`
    );
  }
}
