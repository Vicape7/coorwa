/**
 * Write the launch program's configuration to Cookie Chain.
 *
 *   npm run launch:config            read what is on chain and print what would change
 *   npm run launch:config -- --send  sign and send it
 *
 * CORWA_GRADUATION_COOK sets a smaller graduation target for a test launch; see below.
 *
 * The config account is created once and then edited, and it is what every launch after it
 * promises: the curve's shape, the graduation target, the tax tiers a creator picks between, and
 * where the fees go. The numbers come from `src/lib/launch-params.ts` so the app and the chain
 * cannot disagree about them, and nothing is sent without `--send`.
 *
 * The signing key is CORWA_CONFIG_WALLET, falling back to CORWA_DEPLOY_WALLET: the wallet that owns
 * the deployment is the natural authority for its config. It pays the rent for the account the
 * first time and nothing after that.
 */
import { readFileSync, existsSync } from "node:fs";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import {
  configPda,
  fetchLaunchConfig,
  initializeConfigIx,
  updateConfigIx,
} from "../src/lib/launch-program.ts";
import { launchConfigParams } from "../src/lib/launch-params.ts";
import { COOK_MINT } from "../src/lib/config.ts";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

const send = process.argv.includes("--send");
const rpc = process.env.NEXT_PUBLIC_COOKIE_RPC_URL?.trim() || "https://rpc.cookiescan.io";
const operator = process.env.NEXT_PUBLIC_COORWA_OPERATOR?.trim();
const walletPath = (
  process.env.CORWA_CONFIG_WALLET || process.env.CORWA_DEPLOY_WALLET || ""
).trim();

if (!operator) {
  console.error("NEXT_PUBLIC_COORWA_OPERATOR is not set, and it is where every fee lands.");
  process.exit(1);
}
// Reading needs no key at all, so the dry run works before anyone has one to hand.
if (send && (!walletPath || !existsSync(walletPath))) {
  console.error(
    "Set CORWA_CONFIG_WALLET (or CORWA_DEPLOY_WALLET) to the keypair file that owns the program.",
  );
  process.exit(1);
}

const authority = walletPath && existsSync(walletPath)
  ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(walletPath, "utf8"))))
  : null;
// A test raise on a smaller target, e.g. CORWA_GRADUATION_COOK=12000. Curves copy the target when
// they open, so running the script again without it puts later launches back on 1M COOK and leaves
// the test curve as it was.
const testTarget = process.env.CORWA_GRADUATION_COOK?.trim();
const params = testTarget
  ? launchConfigParams(operator, BigInt(testTarget) * 10n ** 9n)
  : launchConfigParams(operator);
const connection = new Connection(rpc, "confirmed");

/** The instruction builders take keys and bigints; the parameters are written as plain values. */
const encoded = {
  ...params,
  feeRecipient: new PublicKey(params.feeRecipient),
  withholdAuthority: new PublicKey(params.withholdAuthority),
  dammConfig: new PublicKey(params.dammConfig),
};

const COOK = 10n ** 9n;
const TOKEN = 10n ** BigInt(params.tokenDecimals);

console.log(`rpc:       ${rpc}`);
console.log(`config:    ${configPda().toBase58()}`);
console.log(`authority: ${authority ? authority.publicKey.toBase58() : "not set, reading only"}`);
console.log("");
console.log(`fees to:        ${params.feeRecipient}`);
console.log(`tax swept by:   ${params.withholdAuthority}`);
console.log(`curve fee:      ${params.curveFeeBps / 100}%`);
console.log(`creator LP:     ${params.creatorLpShareBps / 100}% of the locked pool's fees`);
console.log(`tax tiers:      ${params.taxTiers.filter((t) => t > 0).map((t) => `${t / 100}%`).join(", ")}`);
console.log(`graduates at:   ${params.graduationQuote / COOK} COOK`);
console.log(`sells:          ${params.saleBase / TOKEN} tokens, ${params.migrationBase / TOKEN} to the pool`);
console.log(`pool config:    ${params.dammConfig}`);
console.log("");

const existing = await fetchLaunchConfig(connection);
if (existing) {
  console.log("a config account already exists on chain:");
  console.log(`  fees to:      ${existing.feeRecipient.toBase58()}`);
  console.log(`  curve fee:    ${existing.curveFeeBps / 100}%`);
  console.log(`  graduates at: ${existing.graduationQuote / COOK} COOK`);
  console.log(`  paused:       ${existing.paused}`);
  console.log("");
  console.log("--send would UPDATE it to the values above.");
} else {
  console.log("no config account yet; --send would create it.");
}

if (!send) {
  console.log("\nnothing sent. Add -- --send to write it.");
  process.exit(0);
}

const ix = existing
  ? updateConfigIx(authority.publicKey, encoded)
  : initializeConfigIx(authority.publicKey, new PublicKey(COOK_MINT), encoded);

const tx = new Transaction().add(ix);
tx.feePayer = authority.publicKey;
tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
tx.sign(authority);

const signature = await connection.sendRawTransaction(tx.serialize(), {
  preflightCommitment: "confirmed",
});
const blockhash = await connection.getLatestBlockhash("confirmed");
const result = await connection.confirmTransaction(
  { signature, ...blockhash },
  "confirmed",
);
if (result.value.err) {
  console.error(`\nrejected: ${JSON.stringify(result.value.err)}`);
  console.error(signature);
  process.exit(1);
}
console.log(`\n${existing ? "updated" : "created"}: ${signature}`);
