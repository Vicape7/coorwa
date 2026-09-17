import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

/**
 * The database is optional.
 *
 * Trading, launching and LP all run on-chain and need no database. The database backs one thing:
 * cashback accounting, which needs history. So a missing DATABASE_URL turns the rewards page into
 * "not configured" rather than breaking the app.
 */
type Db = ReturnType<typeof drizzle<typeof schema>>;

declare global {
  var __coorwaDb: Db | undefined;
  var __coorwaDbUrl: string | undefined;
}

/**
 * What the OpenNext worker puts on the global scope for the request being served. Read through the
 * symbol rather than `getCloudflareContext`, so `next dev` and the test runner never load the
 * adapter at all.
 */
type WorkerContext = {
  env: { HYPERDRIVE?: { connectionString: string } };
  ctx: object;
};

function workerContext(): WorkerContext | undefined {
  return (globalThis as Record<symbol, WorkerContext | undefined>)[
    Symbol.for("__cloudflare-context__")
  ];
}

/**
 * One client per request on Cloudflare Workers.
 *
 * A socket opened while serving one request cannot be used by another one there, so the process-wide
 * pool below would fail on the second request. Hyperdrive keeps the real connections to Neon warm,
 * which makes a fresh client per request cheap. The map is keyed on the request's ExecutionContext
 * and lets go of the client once the request is gone.
 */
const perRequest = new WeakMap<object, Db>();

function forWorker(cf: WorkerContext): Db | null {
  const url = cf.env.HYPERDRIVE?.connectionString ?? process.env.DATABASE_URL?.trim();
  if (!url) return null;
  let client = perRequest.get(cf.ctx);
  if (!client) {
    client = drizzle(postgres(url, { max: 5, prepare: false, fetch_types: false }), { schema });
    perRequest.set(cf.ctx, client);
  }
  return client;
}

function forNode(): Db | null {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) return null;

  // One pool per process, reused across hot reloads in development. The url it was opened with is
  // remembered alongside it, because editing .env.local in a running dev server changes the url but
  // not the cached pool, and the app would go on talking to the database it started with.
  if (globalThis.__coorwaDb && globalThis.__coorwaDbUrl !== url) {
    void globalThis.__coorwaDb.$client.end({ timeout: 5 }).catch(() => undefined);
    globalThis.__coorwaDb = undefined;
  }

  if (!globalThis.__coorwaDb) {
    const client = postgres(url, { max: 5, prepare: false });
    globalThis.__coorwaDb = drizzle(client, { schema });
    globalThis.__coorwaDbUrl = url;
  }
  return globalThis.__coorwaDb;
}

function current(): Db | null {
  const cf = workerContext();
  return cf ? forWorker(cf) : forNode();
}

/**
 * Whether a database is configured. On Workers the variables arrive with the first request, not at
 * module load, so a binding or a DATABASE_URL secret both count.
 */
const onWorkers = typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers";
const configured = onWorkers || Boolean(process.env.DATABASE_URL?.trim());

/**
 * The database, resolved on every use so each request on Workers gets its own client while node
 * keeps its single pool. Callers keep writing `db.select()` as before.
 */
export const db: Db | null = configured
  ? new Proxy({} as Db, {
      get(_, prop) {
        const target = current();
        if (!target) throw new Error("DATABASE_URL is not set");
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    })
  : null;
export const dbEnabled = db !== null;
export { schema };
