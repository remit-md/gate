/**
 * Mock facilitator for unit-level acceptance tests.
 * Returns configurable verify responses.
 */
import { createServer, IncomingMessage, ServerResponse } from "node:http";

export interface MockVerifyBehavior {
  valid: boolean;
  reason?: string;
  receipt?: string;
  from?: string;
  tab?: string;
}

let defaultBehavior: MockVerifyBehavior = {
  valid: true,
  receipt: "mock-receipt-abc123",
  from: "0xmockagent0000000000000000000000000000001",
};

let overrides: Map<string, MockVerifyBehavior> = new Map();
let verifyCallCount = 0;
let isDown = false;

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

  // POST /verify
  if (req.url === "/verify" && req.method === "POST") {
    verifyCallCount++;
    if (isDown) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "service_unavailable" }));
      return;
    }
    const body = await readBody(req);
    const parsed = JSON.parse(body);

    // Check if there's an override for this payment value
    const behavior = overrides.get(parsed.payment) || defaultBehavior;

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
      valid: true,
      receipt: "mock-receipt-abc123",
      from: "0xmockagent0000000000000000000000000000001",
    };
    overrides.clear();
    verifyCallCount = 0;
    isDown = false;
    res.writeHead(200);
    res.end("ok");
    return;
  }

  if (req.url === "/__mock/call-count" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ count: verifyCallCount }));
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
