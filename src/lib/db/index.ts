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
const url = process.env.DATABASE_URL?.trim();

declare global {
  var __corwaDb: ReturnType<typeof drizzle<typeof schema>> | undefined;
  var __corwaDbUrl: string | undefined;
}

function connect() {
  if (!url) return null;

  // One pool per process, reused across hot reloads in development. The url it was opened with is
  // remembered alongside it, because editing .env.local in a running dev server changes the url but
  // not the cached pool, and the app would go on talking to the database it started with.
  if (globalThis.__corwaDb && globalThis.__corwaDbUrl !== url) {
    void globalThis.__corwaDb.$client.end({ timeout: 5 }).catch(() => undefined);
    globalThis.__corwaDb = undefined;
  }

  if (!globalThis.__corwaDb) {
    const client = postgres(url, { max: 5, prepare: false });
    globalThis.__corwaDb = drizzle(client, { schema });
    globalThis.__corwaDbUrl = url;
  }
  return globalThis.__corwaDb;
}

export const db = connect();
export const dbEnabled = db !== null;
export { schema };

/**
 * Hang up the pool.
 *
 * The app never calls this - the pool is meant to outlive every request. A test process does,
 * because an open socket keeps node alive after the last assertion has passed.
 */
export async function closeDb(): Promise<void> {
  if (!globalThis.__corwaDb) return;
  await globalThis.__corwaDb.$client.end({ timeout: 5 });
  globalThis.__corwaDb = undefined;
  globalThis.__corwaDbUrl = undefined;
}
