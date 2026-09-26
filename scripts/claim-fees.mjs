/**
 * Claim the launch program's fees by hand, with exactly the plan the hourly pass would send.
 *
 *   npm run launch:claim                     every curve, measured, nothing sent
 *   npm run launch:claim -- <mint>           one curve
 *   npm run launch:claim -- [<mint>] --send  and send what is due
 *
 * Both claims are permissionless and pay only where the config and the curve say, so the payer only
 * covers the transaction fee and any token account the claim has to open. It is CORWA_CLAIM_WALLET,
 * falling back to CORWA_DEPLOY_WALLET; a dry run needs no key and measures as the operator.
 */
import { readFileSync, existsSync } from "node:fs";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { fetchCurve, fetchCurves, fetchLaunchConfig } from "../src/lib/launch-program.ts";
import { planCurveFeeClaim, planPoolFeeClaim, sendFeeClaim } from "../src/lib/fee-claims.ts";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

const args = process.argv.slice(2);
const send = args.includes("--send");
const mintArg = args.find((a) => !a.startsWith("--"));
const rpc = process.env.NEXT_PUBLIC_COOKIE_RPC_URL?.trim() || "https://rpc.cookiescan.io";
const walletPath = (process.env.CORWA_CLAIM_WALLET || process.env.CORWA_DEPLOY_WALLET || "").trim();

if (send && (!walletPath || !existsSync(walletPath))) {
  console.error("Set CORWA_CLAIM_WALLET (or CORWA_DEPLOY_WALLET) to the keypair file that pays.");
  process.exit(1);
}

const payer = walletPath && existsSync(walletPath)
  ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(walletPath, "utf8"))))
  : null;
const connection = new Connection(rpc, "confirmed");
const config = await fetchLaunchConfig(connection);
if (!config) {
  console.error("no launch config on chain");
  process.exit(1);
}
// A simulation needs a fee payer that exists, not a signature, so the operator stands in.
const payerKey = payer?.publicKey ?? config.feeRecipient;
const COOK = 1e9;

console.log(`rpc:        ${rpc}`);
console.log(`fees to:    ${config.feeRecipient.toBase58()}`);
console.log(`payer:      ${payerKey.toBase58()}${payer ? "" : " (standing in for the simulation)"}\n`);

const curves = mintArg
  ? [await fetchCurve(connection, new PublicKey(mintArg))].filter(Boolean)
  : await fetchCurves(connection);
// No process.exit past this point: on Windows, exiting while the RPC's sockets are still closing
// trips an assertion inside Node, so the script ends by running out of work instead.
if (curves.length === 0) console.log("no curve for that mint");

for (const curve of curves) {
  console.log(`${curve.mint.toBase58()}  ${curve.state}`);
  const plans = [
    planCurveFeeClaim(curve, payerKey, config.feeRecipient),
    await planPoolFeeClaim(connection, curve, payerKey, config.feeRecipient),
  ];
  for (const [i, plan] of plans.entries()) {
    const what = i === 0 ? "curve fee" : "pool fees";
    if (plan.kind === "none") {
      console.log(`  ${what}: ${plan.reason}`);
      continue;
    }
    if (plan.kind === "failed") {
      console.log(`  ${what}: ${plan.reason}`);
      console.log(plan.logs.map((l) => `    ${l}`).join("\n"));
      continue;
    }
    console.log(
      `  ${what}: ${Number(plan.toPlatform) / COOK} COOK to Coorwa, ${Number(plan.toCreator) / COOK} COOK to the creator` +
        (plan.baseToPlatform + plan.baseToCreator > 0n
          ? `, ${plan.baseToPlatform} + ${plan.baseToCreator} raw tokens`
          : ""),
    );
    if (send) {
      console.log(`    claimed: ${await sendFeeClaim(connection, plan, payer)}`);
    } else if (plan.kind === "curve") {
      // The pool claim was measured by simulating it already; the curve claim is simulated here.
      const tx = new Transaction().add(...plan.instructions);
      tx.feePayer = payerKey;
      tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
      const sim = await connection.simulateTransaction(tx.compileMessage());
      console.log(`    simulated: ${sim.value.err ? JSON.stringify(sim.value.err) : "ok"}`);
    }
  }
}
if (!send) console.log("\nnothing sent. Add -- --send to claim what is due.");
