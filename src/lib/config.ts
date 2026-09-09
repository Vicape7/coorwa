/**
 * Corwa - single source of truth for chain, program and API constants.
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
 * True when no dedicated Solana RPC is configured.
 *
 * The fallback is not merely throttled. api.mainnet-beta.solana.com answers a server happily but
 * returns 403 to any request carrying a browser origin, so the Solana legs of a cross-chain route
 * cannot run from the user's browser at all. Reads that Corwa can do on their behalf go through
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

// --- Corwa economics ---------------------------------------------------------------------------

/**
 * MomoSwap pays the referrer 20% of its 1% curve trade fee, out of the same fee either way - with
 * no referrer the program folds that share into its treasury instead. So naming Corwa costs the
 * trader nothing and is the honest source of launchpad-side cashback.
 */
export const CORWA_REFERRER = process.env.CORWA_REFERRER?.trim() || "";
export const MOMOSWAP_TRADE_FEE_BPS = 100;
export const MOMOSWAP_REFERRAL_SHARE = 0.2;

/** How the referral + router revenue is split back out. Must sum to 1. */
export const CASHBACK_SPLIT = {
  trader: 0.5,
  creator: 0.3,
  liquidity: 0.2,
} as const;

export const DEFAULT_SLIPPAGE_BPS = 500;

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
