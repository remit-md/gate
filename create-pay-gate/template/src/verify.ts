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
  let paymentPayload: unknown;
  try {
    paymentPayload = JSON.parse(atob(paymentHeader));
  } catch {
    return null;
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
