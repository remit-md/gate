/**
 * pay-gate config validation tests — tests the CLI validate command.
 *
 * Requires PAY_GATE_BINARY env var pointing to the compiled binary.
 * Skipped for CF Worker target.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const BINARY = process.env["PAY_GATE_BINARY"];
const TARGET = process.env["TARGET"] || "rust";

function writeConfig(dir: string, content: string): string {
  const path = join(dir, "test-config.yaml");
  writeFileSync(path, content);
  return path;
}

function validate(configPath: string): { ok: boolean; output: string } {
  try {
    const out = execFileSync(BINARY!, ["validate", "--config", configPath], {
      encoding: "utf-8",
      timeout: 5000,
    });
    return { ok: true, output: out };
  } catch (e: unknown) {
    const err = e as { stderr?: string; stdout?: string };
    return { ok: false, output: (err.stderr || err.stdout || "").toString() };
  }
}

describe("pay-gate config validation", () => {
  if (TARGET !== "rust" || !BINARY) {
    it("skipped — config validation only tests Rust binary", () => {});
    return;
  }

  let tmpDir: string;

  it("rejects invalid provider address", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "gate-test-"));
    const path = writeConfig(tmpDir, `
version: 1
provider_address: "not-an-address"
proxy:
  target: "http://localhost:8080"
routes: []
default_action: "passthrough"
`);
    const result = validate(path);
    assert.equal(result.ok, false, "Should reject invalid address");
    assert.ok(result.output.includes("invalid"), `Output: ${result.output}`);
    rmSync(tmpDir, { recursive: true });
  });

  it("rejects invalid proxy target URL", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "gate-test-"));
    const path = writeConfig(tmpDir, `
version: 1
provider_address: "0x1234567890abcdef1234567890abcdef12345678"
proxy:
  target: "not-a-url"
routes: []
default_action: "passthrough"
`);
    const result = validate(path);
    assert.equal(result.ok, false, "Should reject invalid URL");
    rmSync(tmpDir, { recursive: true });
  });

  it("rejects zero price", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "gate-test-"));
    const path = writeConfig(tmpDir, `
version: 1
provider_address: "0x1234567890abcdef1234567890abcdef12345678"
proxy:
  target: "http://localhost:8080"
routes:
  - path: "/api/*"
    price: "0.00"
default_action: "passthrough"
`);
    const result = validate(path);
    assert.equal(result.ok, false, "Should reject zero price");
    rmSync(tmpDir, { recursive: true });
  });

  it("rejects route with no price and not free", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "gate-test-"));
    const path = writeConfig(tmpDir, `
version: 1
provider_address: "0x1234567890abcdef1234567890abcdef12345678"
proxy:
  target: "http://localhost:8080"
routes:
  - path: "/api/*"
default_action: "passthrough"
`);
    const result = validate(path);
    assert.equal(result.ok, false, "Should reject route with no price and not free");
    rmSync(tmpDir, { recursive: true });
  });

  it("accepts valid config", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "gate-test-"));
    const path = writeConfig(tmpDir, `
version: 1
provider_address: "0x1234567890abcdef1234567890abcdef12345678"
proxy:
  target: "http://localhost:8080"
routes:
  - path: "/api/*"
    price: "0.01"
  - path: "/health"
    free: true
default_action: "passthrough"
`);
    const result = validate(path);
    assert.equal(result.ok, true, `Should accept valid config. Output: ${result.output}`);
    rmSync(tmpDir, { recursive: true });
  });
});
