#!/usr/bin/env node

import { createInterface } from "node:readline/promises";
import { stdin, stdout, argv } from "node:process";
import { mkdirSync, writeFileSync, copyFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = join(__dirname, "..", "template");

async function main(): Promise<void> {
  const projectName = argv[2] || "";

  console.log();
  console.log("  pay-gate — x402 payment gateway for Cloudflare Workers");
  console.log();

  const rl = createInterface({ input: stdin, output: stdout });

  const name = projectName || await rl.question("  Project name: ");
  const providerAddress = await rl.question("  Provider wallet address (0x...): ");
  const proxyTarget = await rl.question("  Origin URL (e.g. https://api.example.com): ");
  const defaultRoute = await rl.question("  Paid route glob (e.g. /api/v1/*): ");
  const priceStr = await rl.question("  Price per request in USD (e.g. 0.01): ");

  rl.close();

  if (!name) {
    console.error("  Error: project name is required.");
    process.exit(1);
  }
  if (!providerAddress.startsWith("0x") || providerAddress.length !== 42) {
    console.error("  Error: provider address must be a 42-character hex address (0x...).");
    process.exit(1);
  }
  if (!proxyTarget.startsWith("http")) {
    console.error("  Error: origin URL must start with http:// or https://.");
    process.exit(1);
  }

  const price = parseFloat(priceStr) || 0.01;
  const settlement = price <= 1.0 ? "tab" : "direct";

  const outDir = resolve(name);
  if (existsSync(outDir)) {
    console.error(`  Error: directory "${name}" already exists.`);
    process.exit(1);
  }

  // Create project
  mkdirSync(join(outDir, "src"), { recursive: true });

  // Copy template source files
  const templateSrc = join(TEMPLATE_DIR, "src");
  for (const file of readdirSync(templateSrc)) {
    copyFileSync(join(templateSrc, file), join(outDir, "src", file));
  }

  // Generate wrangler.toml
  writeFileSync(join(outDir, "wrangler.toml"), wranglerToml(name, providerAddress, proxyTarget));

  // Generate package.json
  writeFileSync(join(outDir, "package.json"), packageJson(name));

  // Copy tsconfig.json
  copyFileSync(join(TEMPLATE_DIR, "tsconfig.json"), join(outDir, "tsconfig.json"));

  // Generate routes.json (initial KV data)
  writeFileSync(join(outDir, "routes.json"), routesJson(defaultRoute, price.toString(), settlement));

  console.log();
  console.log(`  Created ${name}/`);
  console.log();
  console.log("  Next steps:");
  console.log(`    cd ${name}`);
  console.log("    npm install");
  console.log("    # Create KV namespace: npx wrangler kv namespace create ROUTES");
  console.log("    # Update wrangler.toml with the KV namespace ID");
  console.log("    # Upload routes: npx wrangler kv bulk put routes.json --namespace-id <id>");
  console.log("    npx wrangler dev     # local development");
  console.log("    npx wrangler deploy  # deploy to Cloudflare");
  console.log();
}

function wranglerToml(name: string, provider: string, target: string): string {
  return `name = "${name}"
main = "src/index.ts"
compatibility_date = "2026-04-01"

[vars]
PROVIDER_ADDRESS = "${provider}"
PROXY_TARGET = "${target}"
DEFAULT_ACTION = "passthrough"
FAIL_MODE = "closed"
FACILITATOR_URL = "https://pay-skill.com/x402"
LOG_LEVEL = "info"

[[kv_namespaces]]
binding = "ROUTES"
id = "REPLACE_WITH_KV_NAMESPACE_ID"
`;
}

function packageJson(name: string): string {
  return JSON.stringify({
    name,
    version: "0.1.0",
    private: true,
    type: "module",
    scripts: {
      dev: "wrangler dev",
      deploy: "wrangler deploy",
      typecheck: "tsc --noEmit",
    },
    dependencies: {
      hono: "^4.4.0",
    },
    devDependencies: {
      "@cloudflare/workers-types": "^4.20240620.0",
      typescript: "^5.5.0",
      wrangler: "^3.60.0",
    },
  }, null, 2) + "\n";
}

function routesJson(path: string, price: string, settlement: string): string {
  const routes = [
    { path: path || "/api/*", price, settlement },
    { path: "/health", free: true },
  ];
  return JSON.stringify(routes, null, 2) + "\n";
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
