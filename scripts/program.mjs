#!/usr/bin/env node
/**
 * Build, test and deploy the vault program.
 *
 * The Solana toolchain is not a normal npm dependency: it is a specific Rust, a specific Agave and
 * a specific Anchor, and getting all three onto a Windows machine by hand is a day nobody gets
 * back. So the toolchain is a container image, pinned by tag, and this script is the only thing
 * that has to know that. `npm run program:build` produces the same bytes on any machine with
 * Docker running.
 *
 *   npm run program:build     compile, then copy the IDL next to the source
 *   npm run program:test      run tests/integration against a throwaway validator
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

/**
 * Every program in the workspace, by crate directory and by the lib name the toolchain uses for its
 * artefacts. `anchor build` compiles them all; build and deploy take an optional name so a slow
 * rebuild or, more importantly, a deployment can be aimed at one of them.
 */
const PROGRAMS = [
  { crate: "corwa-vault", lib: "corwa_vault" },
  { crate: "corwa-launch", lib: "corwa_launch" },
];

/**
 * Pieces of Cookie Chain the launch program talks to, copied into the test validator.
 *
 * `corwa_launch` opens its pool by calling Cookiebox's pool program, so a test that stops short of
 * that call proves nothing about the part most likely to be wrong. `npm run program:fixtures` dumps
 * the real program and the real pool config off the chain, and the validator below loads them, so the
 * rehearsal runs against the same bytes production will.
 */
const FIXTURES = [
  {
    kind: "program",
    name: "cookiebox pool program",
    address: "DAMMjDCEFTDkt7ywazZS8GoaLtjb3HaJo3pLbf64xrPY",
    file: "cp_amm.so",
  },
  {
    kind: "account",
    name: "1% pool config, public, fees in quote only",
    address: "9H6eQjax36XECa73mAufWiq8yVKae6K7NLK5ZubUzxnf",
    file: "damm_config.json",
  },
];

const FIXTURE_DIR = join(ROOT, "target", "fixtures");

/** Copy the fixtures above off Cookie Chain. Read-only, and the files land in target/. */
function fixtures() {
  const rpc = process.env.NEXT_PUBLIC_COOKIE_RPC_URL?.trim() || "https://rpc.cookiescan.io";
  mkdirSync(FIXTURE_DIR, { recursive: true });
  const lines = [`solana config set --url $CORWA_RPC >/dev/null`];
  for (const f of FIXTURES) {
    lines.push(
      f.kind === "program"
        ? `solana program dump ${f.address} target/fixtures/${f.file}`
        : `solana account ${f.address} --output json-compact --output-file target/fixtures/${f.file} >/dev/null`,
    );
  }
  const code = inContainer(lines.join(" && "), { extraArgs: ["-e", `CORWA_RPC=${rpc}`] });
  if (code !== 0) return code;
  for (const f of FIXTURES) {
    const path = join(FIXTURE_DIR, f.file);
    if (!existsSync(path)) {
      console.error(`missing ${f.file} after the dump`);
      return 1;
    }
    console.log(`${f.file.padEnd(18)} ${statSync(path).size.toLocaleString("en-US")} bytes  ${f.name}`);
  }
  return 0;
}

/** Resolve the program named on the command line, or every program when none was. */
function pick(name) {
  if (!name) return PROGRAMS;
  const found = PROGRAMS.filter((p) => p.lib === name || p.crate === name);
  if (found.length === 0) {
    throw new Error(`unknown program "${name}" - try ${PROGRAMS.map((p) => p.lib).join(" or ")}`);
  }
  return found;
}

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

function build(name) {
  const targets = pick(name);
  console.log(`building ${targets.map((p) => p.lib).join(", ")} with ${IMAGE}\n`);
  const code = inContainer(
    name ? `anchor build -p ${targets[0].lib}` : "anchor build",
  );
  if (code !== 0) return code;

  let missing = 0;
  for (const { crate, lib } of targets) {
    const so = join(ROOT, "target", "deploy", `${lib}.so`);
    const idl = join(ROOT, "target", "idl", `${lib}.json`);
    if (!existsSync(so)) {
      console.error(`the build reported success but produced no .so for ${lib}`);
      missing += 1;
      continue;
    }

    // The IDL lives next to the source, not only in target/, because it is the record of what the
    // deployed program actually accepts. The idl tests check the hand-written clients against these
    // files, so a change to a program that a client has not followed fails a test rather than a
    // transaction.
    if (existsSync(idl)) {
      mkdirSync(join(ROOT, "programs", crate), { recursive: true });
      copyFileSync(idl, join(ROOT, "programs", crate, "idl.json"));
    }

    const bytes = readFileSync(so);
    console.log(`\n${lib}`);
    console.log(`  idl    programs/${crate}/idl.json`);
    console.log(`  so     target/deploy/${lib}.so`);
    console.log(`  size   ${statSync(so).size.toLocaleString("en-US")} bytes`);
    console.log(`  sha256 ${createHash("sha256").update(bytes).digest("hex")}`);
  }
  return missing === 0 ? 0 : 1;
}

