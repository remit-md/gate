import type { PaymentRequirementsV2, VerifyRequestV2, VerifyResponseV2 } from "./types";

const FACILITATOR_TIMEOUT_MS = 5_000;

/**
 * Call the Pay facilitator's /verify endpoint with v2 wire format.
 * Decodes PAYMENT-SIGNATURE from base64 into a JSON payload.
 * Returns the verify response, or null if the facilitator is unreachable.
 */
export async function verifyPayment(
  facilitatorUrl: string,
  paymentHeader: string,
  requirements: PaymentRequirementsV2,
): Promise<VerifyResponseV2 | null> {
  let paymentPayload: Record<string, unknown>;
  try {
    paymentPayload = JSON.parse(atob(paymentHeader)) as Record<string, unknown>;
  } catch {
    // Malformed base64 or invalid JSON — return 402 (bad payment), not
    // null (which the gate interprets as "facilitator unreachable" → 503).
    return { isValid: false, invalidReason: "malformed payment signature" };
  }

  // Network enforcement: reject payment signed for the wrong chain before
  // hitting the facilitator. Catches testnet-vs-mainnet mismatches at the edge.
  const accepted = paymentPayload.accepted as Record<string, unknown> | undefined;
  if (accepted?.network && accepted.network !== requirements.network) {
    console.warn(
      `Payment signed for wrong network: expected ${requirements.network}, got ${accepted.network}`,
    );
    return {
      isValid: false,
      invalidReason: `wrong network: expected ${requirements.network}, got ${String(accepted.network)}`,
    };
  }

  const body: VerifyRequestV2 = {
    x402Version: 2,
    paymentPayload,
    paymentRequirements: requirements,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FACILITATOR_TIMEOUT_MS);

  try {
    const resp = await fetch(`${facilitatorUrl}/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!resp.ok) {
      console.error(`Facilitator returned ${resp.status}: ${await resp.text()}`);
      return null;
    }

    return (await resp.json()) as VerifyResponseV2;
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      console.error("Facilitator timeout after 5s");
    } else {
      console.error("Facilitator error:", err);
    }
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Check if the facilitator is reachable (for health endpoint).
 */
export async function checkFacilitatorHealth(facilitatorUrl: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3_000);

  try {
    const resp = await fetch(`${facilitatorUrl}/supported`, {
      signal: controller.signal,
    });
    return resp.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
