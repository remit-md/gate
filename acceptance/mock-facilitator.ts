/**
 * Mock facilitator for acceptance tests — x402 v2 wire format.
 * Accepts v2 verify requests, returns v2 responses.
 * Records all received verify requests for test assertions.
 */
import { createServer, IncomingMessage, ServerResponse } from "node:http";

export interface MockVerifyBehavior {
  isValid: boolean;
  invalidReason?: string;
  payer?: string;
}

let defaultBehavior: MockVerifyBehavior = {
  isValid: true,
  payer: "0xmockagent0000000000000000000000000000001",
};

let overrides: Map<string, MockVerifyBehavior> = new Map();
let verifyCallCount = 0;
let isDown = false;
let lastVerifyRequest: unknown = null;
let verifyRequests: unknown[] = [];

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  // GET /supported — health check
  if (req.url === "/supported" && req.method === "GET") {
    if (isDown) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "service_unavailable" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ direct: true, tab: true }));
    return;
  }

  // POST /verify — v2 format
  if (req.url === "/verify" && req.method === "POST") {
    verifyCallCount++;
    if (isDown) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "service_unavailable" }));
      return;
    }
    const body = await readBody(req);
    const parsed = JSON.parse(body);

    // Record for test assertions
    lastVerifyRequest = parsed;
    verifyRequests.push(parsed);

    // Validate v2 format
    if (parsed.x402Version !== 2) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ isValid: false, invalidReason: "x402Version must be 2" }));
      return;
    }

    if (typeof parsed.paymentPayload !== "object" || parsed.paymentPayload === null) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ isValid: false, invalidReason: "paymentPayload must be an object" }));
      return;
    }

    const reqs = parsed.paymentRequirements;
    if (!reqs || !reqs.network || !reqs.payTo || !reqs.asset) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ isValid: false, invalidReason: "invalid paymentRequirements" }));
      return;
    }

    // Use a key from paymentPayload for override lookup (if it has a signature or test marker)
    const payloadStr = JSON.stringify(parsed.paymentPayload);
    const behavior = overrides.get(payloadStr) || defaultBehavior;

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(behavior));
    return;
  }

  // Control endpoints for tests
  if (req.url === "/__mock/set-default" && req.method === "POST") {
    const body = await readBody(req);
    defaultBehavior = JSON.parse(body);
    res.writeHead(200);
    res.end("ok");
    return;
  }

  if (req.url === "/__mock/set-override" && req.method === "POST") {
    const body = await readBody(req);
    const { payment, behavior } = JSON.parse(body);
    overrides.set(payment, behavior);
    res.writeHead(200);
    res.end("ok");
    return;
  }

  if (req.url === "/__mock/set-down" && req.method === "POST") {
    isDown = true;
    res.writeHead(200);
    res.end("ok");
    return;
  }

  if (req.url === "/__mock/set-up" && req.method === "POST") {
    isDown = false;
    res.writeHead(200);
    res.end("ok");
    return;
  }

  if (req.url === "/__mock/reset" && req.method === "POST") {
    defaultBehavior = {
      isValid: true,
      payer: "0xmockagent0000000000000000000000000000001",
    };
    overrides.clear();
    verifyCallCount = 0;
    isDown = false;
    lastVerifyRequest = null;
    verifyRequests = [];
    res.writeHead(200);
    res.end("ok");
    return;
  }

  if (req.url === "/__mock/call-count" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ count: verifyCallCount }));
    return;
  }

  if (req.url === "/__mock/last-request" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(lastVerifyRequest));
    return;
  }

  if (req.url === "/__mock/requests" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(verifyRequests));
    return;
  }

  res.writeHead(404);
  res.end("not found");
});

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
  });
}

const PORT = parseInt(process.env["MOCK_FACILITATOR_PORT"] || "9091", 10);
server.listen(PORT, () => {
  console.log(`Mock facilitator listening on :${PORT}`);
});

export { server };
