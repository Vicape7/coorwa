"use client";

/**
 * An LP position's fees taken as a stock.
 *
 * The cross-chain buy route with the position in front of it: claim the fees, sell the token side
 * for COOK, bridge, buy the xStock on Solana. See `StockPayout` for
 * the panel and `claimLpFees` in `crosschain-exec.ts` for the leg this adds.
 */
import { useMemo } from "react";
import { COOK_DECIMALS, COOK_MINT, COOK_SYMBOL } from "@/lib/config";
import { lpClaimLeg, lpPayoutSlug } from "@/lib/payout";
import { rawToUi } from "@/lib/format";
import { rwaByTicker } from "@/lib/rwa";
import { StockPayout, type PayoutPricing, type PayoutSpec } from "./rwa-payout";
import { Notice } from "./notice";

export interface LpPayoutPosition {
  pool: string;
  position: string;
  positionNftAccount: string;
  a: { mint: string; symbol: string; decimals: number; feeRaw: string };
  b: { mint: string; symbol: string; decimals: number; feeRaw: string };
}

export function LpPayout({
  p,
  ticker,
  onSettled,
}: {
  p: LpPayoutPosition;
  /** The pair asset of the pool's token. The fees are paid in it and in nothing else. */
  ticker: string;
  onSettled: () => void;
}) {
  const cookSide = p.a.mint === COOK_MINT ? p.a : p.b.mint === COOK_MINT ? p.b : null;
  const tokenSide = cookSide === p.a ? p.b : p.a;

  const spec = useMemo<PayoutSpec | null>(() => {
    if (!cookSide) return null;
    const cookFee = rawToUi(cookSide.feeRaw, COOK_DECIMALS);
    const tokenFee = rawToUi(tokenSide.feeRaw, tokenSide.decimals);
    const token = { mint: tokenSide.mint, symbol: tokenSide.symbol, decimals: tokenSide.decimals };
    const stock = rwaByTicker(ticker)?.symbol ?? ticker;

    const pricings: PayoutPricing[] = [];
    if (tokenFee > 0) {
      pricings.push({
        inputMint: token.mint,
        inputSymbol: token.symbol,
        inputDecimals: token.decimals,
        amount: tokenFee,
        plusCook: cookFee,
        firstLeg: lpClaimLeg({ cookFee, token: { symbol: token.symbol, amount: tokenFee } }),
      });
    }
    if (cookFee > 0) {
      pricings.push({
        inputMint: COOK_MINT,
        inputSymbol: COOK_SYMBOL,
        inputDecimals: COOK_DECIMALS,
        amount: cookFee,
        firstLeg: lpClaimLeg({ cookFee, token: null }),
        note:
          tokenFee > 0
            ? `The ${token.symbol} side is too small to sell, so it is claimed into your wallet and stays there.`
            : undefined,
      });
    }

    return {
      slug: lpPayoutSlug(p.position),
      ticker,
      owedCook: cookFee + tokenFee,
      pricings,
      token,
      input: { amount: cookFee, symbol: COOK_SYMBOL },
      lpClaim: { pool: p.pool, position: p.position, positionNftAccount: p.positionNftAccount },
      copy: {
        title: "Take these fees as a stock",
        body:
          (tokenFee > 0
            ? `Claim the fees, sell the ${token.symbol} side for COOK, bridge it to Solana, and ` +
              `buy ${stock}, this pair's stock, into this same wallet there. `
            : `Claim the fees, bridge the COOK to Solana, and buy ${stock}, this pair's stock, ` +
              "into this same wallet there. ") +
          "Each step is its own signature, and a payout that stops halfway picks up where it left off.",
        action: "Claim fees as",
        done: "Paid out in full.",
        resumeSafety:
          "Resuming checks what already landed before sending anything, so the claim and each trade " +
          "go out once.",
      },
    };
  }, [cookSide, tokenSide, p.pool, p.position, p.positionNftAccount, ticker]);

  if (!spec) {
    return (
      <div className="mt-4">
        <Notice tone="down">
          This pool has no COOK side, and the bridge to Solana carries COOK only, so its fees cannot
          be paid out as a stock.
        </Notice>
      </div>
    );
  }

  return <StockPayout spec={spec} hidden={spec.owedCook <= 0} onSettled={onSettled} />;
}
