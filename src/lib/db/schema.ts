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
 * Fills Coorwa routed.
 *
 * A row is only ever written after a transaction has confirmed on-chain, and the signature is
 * unique - so this table is an index of things that provably happened, not a ledger Coorwa controls.
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
    /**
     * The benchmark of the pair the trade was made on, when it was made on one. Only written after
     * the server has checked that the token actually carries it, so volume can be told apart per
     * pair.
     */
    ticker: text("ticker"),
    symbol: text("symbol"),
    side: text("side").notNull(),
    /** Notional of the fill in USD, as priced at the time. */
    valueUsd: doublePrecision("value_usd").notNull(),
    /** The slice of fee Coorwa actually earned on this fill, in USD. */
    feeUsd: doublePrecision("fee_usd").notNull(),
    /** Who launched the token, when known. Kept to name a token's creator, never to pay them. */
    creator: text("creator"),
    chain: text("chain").notNull().default("cookie"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("fills_signature_idx").on(t.signature),
    index("fills_wallet_idx").on(t.wallet),
    index("fills_creator_idx").on(t.creator),
    index("fills_created_idx").on(t.createdAt),
    index("fills_pair_idx").on(t.mint, t.ticker),
  ],
);

/**
 * A token launched through Coorwa, and the RWA its creator benchmarked it against.
 *
 * This is a Coorwa-launched token's first pair, free and picked at launch. The choice is made once
 * and never edited: a benchmark that moved would silently rewrite every chart and every ratio ever
 * shown for that token. Further pairs are bought, see `listings`.
 *
 * A row is only written after the launch transaction has been read back from the chain and found to
 * name this mint, so a wallet cannot claim a benchmark on a token it did not launch.
 */
export const launches = pgTable(
  "launches",
  {
    /** The token's mint. Primary key, because one mint has exactly one benchmark. */
    mint: text("mint").primaryKey(),
    pool: text("pool").notNull(),
    creator: text("creator").notNull(),
    /** The chosen RWA, by ticker, e.g. "NVDA". Resolved against `RWA_ASSETS` on read. */
    ticker: text("ticker").notNull(),
    symbol: text("symbol"),
    name: text("name"),
    /** The confirmed create transaction this was proved against. */
    signature: text("signature").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("launches_signature_idx").on(t.signature),
    index("launches_creator_idx").on(t.creator),
    index("launches_ticker_idx").on(t.ticker),
  ],
);

/**
 * A token's pair, set by its creator for a token not launched through Coorwa.
 *
 * A token is only in the terminal once it has a pair: its launch benchmark if it was launched here,
 * otherwise one of these. It costs one dollar's worth of COOK, paid to the operator wallet and paid
 * out to that token's holders.
 *
 * A row is only written once the payment has been read back from the chain: it has to be signed by
 * the creator and have credited the operator with enough COOK. The signature is unique across the
 * table, so one payment can never be presented twice.
 */
