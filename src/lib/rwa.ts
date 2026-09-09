/**
 * The RWA side of Corwa: Backed Finance xStocks on Solana mainnet.
 *
 * Every mint below was read from its own account on mainnet, not from a token list. They are all
 * Token-2022 with 8 decimals and share a set of extensions that matter to us:
 *
 *   - `scaledUiAmountConfig` - these tokens REBASE. The real balance is raw x multiplier, and the
 *     multiplier changes on a schedule (dividends, splits). Never treat raw units as a price basis.
 *   - `permanentDelegate` / `pausableConfig` / `freezeAuthority` - Backed can claw back, pause or
 *     freeze. This is precisely why Corwa never escrows an xStock: we route through Jupiter into
 *     the user's own wallet instead of wrapping a bridged representation.
 *   - `transferHook` - authority set, program currently null. It can be switched on at any time,
 *     which would break any pool holding these as a quote asset.
 */

export interface RwaAsset {
  /** xStock ticker, e.g. "NVDAx". */
  symbol: string;
  /** The underlying equity ticker Corwa denominates in, e.g. "NVDA". */
  ticker: string;
  name: string;
  mint: string;
  decimals: number;
  logo: string;
}

const x = (
  ticker: string,
  name: string,
  mint: string,
): RwaAsset => ({
  symbol: `${ticker}x`,
  ticker,
  name,
  mint,
  decimals: 8,
  logo: `https://xstocks-metadata.backed.fi/logos/tokens/${ticker}x.png`,
});

/** Ordered by on-chain liquidity at the time of writing - deepest first. */
export const RWA_ASSETS: RwaAsset[] = [
  x("SPY", "S&P 500", "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W"),
  x("CRCL", "Circle", "XsueG8BtpquVJX9LVLLEGuViXUungE6WmK5YZ3p3bd1"),
  x("QQQ", "Nasdaq 100", "Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ"),
  x("NVDA", "NVIDIA", "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh"),
  x("TSLA", "Tesla", "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB"),
  x("MSTR", "MicroStrategy", "XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ"),
  x("HOOD", "Robinhood", "XsvNBAYkrDRNhA7wPHQfX3ZUXZyZLdnCQDfHZ56bzpg"),
  x("COIN", "Coinbase", "Xs7ZdzSHLU9ftNJsii5fCeJhoRWSC32SQGzGQtePxNu"),
  x("AAPL", "Apple", "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp"),
  x("GOOGL", "Alphabet", "XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN"),
  x("AMZN", "Amazon", "Xs3eBt7uRfJX8QUs4suhyU8p2M6DoUDrJyWBa8LLZsg"),
  x("MSFT", "Microsoft", "XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX"),
  x("META", "Meta", "Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu"),
  x("PLTR", "Palantir", "XsoBhf2ufR8fTyNSjqfU71DYGaE6Z3SUGAidpzriAA4"),
  x("AMD", "AMD", "XsXcJ6GZ9kVnjqGsjBnktRcuwMBmvKWh8S93RefZ1rF"),
  x("NFLX", "Netflix", "XsEH7wWfJJu2ZT3UCFeVfALnVA6CP5ur7Ee11KmzVpL"),
];

const byTicker = new Map(RWA_ASSETS.map((a) => [a.ticker.toUpperCase(), a]));
const byMint = new Map(RWA_ASSETS.map((a) => [a.mint, a]));

export function rwaByTicker(ticker: string): RwaAsset | undefined {
  return byTicker.get(ticker.toUpperCase().replace(/X$/, ""));
}

export function rwaByMint(mint: string): RwaAsset | undefined {
  return byMint.get(mint);
}

/** The default quote asset a pair falls back to when none is named. */
export const DEFAULT_RWA = rwaByTicker("NVDA")!;