function deploy(name) {
  if (!name && PROGRAMS.length > 1) {
    console.error(
      `name the program to deploy: ${PROGRAMS.map((p) => p.lib).join(" or ")}. Deploying spends`
        + " COOK and cannot be undone quietly, so this script will not guess.",
    );
    return 1;
  }
  const { lib } = pick(name)[0];
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

  const so = join(ROOT, "target", "deploy", `${lib}.so`);
  if (!existsSync(so)) {
    console.error("nothing built yet - run npm run program:build first");
    return 1;
  }

  const rpc = process.env.NEXT_PUBLIC_COOKIE_RPC_URL?.trim() || "https://rpc.cookiescan.io";
  console.log(`deploying ${lib} to ${rpc}\n`);

  return inContainer(
    [
      "solana config set --url $CORWA_RPC --keypair /wallet.json >/dev/null",
      "echo payer: $(solana address)",
      "echo balance: $(solana balance)",
      `solana program deploy target/deploy/${lib}.so --program-id target/deploy/${lib}-keypair.json`,
    ].join(" && "),
    { extraArgs: ["-v", `${resolve(wallet)}:/wallet.json:ro`, "-e", `CORWA_RPC=${rpc}`] },
  );
}

/** Detached container running a validator with the program already loaded. */
const VALIDATOR = "corwa-vault-validator";

function stopValidator() {
  spawnSync(docker(), ["rm", "-f", VALIDATOR], { stdio: "ignore" });
}

async function integrationTest() {
  const loaded = [];
  for (const { crate, lib } of PROGRAMS) {
    const so = join(ROOT, "target", "deploy", `${lib}.so`);
    const idlPath = join(ROOT, "programs", crate, "idl.json");
    if (!existsSync(so) || !existsSync(idlPath)) continue;
    loaded.push({ lib, so, id: JSON.parse(readFileSync(idlPath, "utf8")).address });
  }
  if (loaded.length === 0) {
    console.error("nothing built yet - run npm run program:build first");
    return 1;
  }

  const missingFixtures = FIXTURES.filter((f) => !existsSync(join(FIXTURE_DIR, f.file)));
  if (missingFixtures.length > 0) {
    console.error(
      `missing fixtures: ${missingFixtures.map((f) => f.file).join(", ")}`
        + " - run npm run program:fixtures once to copy them off Cookie Chain",
    );
    return 1;
  }

  stopValidator();
  console.log(`starting a validator with ${loaded.map((p) => p.lib).join(", ")} loaded`);

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
      ...loaded.flatMap((p) => ["--bpf-program", p.id, `/work/target/deploy/${p.lib}.so`]),
      ...FIXTURES.flatMap((f) =>
        f.kind === "program"
          ? ["--bpf-program", f.address, `/work/target/fixtures/${f.file}`]
          : ["--account", f.address, `/work/target/fixtures/${f.file}`],
      ),
    ],
    { encoding: "utf8" },
  );
  if (started.status !== 0) {
    console.error(started.stderr || started.stdout);
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
      // One file at a time: the launch suites share the program's single config account, and two
      // of them racing to write it would each find the other's.
      [
        "--import",
        "./tests/resolve.mjs",
        "--test",
        "--test-concurrency=1",
        "tests/integration/*.test.ts",
      ],
      {
        stdio: "inherit",
        cwd: ROOT,
        // Points at the throwaway validator above rather than at Cookie Chain itself.
        env: { ...process.env, NEXT_PUBLIC_COOKIE_RPC_URL: "http://127.0.0.1:8899" },
      },
    );
    return res.status ?? 1;
  } finally {
    stopValidator();
  }
}

const command = process.argv[2];
const target = process.argv[3];
const commands = { build, deploy, test: integrationTest, fixtures };

if (!commands[command]) {
  console.error(
    `usage: node scripts/program.mjs <${Object.keys(commands).join("|")}> [${PROGRAMS.map((p) => p.lib).join("|")}]`,
  );
  process.exit(2);
}
process.exit(await commands[command](target));
