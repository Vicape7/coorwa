#!/usr/bin/env node
/**
 * Build and deploy the cashback vault program.
 *
 * The Solana toolchain is not a normal npm dependency: it is a specific Rust, a specific Agave and
 * a specific Anchor, and getting all three onto a Windows machine by hand is a day nobody gets
 * back. So the toolchain is a container image, pinned by tag, and this script is the only thing
 * that has to know that. `npm run program:build` produces the same bytes on any machine with
 * Docker running.
 *
 *   npm run program:build     compile, then copy the IDL next to the source
 *   npm run program:test      run tests/integration against a throwaway validator and postgres
 *   npm run program:deploy    send it to Cookie Chain (needs a funded wallet, see below)
 *
 * Deploying is the one step that spends money and cannot be undone quietly, so it never runs by
 * accident: it wants CORWA_DEPLOY_WALLET pointing at a keypair file and refuses without it.
 */
import { spawnSync } from "node:child_process";
import { existsSync, copyFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

/** Rust 1.90 on the host side, Agave 2.3.0 and platform-tools v1.48 for the program itself. */
const IMAGE = "solanafoundation/anchor:v0.32.1";
/** Named volume for the cargo registry, so a rebuild does not re-download the world. */
const CARGO_VOLUME = "corwa-cargo32";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROGRAM = "corwa_vault";

function docker() {
  const onPath = spawnSync("docker", ["--version"], { encoding: "utf8" });
  if (onPath.status === 0) return "docker";

  const fallback = join(
    process.env.LOCALAPPDATA ?? "",
    "Programs",
    "DockerDesktop",
    "resources",
    "bin",
    "docker.exe",
  );
  if (existsSync(fallback)) return fallback;

  throw new Error("Docker is not on PATH. Start Docker Desktop, or install Docker, then try again.");
}

/** Run one shell line inside the toolchain image with the repo mounted at /work. */
function inContainer(script, { extraArgs = [] } = {}) {
  const args = [
    "run",
    "--rm",
    "-v",
    `${ROOT}:/work`,
    "-v",
    `${CARGO_VOLUME}:/cargo`,
    "-e",
    "CARGO_HOME=/cargo",
    "-w",
    "/work",
    ...extraArgs,
    IMAGE,
    "bash",
    "-lc",
    script,
  ];
  // Arguments are passed as an array rather than a command line, which is the only reliable way to
  // keep a container path like /work from being rewritten by the Windows shell.
  const res = spawnSync(docker(), args, { stdio: "inherit", encoding: "utf8" });
  if (res.error) throw res.error;
  return res.status ?? 1;
}

function build() {
  console.log(`building ${PROGRAM} with ${IMAGE}\n`);
  const code = inContainer("anchor build");
  if (code !== 0) return code;

  const so = join(ROOT, "target", "deploy", `${PROGRAM}.so`);
  const idl = join(ROOT, "target", "idl", `${PROGRAM}.json`);
  if (!existsSync(so)) {
    console.error("the build reported success but produced no .so");
    return 1;
  }

  // The IDL lives next to the source, not only in target/, because it is the record of what the
  // deployed program actually accepts. `tests/vault-idl.test.ts` checks the hand-written client
  // against this file, so a change to the program that the client has not followed fails a test
  // rather than a transaction.
  if (existsSync(idl)) {
    mkdirSync(join(ROOT, "programs", "corwa-vault"), { recursive: true });
    copyFileSync(idl, join(ROOT, "programs", "corwa-vault", "idl.json"));
    console.log("\nidl   programs/corwa-vault/idl.json");
  }

  const bytes = readFileSync(so);
  console.log(`so    target/deploy/${PROGRAM}.so`);
  console.log(`size  ${statSync(so).size.toLocaleString("en-US")} bytes`);
  console.log(`sha256 ${createHash("sha256").update(bytes).digest("hex")}`);
  return 0;
}

function deploy() {
  const wallet = process.env.CORWA_DEPLOY_WALLET?.trim();
  if (!wallet) {
    console.error(
      [
        "Set CORWA_DEPLOY_WALLET to the keypair file that pays for and owns the deployment.",
        "",
        "That wallet needs enough COOK for the program account, which is roughly the size of the",
        ".so in lamports-per-byte-year terms, and it becomes the upgrade authority. Deploying is",
        "not free and not silent, so this script will not guess which key you meant.",
      ].join("\n"),
    );
    return 1;
  }
  if (!existsSync(wallet)) {
    console.error(`no keypair at ${wallet}`);
    return 1;
  }

  const so = join(ROOT, "target", "deploy", `${PROGRAM}.so`);
  if (!existsSync(so)) {
    console.error("nothing built yet - run npm run program:build first");
    return 1;
  }

  const rpc = process.env.NEXT_PUBLIC_COOKIE_RPC_URL?.trim() || "https://rpc.cookiescan.io";
  console.log(`deploying ${PROGRAM} to ${rpc}\n`);

  return inContainer(
    [
      "solana config set --url $CORWA_RPC --keypair /wallet.json >/dev/null",
      "echo payer: $(solana address)",
      "echo balance: $(solana balance)",
      `solana program deploy target/deploy/${PROGRAM}.so --program-id target/deploy/${PROGRAM}-keypair.json`,
    ].join(" && "),
    { extraArgs: ["-v", `${resolve(wallet)}:/wallet.json:ro`, "-e", `CORWA_RPC=${rpc}`] },
  );
}

/** Detached container running a validator with the program already loaded. */
const VALIDATOR = "corwa-vault-validator";

function stopValidator() {
  spawnSync(docker(), ["rm", "-f", VALIDATOR], { stdio: "ignore" });
}

/**
 * A throwaway Postgres for the one integration suite that needs one.
 *
 * The cashback pipeline is half database and half chain, and the join between them is the part
 * worth testing: a balance in Postgres becoming a root on chain becoming tokens in a wallet. That
 * cannot be checked without both, so both are started here and thrown away afterwards. The port is
 * deliberately not 5432, so a Postgres somebody is already running is left alone.
 */
const POSTGRES = "corwa-test-postgres";
const POSTGRES_PORT = 55432;
const TEST_DATABASE_URL = `postgres://postgres:corwa@127.0.0.1:${POSTGRES_PORT}/corwa`;

function stopPostgres() {
  spawnSync(docker(), ["rm", "-f", POSTGRES], { stdio: "ignore" });
}

async function startPostgres() {
  stopPostgres();
  const started = spawnSync(
    docker(),
    [
      "run", "-d", "--rm",
      "--name", POSTGRES,
      "-e", "POSTGRES_PASSWORD=corwa",
      "-e", "POSTGRES_DB=corwa",
      "-p", `${POSTGRES_PORT}:5432`,
      "postgres:16-alpine",
    ],
    { encoding: "utf8" },
  );
  if (started.status !== 0) {
    console.error(started.stderr || started.stdout);
    return false;
  }

  const deadline = Date.now() + 60_000;
  for (;;) {
    const ready = spawnSync(docker(), ["exec", POSTGRES, "pg_isready", "-U", "postgres"], {
      stdio: "ignore",
    });
    if (ready.status === 0) break;
    if (Date.now() > deadline) {
      console.error("postgres never became ready");
      return false;
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }

  // push rather than migrate: this database lives for one test run and only has to match the
  // schema the code is compiled against.
  //
  // drizzle-kit is called through its own entry point rather than through npx, because npx is a
  // shell script on one platform and a .cmd on the other, and spawnSync without a shell wants the
  // exact file either way.
  const push = spawnSync(
    process.execPath,
    [join(ROOT, "node_modules", "drizzle-kit", "bin.cjs"), "push", "--force"],
    { stdio: "inherit", cwd: ROOT, env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL } },
  );
  if (push.error) console.error(push.error.message);
  return push.status === 0;
}

async function integrationTest() {
  const so = join(ROOT, "target", "deploy", `${PROGRAM}.so`);
  const idlPath = join(ROOT, "programs", "corwa-vault", "idl.json");
  if (!existsSync(so) || !existsSync(idlPath)) {
    console.error("nothing built yet - run npm run program:build first");
    return 1;
  }
  const programId = JSON.parse(readFileSync(idlPath, "utf8")).address;

  stopValidator();
  console.log("starting postgres");
  if (!(await startPostgres())) {
    stopPostgres();
    return 1;
  }

  console.log(`starting a validator with ${programId} loaded`);

  const started = spawnSync(
    docker(),
    [
      "run", "-d", "--rm",
      "--name", VALIDATOR,
      // Both ports matter: 8899 is RPC, 8900 is the subscription socket that confirmTransaction
      // waits on. Publish only the first and every confirmation hangs until the test times out.
      "-p", "8899:8899",
      "-p", "8900:8900",
      "-v", `${ROOT}:/work:ro`,
      IMAGE,
      "solana-test-validator",
      "--reset",
      "--quiet",
      "--ledger", "/tmp/ledger",
      "--bind-address", "0.0.0.0",
      "--rpc-port", "8899",
      "--limit-ledger-size", "10000",
      "--bpf-program", programId, `/work/target/deploy/${PROGRAM}.so`,
    ],
    { encoding: "utf8" },
  );
  if (started.status !== 0) {
    console.error(started.stderr || started.stdout);
    stopPostgres();
    return 1;
  }

  try {
    // The validator needs a moment before it will answer, and a test that starts too early fails
    // for a reason that has nothing to do with the program.
    const deadline = Date.now() + 90_000;
    for (;;) {
      try {
        const res = await fetch("http://127.0.0.1:8899", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
        });
        const body = await res.json();
        if (body.result === "ok") break;
      } catch {
        // not listening yet
      }
      if (Date.now() > deadline) {
        console.error("the validator never became healthy");
        spawnSync(docker(), ["logs", "--tail", "40", VALIDATOR], { stdio: "inherit" });
        return 1;
      }
      await new Promise((r) => setTimeout(r, 1_000));
    }

    const res = spawnSync(
      process.execPath,
      ["--import", "./tests/resolve.mjs", "--test", "tests/integration/*.test.ts"],
      {
        stdio: "inherit",
        cwd: ROOT,
        // Both point at the throwaway pair above rather than at anything real. Without the RPC
        // override the epoch suite would build its draft against Cookie Chain and publish it here.
        env: {
          ...process.env,
          DATABASE_URL: TEST_DATABASE_URL,
          NEXT_PUBLIC_COOKIE_RPC_URL: "http://127.0.0.1:8899",
        },
      },
    );
    return res.status ?? 1;
  } finally {
    stopValidator();
    stopPostgres();
  }
}

const command = process.argv[2];
const commands = { build, deploy, test: integrationTest };

if (!commands[command]) {
  console.error(`usage: node scripts/program.mjs <${Object.keys(commands).join("|")}>`);
  process.exit(2);
}
process.exit(await commands[command]());
