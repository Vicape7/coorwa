/**
 * Coorwa - single source of truth for chain, program and API constants.
 *
 * Everything here was verified against the live network rather than copied from docs:
 * the RPC answers `getVersion` as solana-core 4.1.2, the aggregator and registry endpoints
 * respond publicly, and every mint below was read from its own account.
 */

// --- Cookie Chain ------------------------------------------------------------------------------

export const COOKIE_RPC_URL =
  process.env.NEXT_PUBLIC_COOKIE_RPC_URL?.trim() || "https://rpc.cookiescan.io";

/** Native/wrapped COOK on Cookie Chain. Identical string to wSOL on Solana - always branch on
 *  chain, never on the mint alone. */
export const COOK_MINT = "So11111111111111111111111111111111111111112";
export const COOK_DECIMALS = 9;
export const COOK_SYMBOL = "COOK";

export const COOKIE_EXPLORER = "https://cookiescan.io";

/** Cookiescan REST: the token registry (~6.5k mints) and the markets/pools feed (160 pools). */
export const COOKIESCAN_API = "https://api.cookiescan.io";

/** Cookiebox aggregator - routes all Cookie Chain DEX liquidity. GET /quote, POST /swap-tx. */
export const COOKIEBOX_AGG_API = "https://agg.cookiebox.app";

/** Candy Shop - the second router, used as a fallback and for quote comparison. */
export const CANDYSHOP_API = "https://swap.cookiescan.io/api";

/** MomoSwap bonding-curve launchpad. Its API builds and partial-signs launchpad transactions. */
export const MOMOSWAP_API = "https://api.momoswap.fun";
export const MOMOSWAP_SITE = "https://momoswap.fun";

export const PROGRAM_IDS = {
  cookieboxDamm: "DAMMjDCEFTDkt7ywazZS8GoaLtjb3HaJo3pLbf64xrPY",
  cookieboxClmm: "CLMMmWqTtyNSomqXP3kETJy2SGKPdr31USsm4GfbLyKs",
  cookieswapBamm: "WTzkPUoprVx7PDc1tfKA5sS7k1ynCgU89WtwZhksHX5",
  cookieswapXybn: "xYBN2zddsqSy41tg1yD9nJScCmqquZnHUyzXBfLEqC8",
  momoswapLaunchpad: "momoL7wu4TrXjnXMLCLzGsbx8Pm7XGgoYo7FVqDoqcw",
} as const;

// --- Solana mainnet (the RWA side) -------------------------------------------------------------

export const SOLANA_RPC_URL =
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL?.trim() || "https://api.mainnet-beta.solana.com";

/**
 * The Solana RPC for server code: payouts, payment checks, position reads.
 *
 * The public key above ships in the page, so it is locked to Coorwa's domains, and a request
 * from the Worker carries no domain and is refused. The server has its own key, the
 * SOLANA_SERVER_RPC_URL secret, which never reaches a browser. It is read on each call because
 * a Worker secret is not in the environment when this module first loads.
 */
export function serverSolanaRpcUrl(): string {
  return process.env.SOLANA_SERVER_RPC_URL?.trim() || SOLANA_RPC_URL;
}

/**
 * True when no dedicated Solana RPC is configured.
 *
 * The fallback is not merely throttled. api.mainnet-beta.solana.com answers a server happily but
 * returns 403 to any request carrying a browser origin, so the Solana legs of a cross-chain route
 * cannot run from the user's browser at all. Reads that Coorwa can do on their behalf go through
 * its own API routes; signing and sending cannot, so the panel says so up front rather than
 * failing at the first signature.
 */
export const SOLANA_RPC_IS_PUBLIC = !process.env.NEXT_PUBLIC_SOLANA_RPC_URL?.trim();

export const SOLANA_EXPLORER = "https://solscan.io";

/** Bridged COOK on Solana mainnet - a Token-2022 mint with 6 decimals (Cookie Chain's is 9). */
export const COOK_SOLANA_MINT = "36ZrtQoab5MhhySaP1YSTwUahSk6GRVUTtZ6cuVfm9e1";
export const COOK_SOLANA_DECIMALS = 6;

