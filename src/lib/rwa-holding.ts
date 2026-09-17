/**
 * Reading an xStock position, in the two units that are not the same number.
 *
 * xStocks carry Token-2022's `scaledUiAmountConfig`, so a holder's balance is the raw amount times
 * a multiplier that Backed moves on dividends and splits. NVDAx was at 1.0009180758490996 when
 * this was written, which is small enough to look like a rounding error and large enough to make a
 * sale fail for insufficient balance.
 *
 * The split that matters:
 *
 *   - **raw** is what a program moves. Jupiter, the token account, the transfer instruction.
 *   - **shares** is what the holder sees. The RPC applies the multiplier to `uiAmount` itself,
 *     which is why the account is read rather than computed from a typed number wherever possible.
 *
 * Everything that spends an xStock therefore takes raw units, and everything shown to the user is
 * in shares. Converting between them by hand is the thing to avoid, and where it is unavoidable -
 * pricing a size for someone who does not hold the asset yet - the multiplier is read off the mint
 * rather than assumed to be 1.
 *
 * These run server-side, behind `/api/rwa/holding`. Solana's public RPC answers a server but
 * returns 403 to anything with a browser origin, so a direct read from the panel would silently
 * fall back to a multiplier of 1 and size the sale wrong.
 */
import { Connection, PublicKey } from "@solana/web3.js";

export interface RwaHolding {
  /** Raw units, exactly as the token account stores them. This is what a swap spends. */
  raw: string;
  /** The scaled balance the holder sees, already multiplied by the RPC. */
  shares: number;
}

/** The owner's position in one xStock, summed across their accounts. Null when they hold none. */
export async function readHolding(
  conn: Connection,
  owner: PublicKey,
  mint: string,
): Promise<RwaHolding | null> {
  const accounts = await conn.getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(mint) });

  let raw = 0n;
  let shares = 0;
  for (const a of accounts.value) {
    const t = a.account.data.parsed?.info?.tokenAmount;
    if (!t) continue;
    raw += BigInt(t.amount);
    shares += t.uiAmount ?? 0;
  }

  return raw > 0n ? { raw: raw.toString(), shares } : null;
}

/**
 * The multiplier currently in force on a scaled-UI-amount mint.
 *
 * The extension carries two of them. `newMultiplier` takes over at its effective timestamp and the
 * account keeps both afterwards, so reading `multiplier` alone silently returns a stale figure -
 * NVDAx has been on its `newMultiplier` since well before this was written.
 *
 * Returns 1 for a mint that simply has no extension, which is what an unscaled mint is worth, and
 * **null** when the mint could not be read at all. Those two used to be the same answer, and they
 * are not: a failed read that says 1 sizes a sale wrong by exactly the rebase, on a balance the
 * user can see is large enough. A caller that gets null has to say so rather than guess.
 *
 * A cold Worker has produced a failed read before, so the RPC is asked twice before giving up.
 */
export async function readMultiplier(conn: Connection, mint: string): Promise<number | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const info = await conn.getParsedAccountInfo(new PublicKey(mint), "confirmed");
      const data = info.value?.data;
      if (!data || !("parsed" in data)) continue;

      const extensions: Array<{ extension?: string; state?: Record<string, unknown> }> =
        data.parsed?.info?.extensions ?? [];
      const scaled = extensions.find((e) => e.extension === "scaledUiAmountConfig")?.state;
      if (!scaled) return 1;

      const now = Math.floor(Date.now() / 1000);
      const effective = Number(scaled.newMultiplierEffectiveTimestamp ?? 0);
      const value = Number(
        effective > 0 && effective <= now ? scaled.newMultiplier : scaled.multiplier,
      );
      if (Number.isFinite(value) && value > 0) return value;
    } catch {
      // Both attempts are allowed to fail; what must not happen is answering 1 as if it were read.
    }
  }
  return null;
}

/**
 * Turn a share count the user typed into raw units a swap can spend.
 *
 * Rounds down, always. Rounding up would ask the swap for units the account does not have, and the
 * transaction would fail on a balance the user can see is large enough - the worst kind of error
 * to have to explain.
 */
export function sharesToRaw(shares: number, decimals: number, multiplier: number): string {
  const raw = Math.floor((shares / (multiplier || 1)) * 10 ** decimals);
  return String(Math.max(0, raw));
}
