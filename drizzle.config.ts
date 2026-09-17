import type { Config } from "drizzle-kit";
import { existsSync } from "node:fs";

/**
 * Read the connection string the same way the app does.
 *
 * Next loads `.env.local` itself, but drizzle-kit is a separate process and loads nothing, so
 * `npm run db:push` would otherwise refuse with an empty url no matter what is in the file.
 *
 * A DATABASE_URL already in the environment always wins, so a throwaway database can be pointed at
 * from the command line without `.env.local` quietly sending the schema to the real one instead.
 */
if (!process.env.DATABASE_URL) {
  for (const file of [".env.local", ".env"]) {
    if (!existsSync(file)) continue;
    (process as { loadEnvFile?: (path: string) => void }).loadEnvFile?.(file);
    if (process.env.DATABASE_URL) break;
  }
}

export default {
  schema: "./src/lib/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
} satisfies Config;