export const USDC_SOLANA_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const WSOL_MINT = "So11111111111111111111111111111111111111112";

/** Jupiter. The keyless tier is 0.5 req/s, which is why every RWA price read goes through our
 *  own cached API route rather than straight from the browser. */
export const JUPITER_API = process.env.JUPITER_API_KEY
  ? "https://api.jup.ag"
  : "https://lite-api.jup.ag";

// --- Hyperlane COOK warp route (Cookie Chain <-> Solana) ---------------------------------------

export const COOKIE_DOMAIN = 420042004;
export const SOLANA_DOMAIN = 1399811149;

export const BRIDGE = {
  cookie: {
    warpProgramId: "Aa9wq46NB7qkg1amnBuMRsV1DunmkPHuoRLWZgWiBKdn",
    mailbox: "DhiHgUY8Y6mJ4D3MoRnZWAjTBEtSaFFn4CYgc6eDzZ8r",
    igpProgramId: "F93J1LCWZVZGtiv2yWu1mZeyCbFJNUh9aWEonWN6eSRp",
    overheadIgp: "B47yFLwnEGxp3oFHyy2LdGCmAe6kTbFmzSjkVoFaod9q",
    decimals: 9,
  },
  solana: {
    warpProgramId: "B1C91jLcqXYYz57bBWR8dSEjBrJDhWSeNokZ5SDEopu3",
    mailbox: "E588QtVUvresuXq2KoNEwAmoifCzYGpRBdHByN9KQMbi",
    igpProgramId: "BhNcatUDC2D5JTyeaqrdSukiVFsEHK7e3hVmKMztwefv",
    overheadIgp: "Dg5FAhqNaRfQPc3HwW9fXr7Bj4nrnszoQspoSLgysqfY",
    /** Solana-side COOK is a Token-2022 mint with 6 decimals; Cookie Chain's native COOK has 9. */
    splMint: COOK_SOLANA_MINT,
    decimals: 6,
  },
} as const;

export const SPL_NOOP_PROGRAM_ID = "noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV";
export const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

// --- Coorwa economics ---------------------------------------------------------------------------

/**
 * The operator wallet: every fee Coorwa collects lands here, and holder rewards are paid out of it.
 *
 * This is custodial on purpose, the way StonkFun's own payout wallets are. Rewards are paid in the
 * pair's asset on Solana, and buying that asset on Jupiter needs a key to sign it, so the day's fees
 * sit here between collection and payout. The key is `COORWA_OPERATOR_KEY`, a server secret; this
 * is only its public address, needed in the browser to build a pair payment.
 */
export const COORWA_OPERATOR = process.env.NEXT_PUBLIC_COORWA_OPERATOR?.trim() || "";

/**
 * MomoSwap pays the referrer 20% of its 1% curve trade fee, out of the same fee either way - with
 * no referrer the program folds that share into its treasury instead. So naming Coorwa costs the
 * trader nothing. Defaults to the operator, so the referral share lands where rewards are paid from.
 */
export const COORWA_REFERRER = process.env.COORWA_REFERRER?.trim() || COORWA_OPERATOR;
export const MOMOSWAP_TRADE_FEE_BPS = 100;
export const MOMOSWAP_REFERRAL_SHARE = 0.2;

/**
 * What a token's one pair costs, in USD, paid in COOK to the operator by the token's creator.
 *
 * A token has exactly one pair, and the pair is the asset its holders are paid in. A token launched
 * through Coorwa gets it free, picked at launch. A token from anywhere else gets it once its creator
 * pays this, which keeps the list to tokens somebody actually stands behind. The dollar joins that
 * token's holder rewards.
 */
export const PAIR_LISTING_USD = 1;

/**
 * Coorwa's own fee on a terminal swap, in basis points of the COOK leg.
 *
 * Neither Cookie Chain aggregator will pay a referrer - six plausible parameter names were tried on
 * both and every quote came back identical - so a swap routed through Coorwa earned nothing at all
 * and every fill was recorded at zero. This is the only way the terminal can fund anything.
 *
 * It is charged honestly rather than hidden: the instruction is appended to the aggregator's own
 * transaction, in plain sight, paying the operator wallet that pays holders. Say plainly on
 * the panel that it is charged, because a trader can always route around Coorwa and should be able
 * to see what routing through it costs.
 */
