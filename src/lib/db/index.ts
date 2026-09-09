import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

/**
 * The database is optional.
 *
 * Corwa's trading, launching and LP paths are entirely on-chain and work with no database at all —
 * this only backs cashback accounting, which needs history. So a missing DATABASE_URL degrades the
 * rewards page to "not configured" instead of breaking the app.
 */
const url = process.env.DATABASE_URL?.trim();

declare global {
  var __corwaDb: ReturnType<typeof drizzle<typeof schema>> | undefined;
}

function connect() {
  if (!url) return null;
  // One pool per process, reused across hot reloads in development.
  if (!globalThis.__corwaDb) {
    const client = postgres(url, { max: 5, prepare: false });
    globalThis.__corwaDb = drizzle(client, { schema });
  }
  return globalThis.__corwaDb;
}

export const db = connect();
export const dbEnabled = db !== null;
export { schema };
