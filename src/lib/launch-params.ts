/**
 * What Coorwa's launch program is configured with on Cookie Chain.
 *
 * The chain is the source of truth at runtime: the app reads the config account and prices every
 * quote off it, so a value here that drifts changes nothing by itself. This file is the record of
 * what was written, and what `npm run launch:config` writes, which is why every number in it is one
 * Jakub settled rather than something derived at the call site.
 *
 * The curve is a constant product over virtual reserves. Start price is `virtualQuote / virtualBase`
 * and the reserves are chosen so that selling exactly `saleBase` tokens raises exactly
 * `graduationQuote`, which is what makes the target land on the number rather than near it.
 */
import { COOK_DECIMALS, CURVE_TOKEN_DECIMALS, DAMM_POOL_CONFIG, COORWA_OPERATOR } from "./config";

const COOK = 10n ** BigInt(COOK_DECIMALS);
const TOKEN = 10n ** BigInt(CURVE_TOKEN_DECIMALS);

/** One billion tokens, split between the curve and the pool the curve graduates into. */
export const SALE_BASE = 800_000_000n * TOKEN;
export const MIGRATION_BASE = 200_000_000n * TOKEN;

/** The raise that graduates a curve: 1,000,000 COOK, the same order the launchpad uses today. */
export const GRADUATION_QUOTE = 1_000_000n * COOK;

/**
 * The virtual reserves behind the curve.
 *
 * A third of the target in quote and four thirds of the sale in base put the start price at
 * 0.0003125 COOK a token and the graduation price at 0.005, a sixteen-fold rise across the raise,
 * with the last token of `saleBase` sold exactly as the target is reached.
 */
export const VIRTUAL_QUOTE = GRADUATION_QUOTE / 3n;
export const VIRTUAL_BASE = (SALE_BASE * 4n) / 3n;

/** The tax a creator may pick, in basis points. The fourth slot is unused and stays zero. */
export const TAX_TIERS: [number, number, number, number] = [100, 200, 300, 0];

/** Coorwa's cut of a curve trade, the same 1% a launch costs today. */
export const CURVE_FEE_BPS = 100;

/** The creator's share of the locked pool's fees after graduation; Coorwa keeps the rest. */
export const CREATOR_LP_SHARE_BPS = 4000;

/**
 * The parameters `initializeConfig` is called with.
 *
 * `feeRecipient` and `withholdAuthority` are both the operator wallet: curve fees land where every
 * other fee lands, and the tax is swept by the same key that runs the daily payout.
 */
export function launchConfigParams(operator: string = COORWA_OPERATOR) {
  return {
    feeRecipient: operator,
    withholdAuthority: operator,
    curveFeeBps: CURVE_FEE_BPS,
    creatorLpShareBps: CREATOR_LP_SHARE_BPS,
    taxTiers: TAX_TIERS,
    graduationQuote: GRADUATION_QUOTE,
    saleBase: SALE_BASE,
    migrationBase: MIGRATION_BASE,
    virtualQuote: VIRTUAL_QUOTE,
    virtualBase: VIRTUAL_BASE,
    tokenDecimals: CURVE_TOKEN_DECIMALS,
    paused: false,
    dammConfig: DAMM_POOL_CONFIG,
  };
}

/** The whole supply the program mints, which is the two halves of it above. */
export const TOTAL_SUPPLY = SALE_BASE + MIGRATION_BASE;
