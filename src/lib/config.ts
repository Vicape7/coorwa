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

/**
 * What an address looks like: base58, 32 to 44 characters.
 *
 * Worth checking before a caller's string is put into a request to somebody else's API, because a
 * path segment that is not an address is a path segment that points somewhere else entirely.
 */
export const ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Cookiescan REST: the token registry (~6.5k mints) and the markets/pools feed (160 pools). */
export const COOKIESCAN_API = "https://api.cookiescan.io";

/** Cookiebox aggregator - routes all Cookie Chain DEX liquidity. GET /quote, POST /swap-tx. */
export const COOKIEBOX_AGG_API = "https://agg.cookiebox.app";

/** Candy Shop - the second router, used as a fallback and for quote comparison. */
export const CANDYSHOP_API = "https://swap.cookiescan.io/api";

/** MomoSwap bonding-curve launchpad. Its API builds and partial-signs launchpad transactions. */
export const MOMOSWAP_API = "https://api.momoswap.fun";
export const MOMOSWAP_SITE = "https://www.momoswap.fun";

export const PROGRAM_IDS = {
  cookieboxDamm: "DAMMjDCEFTDkt7ywazZS8GoaLtjb3HaJo3pLbf64xrPY",
  cookieboxClmm: "CLMMmWqTtyNSomqXP3kETJy2SGKPdr31USsm4GfbLyKs",
  cookieswapBamm: "WTzkPUoprVx7PDc1tfKA5sS7k1ynCgU89WtwZhksHX5",
  cookieswapXybn: "xYBN2zddsqSy41tg1yD9nJScCmqquZnHUyzXBfLEqC8",
  momoswapLaunchpad: "momoL7wu4TrXjnXMLCLzGsbx8Pm7XGgoYo7FVqDoqcw",
} as const;

// --- Solana mainnet (the RWA side) -------------------------------------------------------------

/** The default, which answers a server but refuses any request carrying a browser origin. */
const PUBLIC_SOLANA_RPC = "https://api.mainnet-beta.solana.com";

/**
 * Where the browser talks to Solana: Coorwa's own endpoint, which relays a short list of calls and
 * adds the RPC key server side (`src/app/api/solana-rpc/route.ts`).
 *
 * No RPC key is shipped in the page. Every Solana endpoint worth using needs one, and a key in a
 * page is a public key however it is restricted, because a domain rule only stops other websites
 * and not a script that sets the header itself.
 */
export const SOLANA_RPC_PATH = "/api/solana-rpc";

/**
 * Where the app lives. It is written into things that outlive a request, above all the uri a
 * launched mint carries, so it is a constant rather than whatever host a request happened to
 * arrive on. Overridable for a fork.
 */
export const SITE_ORIGIN = process.env.NEXT_PUBLIC_SITE_ORIGIN?.trim() || "https://coorwa.fun";

export function browserSolanaRpc(): string {
  // web3.js insists on an absolute URL. On the server this value is never used to make a call: the
  // panels that build a connection only ever run in the browser.
  const origin = typeof window === "undefined" ? SITE_ORIGIN : window.location.origin;
  return `${origin}${SOLANA_RPC_PATH}`;
}

/**
 * The Solana RPC for server code: payouts, payment checks, position reads, and the relay above.
 *
 * `SOLANA_SERVER_RPC_URL` is a secret and never reaches a browser. It is read on each call because
 * a Worker secret is not in the environment when this module first loads. `SOLANA_BROWSER_RPC_URL`
 * is optional and lets the relay run on a second key, so traffic from the site cannot eat the rate
 * limit the payout run depends on.
 */
export function serverSolanaRpcUrl(): string {
  return process.env.SOLANA_SERVER_RPC_URL?.trim() || PUBLIC_SOLANA_RPC;
}

export function browserSolanaRpcUrl(): string {
  return process.env.SOLANA_BROWSER_RPC_URL?.trim() || serverSolanaRpcUrl();
}

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
/** MomoSwap mints every launchpad token with six decimals. */
export const CURVE_TOKEN_DECIMALS = 6;
export const MOMOSWAP_REFERRAL_SHARE = 0.2;

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
 * Coorwa's launch program, in `programs/corwa-launch`: it mints a token whose transfer tax pays that
 * token's holders, sells it on a bonding curve against COOK, and at its target opens a Cookiebox
 * pool and locks the liquidity there forever. Its client is `src/lib/launch-program.ts`.
 *
 * Overridable for the same reason as the vault's: a fork should be able to point at its own
 * deployment without rebuilding anything.
 */
export const LAUNCH_PROGRAM_ADDRESS =
  process.env.NEXT_PUBLIC_LAUNCH_PROGRAM_ID?.trim() ||
  "DT7Jds9LADV82pdKyDBcYPDfb7vaKvHcbyEG48zxuvZq";

/**
 * Whether the launch form is open to whoever opens the page.
 *
 * The program works, but a token it mints promises its holders a daily payout and its buyers a
 * pool at the end, and both of those still run by hand. Until they run by themselves, a stranger's
 * launch would be a promise Coorwa keeps manually, so the page says so instead. Closed in
 * production, open everywhere else, and `NEXT_PUBLIC_LAUNCH_OPEN` decides it either way.
 */
export const LAUNCH_OPEN = process.env.NEXT_PUBLIC_LAUNCH_OPEN
  ? process.env.NEXT_PUBLIC_LAUNCH_OPEN.trim() === "true"
  : process.env.NODE_ENV !== "production";

/**
 * The Cookiebox pool config a graduated curve opens its pool against, and the pool program itself.
 *
 * The config fixes the pool's fee and its price range, so it is part of what a launch promises
 * rather than something the crank picks: this one is public, charges a flat 1% and collects its fees
 * in the quote token only, which keeps the taxed side out of the fee accounting entirely.
 */
export const DAMM_PROGRAM_ADDRESS = "DAMMjDCEFTDkt7ywazZS8GoaLtjb3HaJo3pLbf64xrPY";
export const DAMM_POOL_CONFIG =
  process.env.NEXT_PUBLIC_DAMM_POOL_CONFIG?.trim() ||
  "9H6eQjax36XECa73mAufWiq8yVKae6K7NLK5ZubUzxnf";

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
export const STOCK_PAYOUT_MIN_USD = 1;

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
