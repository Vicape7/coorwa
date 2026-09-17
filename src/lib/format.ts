/** Display helpers. All money formatting funnels through here so the terminal stays consistent. */

export function rawToUi(raw: string | bigint | number, decimals: number): number {
  return Number(BigInt(typeof raw === "number" ? Math.round(raw) : raw)) / 10 ** decimals;
}

export function uiToRaw(ui: number, decimals: number): string {
  return BigInt(Math.round(ui * 10 ** decimals)).toString();
}

export function shortAddr(addr: string, chars = 4): string {
  if (!addr || addr.length <= chars * 2 + 1) return addr ?? "";
  return `${addr.slice(0, chars)}…${addr.slice(-chars)}`;
}

/** Compact USD: $1.2M, $34.5k, $0.94, $0.00004312 */
export function usd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(1)}k`;
  if (abs >= 1) return `$${n.toFixed(2)}`;
  if (abs >= 0.01) return `$${n.toFixed(4)}`;
  if (abs === 0) return "$0";
  return `${n < 0 ? "-" : ""}$${tinyNumber(abs)}`;
}

/** Token amounts: keeps precision on tiny numbers without printing 18 zeros. */
export function amount(n: number | null | undefined, maxFrac = 6): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs === 0) return "0";
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (abs >= 1) return n.toLocaleString("en-US", { maximumFractionDigits: maxFrac });
  return tinyNumber(n);
}

/**
 * How much of an RWA a token is worth. These ratios are tiny (a memecoin priced in NVDA shares is
 * ~1e-9), so plain toFixed would render every pair as 0.000000.
 */
export function rwaRatio(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n === 0) return "—";
  return tinyNumber(n);
}

const SUBSCRIPT = "₀₁₂₃₄₅₆₇₈₉";

/**
 * A small positive number the way DEX screeners print it: 0.000000004302 becomes 0.0₈4302, the
 * subscript counting the zeros after the decimal point. Scientific notation (4.302e-9) was what the
 * pair page showed before, and nobody reads a price that way.
 */
export function tinyNumber(n: number, significant = 4, trim = true): string {
  if (!Number.isFinite(n) || n === 0) return "0";
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs >= 0.001) {
    return sign + abs.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  }
  // toExponential does the rounding, including the 9.99995e-9 -> 1.000e-8 carry.
  const [mantissa, exp] = abs.toExponential(significant - 1).split("e");
  const zeros = -Number(exp) - 1;
  const all = mantissa.replace(".", "");
  const digits = (trim ? all.replace(/0+$/, "") : all) || "0";
  const sub = String(zeros)
    .split("")
    .map((d) => SUBSCRIPT[Number(d)])
    .join("");
  return `${sign}0.0${sub}${digits}`;
}

export function pct(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n >= 0 ? "+" : ""}${n.toFixed(digits)}%`;
}

export function timeAgo(ts: number | null | undefined): string {
  if (!ts) return "—";
  const ms = ts > 1e12 ? ts : ts * 1000;
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
