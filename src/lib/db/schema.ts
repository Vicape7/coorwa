import {
  pgTable,
  text,
  doublePrecision,
  integer,
  timestamp,
  index,
  uniqueIndex,
  serial,
} from "drizzle-orm/pg-core";

/**
 * Fills Corwa routed.
 *
 * A row is only ever written after a transaction has confirmed on-chain, and the signature is
 * unique - so this table is an index of things that provably happened, not a ledger Corwa controls.
 * Anyone can verify a row against the explorer.
 */
export const fills = pgTable(
  "fills",
  {
    id: serial("id").primaryKey(),
    /** Confirmed transaction signature. The uniqueness key - a replayed report cannot double-count. */
    signature: text("signature").notNull(),
    wallet: text("wallet").notNull(),
    /** "swap" (aggregator) or "launchpad" (bonding curve). */
    source: text("source").notNull(),
    /** The non-COOK side of the trade. */
    mint: text("mint").notNull(),
    symbol: text("symbol"),
    side: text("side").notNull(),
    /** Notional of the fill in USD, as priced at the time. */
    valueUsd: doublePrecision("value_usd").notNull(),
    /** The slice of fee Corwa actually earned on this fill, in USD. */
    feeUsd: doublePrecision("fee_usd").notNull(),
    /** Who launched the token, when known - this is what makes creator cashback payable. */
    creator: text("creator"),
    chain: text("chain").notNull().default("cookie"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("fills_signature_idx").on(t.signature),
    index("fills_wallet_idx").on(t.wallet),
    index("fills_creator_idx").on(t.creator),
    index("fills_created_idx").on(t.createdAt),
  ],
);

/** Cashback already paid out, so accrual can be netted against it. */
export const payouts = pgTable(
  "payouts",
  {
    id: serial("id").primaryKey(),
    wallet: text("wallet").notNull(),
    /** "trader" | "creator" */
    role: text("role").notNull(),
    amountUsd: doublePrecision("amount_usd").notNull(),
    amountCook: doublePrecision("amount_cook").notNull(),
    /** Transaction that paid it. Null while a claim is pending. */
    signature: text("signature"),
    epoch: integer("epoch"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("payouts_wallet_idx").on(t.wallet)],
);
