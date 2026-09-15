/**
 * Build and deploy (or preview) the app on Cloudflare Workers through OpenNext.
 *
 *   node scripts/cloudflare.mjs deploy
 *   node scripts/cloudflare.mjs preview
 *
 * Wrangler insists on a local Postgres url for the Hyperdrive binding even when it only deploys, so
 * this hands it DATABASE_URL from .env.local. That url never goes into wrangler.jsonc.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const command = process.argv[2];
if (command !== "deploy" && command !== "preview") {
  console.error("usage: node scripts/cloudflare.mjs deploy|preview");
  process.exit(1);
}

if (existsSync(".env.local")) process.loadEnvFile(".env.local");
const env = { ...process.env };
if (env.DATABASE_URL && !env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE) {
  env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE = env.DATABASE_URL;
}

for (const step of ["build", command]) {
  const run = spawnSync("npx", ["opennextjs-cloudflare", step], {
    env,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (run.status !== 0) process.exit(run.status ?? 1);
}
