import type { BazaarInfo, HttpBodyInput } from "./types";

/** Structured 400 error returned when request fails info-block validation. */
export interface ValidationError {
  error: "invalid_request";
  message: string;
  docs: string;
}

const DOCS_URL = "https://pay-skill.com/docs/gate";

/**
 * Validate a full request against the route's info block.
 * Returns null if valid, ValidationError if invalid.
 *
 * Checks (in order):
 *   1. Required query params present
 *   2. Content-Type matches bodyType (POST/PUT/PATCH only)
 *   3. Required JSON body fields present (clones request to read body)
 *
 * MCP inputs are skipped (MCP transport validates its own payloads).
 * pathParams validation is deferred to P26-4 (routeTemplate).
 */
export async function validateRequest(
  req: Request,
  url: URL,
  info: BazaarInfo,
): Promise<ValidationError | null> {
  if (info.input.type !== "http") return null;

  const qpErr = validateQueryParams(url, info.input);
  if (qpErr) return qpErr;

  if ("bodyType" in info.input) {
    return validateBody(req, info.input as HttpBodyInput);
  }

  return null;
}

/**
 * Validate query params from a URI string (no body access needed).
 * Used by the sidecar path where only the original URI is available.
 */
export function validateQueryParamsFromUri(
  uri: string,
  info: BazaarInfo,
): ValidationError | null {
  if (info.input.type !== "http") return null;
  if (!("queryParams" in info.input) || !info.input.queryParams) return null;
  try {
    const url = new URL(uri, "http://localhost");
    return validateQueryParams(url, info.input);
  } catch {
    return null;
  }
}

// ── Internal helpers ────────────────────────────────────────────

function validateQueryParams(
  url: URL,
  input: { queryParams?: Record<string, { required?: boolean }> },
): ValidationError | null {
  if (!input.queryParams) return null;
  for (const [name, def] of Object.entries(input.queryParams)) {
    if (def.required && !url.searchParams.has(name)) {
      return {
        error: "invalid_request",
        message: `Missing required query parameter: ${name}`,
        docs: DOCS_URL,
      };
    }
  }
  return null;
}

async function validateBody(
  req: Request,
  input: HttpBodyInput,
): Promise<ValidationError | null> {
  const ct = req.headers.get("content-type") || "";

  const ctErr = checkContentType(ct, input.bodyType);
  if (ctErr) return ctErr;

  if (input.bodyType === "json") {
    return validateJsonBody(req, input.body);
  }
  return null;
}

function checkContentType(
  actual: string,
  expected: "json" | "form-data" | "text",
): ValidationError | null {
  const mapping: Record<string, string> = {
    json: "application/json",
    "form-data": "multipart/form-data",
    text: "text/",
  };
  const required = mapping[expected];
  if (required && !actual.includes(required)) {
    return {
      error: "invalid_request",
      message: `Expected Content-Type containing ${required}, got: ${actual || "(none)"}`,
      docs: DOCS_URL,
    };
  }
  return null;
}

async function validateJsonBody(
  req: Request,
  schema: Record<string, unknown>,
): Promise<ValidationError | null> {
  const required = schema.required;
  if (!Array.isArray(required) || required.length === 0) return null;

  let body: unknown;
  try {
    const clone = req.clone();
    body = await clone.json();
  } catch {
    return {
      error: "invalid_request",
      message: "Invalid JSON body",
      docs: DOCS_URL,
    };
  }

  if (typeof body !== "object" || body === null) {
    return {
      error: "invalid_request",
      message: "Request body must be a JSON object",
      docs: DOCS_URL,
    };
  }

  for (const field of required) {
    if (typeof field === "string" && !(field in (body as Record<string, unknown>))) {
      return {
        error: "invalid_request",
        message: `Missing required body field: ${field}`,
        docs: DOCS_URL,
      };
    }
  }
  return null;
}