export const listings = pgTable(
  "listings",
  {
    id: serial("id").primaryKey(),
    mint: text("mint").notNull(),
    /** The RWA being added, by ticker. */
    ticker: text("ticker").notNull(),
    /** Whoever paid. Not necessarily the token's creator, because the fee is the gate, not identity. */
    payer: text("payer").notNull(),
    /** The confirmed payment transaction that bought this row. */
    signature: text("signature").notNull(),
    /** Raw COOK that reached the operator on that transaction, and what it was worth then. */
    paidRaw: bigint("paid_raw", { mode: "bigint" }).notNull(),
    paidUsd: doublePrecision("paid_usd").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One row per pair: paying twice for the same benchmark buys nothing and must not look like it did.
    uniqueIndex("listings_mint_ticker_idx").on(t.mint, t.ticker),
    // A token has one pair, and one payment buys one pair. Both are enforced here rather than only
    // in the route, because the route checks and then writes with chain reads in between, and two
    // requests sent at the same moment would both pass the check.
    uniqueIndex("listings_mint_idx").on(t.mint),
    uniqueIndex("listings_signature_idx").on(t.signature),
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
 *
 * No longer written. The app paid through vault epochs before the daily payout run replaced them,
 * and the table stays here because it still exists in the database.
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
 *
 * No longer written. The app paid through vault epochs before the daily payout run replaced them,
 * and the table stays here because it still exists in the database.
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
    /**
     * The two halves of the line, kept apart so the rewards page can show where it came from. The
     * holder half lives in the column still called `trader_usd`: rewards went to traders before they
     * went to holders, and renaming a column is a migration for no change in meaning of the number.
     */
    holderUsd: doublePrecision("trader_usd").notNull().default(0),
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

/**
 * What one wallet was given out of one token's holder pool, in one epoch.
 *
 * Holder rewards depend on who held a token at the moment the epoch was built, which the fills table
 * cannot answer after the fact. So the split is recorded here as it is made, per token and wallet,
 * and written together with the epoch's claim lines. A draft's rows are replaced when the draft is
 * rebuilt; a published epoch's rows are the record, and what they add up to per token is what that
 * token's pool has already paid out.
 *
 * No longer written. The app paid through vault epochs before the daily payout run replaced them,
 * and the table stays here because it still exists in the database.
 */
export const holderRewards = pgTable(
  "holder_rewards",
  {
    id: serial("id").primaryKey(),
    epoch: bigint("epoch", { mode: "bigint" }).notNull(),
    mint: text("mint").notNull(),
    wallet: text("wallet").notNull(),
    /** What the wallet held at the snapshot, in raw token units: the weight it was paid by. */
    balanceRaw: bigint("balance_raw", { mode: "bigint" }).notNull(),
    amountUsd: doublePrecision("amount_usd").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("holder_rewards_epoch_mint_wallet_idx").on(t.epoch, t.mint, t.wallet),
    index("holder_rewards_wallet_idx").on(t.wallet),
    index("holder_rewards_mint_idx").on(t.mint),
  ],
);

/**
 * One holder's balance in one sample.
 *
 * A single snapshot at payout time can be gamed by buying just before it and selling just after. So
 * holders are sampled at unpredictable times, and the daily run shares each token's pool by the sum
 * of every sample since the last run. To be paid in full a wallet has to hold through the day, not
 * for one minute of it.
 *
 * Every row of one sample carries the same `takenAt`, which is what groups them.
 */
export const holderSamples = pgTable(
  "holder_samples",
  {
    id: serial("id").primaryKey(),
    takenAt: timestamp("taken_at", { withTimezone: true }).notNull(),
    mint: text("mint").notNull(),
    wallet: text("wallet").notNull(),
    balanceRaw: bigint("balance_raw", { mode: "bigint" }).notNull(),
  },
  (t) => [
    uniqueIndex("holder_samples_taken_mint_wallet_idx").on(t.takenAt, t.mint, t.wallet),
    index("holder_samples_mint_taken_idx").on(t.mint, t.takenAt),
    index("holder_samples_wallet_idx").on(t.wallet),
  ],
);

/**
 * One daily payout run: fees shared out, bridged to Solana, swapped into each pair's asset and sent.
 *
 * A run crosses two chains and several transactions, so it is a row that advances one status at a
 * time (`payout-cycle.ts`), and a run that stops halfway resumes from the status it reached rather
 * than starting again. Every transaction it sends is written here before it is confirmed.
 */
export const payoutCycles = pgTable(
  "payout_cycles",
  {
    id: serial("id").primaryKey(),
    /** Fills, listings and holder samples up to this moment belong to this run. */
    asOf: timestamp("as_of", { withTimezone: true }).notNull(),
    /** allocated, bridging, bridged, sending, done, or empty when nothing was due to anyone. */
    status: text("status").notNull(),
    cookPriceUsd: doublePrecision("cook_price_usd").notNull(),
    /** USD of every line this run pays. */
    totalUsd: doublePrecision("total_usd").notNull().default(0),
    /** USD set aside from the pot for network costs: Solana fees and new token accounts. */
    costBudgetUsd: doublePrecision("cost_budget_usd").notNull().default(0),
    /** Raw COOK sent across the bridge, in Cookie Chain units. */
    bridgeCookRaw: bigint("bridge_cook_raw", { mode: "bigint" }),
    bridgeSignature: text("bridge_signature"),
    /** The operator's COOK on Solana before the bridge, in Solana units, to see the arrival. */
    solanaCookBefore: bigint("solana_cook_before", { mode: "bigint" }),
    /** The operator's SOL before swapping and sending, to measure what the run really cost. */
    solBefore: bigint("sol_before", { mode: "bigint" }),
    costsUsd: doublePrecision("costs_usd"),
    /** When the step waiting on a transaction sent it, so a dropped one can be told from a slow one. */
    stepAt: timestamp("step_at", { withTimezone: true }),
    /** The last reason the run did not advance, for the operator panel. */
    note: text("note"),
    /**
     * Steps that have failed in a row. Reset whenever one gets through, so this counts a run that
     * cannot move rather than one that has had a bad minute. A run that reaches the limit is given
     * up on, because the step picks the oldest open run and a stuck one would hold up every later
     * run behind it.
     */
    attempts: integer("attempts").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("payout_cycles_status_idx").on(t.status)],
);

/**
 * What one wallet is owed from one token, and whether it has been paid.
 *
 * Written when a run shares the pools out, as "allocated". A wallet's allocated lines in one asset
 * are paid together once they add up to `PAYOUT_MIN_USD`; until then they wait for later runs, so a
 * small holder is paid late rather than never. Everything allocated for a token, paid or not, is what
 * that token's pool has already given away.
 */
export const payoutLines = pgTable(
  "payout_lines",
  {
    id: serial("id").primaryKey(),
    /** The run that shared this out. */
    allocatedIn: integer("allocated_in").notNull(),
    /** The run that pays it. Null while it waits for the minimum. */
    paidIn: integer("paid_in"),
    wallet: text("wallet").notNull(),
    mint: text("mint").notNull(),
    /** The pair's asset the line is paid in. */
    ticker: text("ticker").notNull(),
    /** "holder" or "creator". */
    role: text("role").notNull(),
    /** Average balance across the run's samples, for a holder line. */
    balanceRaw: bigint("balance_raw", { mode: "bigint" }).notNull(),
    amountUsd: doublePrecision("amount_usd").notNull(),
    /** allocated, queued, sent, or failed: a wallet the run could not pay. */
    status: text("status").notNull().default("allocated"),
    /** Sends this line has been part of that did not land, so one wallet cannot stop a run forever. */
    attempts: integer("attempts").notNull().default(0),
    /** Raw units of the asset this line received, once sent. */
    assetRaw: bigint("asset_raw", { mode: "bigint" }),
    /** The Solana transaction that sent it. Written before confirming, so a retry can check it. */
    signature: text("signature"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("payout_lines_wallet_idx").on(t.wallet),
    index("payout_lines_mint_idx").on(t.mint),
    index("payout_lines_paid_in_idx").on(t.paidIn),
    index("payout_lines_status_idx").on(t.status),
  ],
);

/** One Jupiter swap a run made on Solana: COOK into a pair's asset, or into SOL for costs. */
export const payoutSwaps = pgTable(
  "payout_swaps",
  {
    id: serial("id").primaryKey(),
    cycleId: integer("cycle_id").notNull(),
    /** The asset bought, or "SOL" for the cost budget. */
    ticker: text("ticker").notNull(),
    cookRaw: bigint("cook_raw", { mode: "bigint" }).notNull(),
    /** Raw units received, read from the transaction once it confirmed. */
    assetRaw: bigint("asset_raw", { mode: "bigint" }),
    signature: text("signature").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("payout_swaps_cycle_ticker_idx").on(t.cycleId, t.ticker)],
);

/**
 * A token's logo, kept once it has been read.
 *
 * Logos come from the Cookiescan registry or from the token's IPFS metadata, and IPFS reads from a
 * Worker fail often enough that a token missing from the registry lost its logo on some requests and
 * not others. Written whenever a read finds one, and read first next time, so a logo seen once
 * stays.
 */
export const tokenLogos = pgTable("token_logos", {
  mint: text("mint").primaryKey(),
  logo: text("logo").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
