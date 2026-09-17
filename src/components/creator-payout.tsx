"use client";

/**
 * A launchpad creator's fees taken as a stock: claim them from the pool, bridge the COOK to
 * Solana, and buy the token's pair stock into the same wallet there. See `StockPayout` for the
 * panel and `claimCreatorFees` in `crosschain-exec.ts` for the leg this adds.
 */
import { useMemo } from "react";
import { COOK_DECIMALS, COOK_MINT, COOK_SYMBOL } from "@/lib/config";
import { creatorClaimLeg, creatorPayoutSlug } from "@/lib/payout";
import { rwaByTicker } from "@/lib/rwa";
import { StockPayout, type PayoutSpec } from "./rwa-payout";

export function CreatorPayout({
  pool,
  pendingCook,
  ticker,
  onSettled,
}: {
  pool: string;
  pendingCook: number;
  /** The token's pair asset. Creator fees are paid in it and in nothing else. */
  ticker: string;
  onSettled: () => void;
}) {
  const spec = useMemo<PayoutSpec>(() => {
    const stock = rwaByTicker(ticker)?.symbol ?? ticker;
    return {
      slug: creatorPayoutSlug(pool),
      ticker,
      owedCook: pendingCook,
      pricings:
        pendingCook > 0
          ? [
              {
                inputMint: COOK_MINT,
                inputSymbol: COOK_SYMBOL,
                inputDecimals: COOK_DECIMALS,
                amount: pendingCook,
                firstLeg: creatorClaimLeg(pendingCook),
              },
            ]
          : [],
      token: { mint: COOK_MINT, symbol: COOK_SYMBOL, decimals: COOK_DECIMALS },
      input: { amount: pendingCook, symbol: COOK_SYMBOL },
      creatorClaim: { pool },
      copy: {
        title: `Take these fees as ${stock}`,
        body:
          `Claim the fees, bridge the COOK to Solana, and buy ${stock}, this token's pair stock, ` +
          "into this same wallet there. Each step is its own signature, and a payout that stops " +
          "halfway picks up where it left off.",
        action: "Claim fees as",
        done: "Paid out in full.",
        resumeSafety:
          "Resuming checks whether the claim already landed before sending anything, so the claim " +
          "and each trade go out once.",
      },
    };
  }, [pool, pendingCook, ticker]);

  return <StockPayout spec={spec} hidden={pendingCook <= 0} onSettled={onSettled} />;
}
