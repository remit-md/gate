/**
 * Mock origin server that echoes headers and returns test data.
 * Used by acceptance tests to verify pay-gate injects correct headers.
 */
import { createServer, IncomingMessage, ServerResponse } from "node:http";

export interface OriginRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body?: string;
}

let requests: OriginRequest[] = [];

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const body = await readBody(req);

  // Record every proxied request so tests can assert on injected headers.
  // Skip internal control URLs — otherwise getOriginRequests() always
  // returns /__test/requests as the last entry and tests that look at
  // `requests[last]` see the harness's own poll instead of the gated
  // request under test.
  if (!req.url?.startsWith("/__test/")) {
    const record: OriginRequest = {
      method: req.method || "GET",
      url: req.url || "/",
      headers: req.headers as Record<string, string | string[] | undefined>,
      body: body || undefined,
    };
    requests.push(record);
  }

  // Special endpoints
  if (req.url === "/__test/requests") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(requests));
    return;
  }

  if (req.url === "/__test/clear") {
    requests = [];
    res.writeHead(200);
    res.end("cleared");
    return;
  }

  // Dynamic pricing endpoint
  if (req.url === "/internal/pricing") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ price: "0.05" }));
    return;
  }

  // Echo received headers in response body (for test assertions)
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    echo: true,
    path: req.url,
    method: req.method,
    headers: {
      "x-pay-verified": req.headers["x-pay-verified"],
      "x-pay-from": req.headers["x-pay-from"],
      "x-pay-amount": req.headers["x-pay-amount"],
      "x-pay-settlement": req.headers["x-pay-settlement"],
      "x-pay-tab": req.headers["x-pay-tab"],
    },
  }));
});

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
  });
}

const PORT = parseInt(process.env["MOCK_ORIGIN_PORT"] || "9090", 10);
server.listen(PORT, () => {
  console.log(`Mock origin listening on :${PORT}`);
});

export { server, requests };
