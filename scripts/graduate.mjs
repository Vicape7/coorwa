/**
 * Graduate a filled curve by hand, with exactly the plan the scheduled crank would send.
 *
 *   npm run launch:graduate                     every curve waiting for its pool, measured, nothing sent
 *   npm run launch:graduate -- <mint>           one curve
 *   npm run launch:graduate -- <mint> --send    and send it
 *
 * The crank stays off until one graduation on the real chain has been watched, and this is how that
 * one is done. The payer is CORWA_GRADUATE_WALLET, falling back to CORWA_DEPLOY_WALLET: graduating is
 * permissionless, so any funded wallet will do, and it pays the rent for the pool's accounts.
 */
import { readFileSync, existsSync } from "node:fs";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { fetchCurve, fetchCurves } from "../src/lib/launch-program.ts";
import { planGraduation, sendGraduation } from "../src/lib/graduation-crank.ts";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

const args = process.argv.slice(2);
const send = args.includes("--send");
const mintArg = args.find((a) => !a.startsWith("--"));
const rpc = process.env.NEXT_PUBLIC_COOKIE_RPC_URL?.trim() || "https://rpc.cookiescan.io";
const walletPath = (process.env.CORWA_GRADUATE_WALLET || process.env.CORWA_DEPLOY_WALLET || "").trim();

if (!walletPath || !existsSync(walletPath)) {
  console.error("Set CORWA_GRADUATE_WALLET (or CORWA_DEPLOY_WALLET) to the keypair file that pays.");
  process.exit(1);
}
if (send && !mintArg) {
  console.error("--send graduates one curve at a time: name its mint.");
  process.exit(1);
}

const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(walletPath, "utf8"))));
const connection = new Connection(rpc, "confirmed");
const COOK = 1e9;

console.log(`rpc:   ${rpc}`);
console.log(`payer: ${payer.publicKey.toBase58()} (${(await connection.getBalance(payer.publicKey)) / COOK} COOK)\n`);

const curves = mintArg
  ? [await fetchCurve(connection, new PublicKey(mintArg))].filter(Boolean)
  : (await fetchCurves(connection)).filter((c) => c.state === "graduated");
// No process.exit past this point: on Windows, exiting while the RPC's sockets are still closing
// trips an assertion inside Node, so the script ends by running out of work instead.
if (curves.length === 0) console.log(mintArg ? "no curve for that mint" : "no curve is waiting for its pool");

for (const curve of curves) {
  console.log(`${curve.mint.toBase58()}  ${curve.state}, ${Number(curve.quoteRaised) / COOK} COOK raised`);
  const plan = await planGraduation(connection, curve, payer.publicKey);
  if (!("instructions" in plan)) {
    console.log(`  ${plan.kind}: ${plan.reason}${plan.until ? ` (until ${plan.until.toISOString()})` : ""}`);
    if (plan.kind === "failed") console.log(plan.logs.map((l) => `    ${l}`).join("\n"));
    continue;
  }
  console.log(`  route:     ${plan.kind === "fresh" ? "graduate, the pool's address is free" : "graduate_into_pool, somebody opened the pool first"}`);
  if (plan.kind === "into") console.log(`  swap in:   ${plan.swapIn} raw units, to bring the pool to the curve's price`);
  console.log(`  liquidity: ${plan.liquidity}`);
  console.log(`  rent:      ${plan.rent / COOK} COOK to the vault authority, measured`);
  console.log(`  compute:   ${plan.units} units`);
  console.log(`  simulated: ok`);

  if (!send) {
    console.log("\nnothing sent. Add -- <mint> --send to graduate it.");
    continue;
  }
  const signature = await sendGraduation(connection, plan, payer);
  const after = await fetchCurve(connection, curve.mint);
  console.log(`\ngraduated: ${signature}`);
  console.log(`curve is now ${after?.state}, position NFT ${after?.positionNftMint.toBase58()}`);
}
