import {
  pgTable,
  text,
  doublePrecision,
  integer,
  timestamp,
  index,
  uniqueIndex,
  serial,
  bigint,
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

/**
 * A cashback epoch: one merkle root, published on chain.
 *
 * This is the off-chain half of `programs/corwa-vault`. The vault pays against a root and knows
 * nothing about who is owed what, so the list behind the root has to live here, or nobody can
 * produce a proof. The row exists in two states: a draft, which is a proposal and moves no money,
 * and a published epoch, which is only ever written after the publish transaction has been read
 * back from the chain.
 *
 * `index` is the on-chain epoch index, and the program insists it equals the vault's epoch count,
 * so the sequence is the chain's rather than ours.
 */
export const epochs = pgTable(
  "epochs",
  {
    index: bigint("index", { mode: "bigint" }).primaryKey(),
    /** The merkle root as 64 hex characters. Compared byte for byte against the on-chain epoch. */
    root: text("root").notNull(),
    /** Total owed across the epoch, in raw COOK units, matching what was published on chain. */
    totalRaw: bigint("total_raw", { mode: "bigint" }).notNull(),
    totalUsd: doublePrecision("total_usd").notNull(),
    claimants: integer("claimants").notNull(),
    /**
     * The COOK price used to turn a USD balance into a token amount. Accrual is recorded in USD
     * because a fee is earned in USD terms, so the conversion happens once, here, and is written
     * down so a claimant can check the rate they were paid at.
     */
    cookPriceUsd: doublePrecision("cook_price_usd").notNull(),
    /**
     * The fill cutoff the tree was built from. Everything after it belongs to a later epoch. This
     * is what makes a rebuild reproducible: the same cutoff over an append-only table gives the
     * same root.
     */
    asOf: timestamp("as_of", { withTimezone: true }).notNull(),
    deadline: timestamp("deadline", { withTimezone: true }).notNull(),
    /** "draft" until the publish transaction confirms, then "published". */
    status: text("status").notNull().default("draft"),
    /** The publish transaction. Null on a draft, which is exactly what makes it a draft. */
    signature: text("signature"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
  },
  (t) => [index("epochs_status_idx").on(t.status)],
);

/**
 * One claimant's line in one epoch: a leaf of the tree, and its fate.
 *
 * Written at draft time and never edited afterwards except to record the claim, because editing an
 * amount would change the root and orphan every proof already handed out. The proof itself is not
 * stored - the tree is rebuilt from these rows on demand, and it sorts leaves by their own hash, so
 * the rebuild lands on the same root no matter what order Postgres returns them in.
 */
export const claims = pgTable(
  "claims",
  {
    id: serial("id").primaryKey(),
    epoch: bigint("epoch", { mode: "bigint" }).notNull(),
    wallet: text("wallet").notNull(),
    /** Raw COOK units, the number that is hashed into the leaf. */
    amountRaw: bigint("amount_raw", { mode: "bigint" }).notNull(),
    amountUsd: doublePrecision("amount_usd").notNull(),
    /** The two halves of the line, kept apart so the rewards page can show where it came from. */
    traderUsd: doublePrecision("trader_usd").notNull().default(0),
    creatorUsd: doublePrecision("creator_usd").notNull().default(0),
    /** The claim transaction. Null until this line is claimed, which is what nets it out. */
    signature: text("signature"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One line per wallet per epoch. Two would each be claimable, so the epoch would pay twice.
    uniqueIndex("claims_epoch_wallet_idx").on(t.epoch, t.wallet),
    index("claims_wallet_idx").on(t.wallet),
  ],
);