export const COORWA_SWAP_FEE_BPS = 100;

/**
 * Where every fee Coorwa collects on a token goes back to: the launchpad referral share and the swap
 * fee alike. Must sum to 1: all of it is returned, none of it kept.
 *
 * The holders' part is not paid to whoever generated the fee. It joins that token's holder pool, and
 * the daily run shares the pool out over the wallets holding the token across the day's samples, in
 * proportion to what they held. The creator's part goes to whoever made the token.
 */
export const CASHBACK_SPLIT = {
  holders: 0.625,
  creator: 0.375,
} as const;

/**
 * The least a wallet has to hold of a token, in USD at the snapshot, to share its holder pool.
 *
 * Without a floor, dust accounts left behind by every trade would each take a sliver and most would
 * never clear the claim minimum anyway. Applied only when the token has a price; a token with none
 * shares its pool over every wallet holding any.
 */
export const HOLDER_MIN_USD = 5;

/**
 * How often holder rewards are paid out: this long after the first holder sample since the last run,
 * so a run always has a day of samples behind it rather than one snapshot a buyer could time.
 */
export const PAYOUT_EVERY_MS = 24 * 60 * 60 * 1000;

/**
 * The least a wallet is sent in one asset. Below it the balance waits for later runs: the first
 * payout of an xStock opens a token account on Solana for about 0.002 SOL of rent, and under a dollar
 * that would eat most of what arrives.
 */
export const PAYOUT_MIN_USD = 1;

/** Slippage allowed on the operator's own Jupiter swaps. */
export const PAYOUT_SLIPPAGE_BPS = 300;

/** Native COOK the operator keeps on Cookie Chain for fees and rent, never bridged. */
export const OPERATOR_COOK_RESERVE = 5_000;

/** SOL the operator keeps on Solana for fees, before any is bought out of a run's cost budget. */
export const OPERATOR_SOL_FLOOR = 0.02;

export const DEFAULT_SLIPPAGE_BPS = 500;

// --- The vault program ---------------------------------------------------------------------------

/**
 * Coorwa's own program on Cookie Chain, in `programs/corwa-vault`: a merkle distributor that pays
 * against published roots. The app pays holders through the daily run now, so only the program's
 * client (`src/lib/vault.ts`) and its tests use this.
 *
 * Overridable so a fork can point at its own deployment without rebuilding the client.
 */
export const VAULT_PROGRAM_ADDRESS =
  process.env.NEXT_PUBLIC_VAULT_PROGRAM_ID?.trim() ||
  "83cPao5iemCJ6dj9ni7KXGo7JCVHtQu2jfMVuD7ywdYg";

/**
 * The vault's authority, a wallet Coorwa holds. It was the launchpad referrer before the operator
 * took over, so it is kept out of holder pools like the operator is.
 */
export const VAULT_AUTHORITY = process.env.NEXT_PUBLIC_VAULT_AUTHORITY?.trim() || "";

/**
 * The smallest LP or creator fee payout, in USD, that can be taken as an xStock instead of COOK.
 *
 * Measured on 2026-09-11, the route loses about 1.4% to slippage at every size from $0.46 to $9, so
 * the percentage cost is not what sets a floor. The fixed cost is: the first payout into an asset
 * opens two token accounts on Solana for about 0.0038 SOL of rent, near $0.38, and every payout pays
 * a bridge dispatch and two Solana fees on top. Under a dollar that is too large a share of what
 * arrives, and COOK is the better way to take it.
 */
export const CASHBACK_RWA_MIN_USD = 1;

// --- Misc --------------------------------------------------------------------------------------

export const HTTP_TIMEOUT_MS = 12_000;

export function cookieTxUrl(sig: string) {
  return `${COOKIE_EXPLORER}/tx/${sig}`;
}
export function cookieAccountUrl(addr: string) {
  return `${COOKIE_EXPLORER}/account/${addr}`;
}
export function solanaTxUrl(sig: string) {
  return `${SOLANA_EXPLORER}/tx/${sig}`;
}
