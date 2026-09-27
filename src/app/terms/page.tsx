import Link from "next/link";
import { SiteShell } from "@/components/site-shell";
import { LegalPage } from "@/components/legal-page";
import {
  COOK_DECIMALS,
  COORWA_SWAP_FEE_BPS,
  CURVE_TOKEN_DECIMALS,
  HOLDER_MIN_USD,
  LAUNCH_PROGRAM_ADDRESS,
  PAYOUT_MIN_USD,
} from "@/lib/config";
import {
  CREATOR_LP_SHARE_BPS,
  CURVE_FEE_BPS,
  GRADUATION_QUOTE,
  MIGRATION_BASE,
  SALE_BASE,
  TAX_TIERS,
  TOTAL_SUPPLY,
} from "@/lib/launch-params";

/** A raw on-chain amount as whole units, e.g. 1,000,000,000. */
function whole(raw: bigint, decimals: number): string {
  return (raw / 10n ** BigInt(decimals)).toLocaleString("en-US");
}

const TIERS = TAX_TIERS.filter((bps) => bps > 0).map((bps) => `${bps / 100}%`);
const TIER_TEXT = `${TIERS.slice(0, -1).join(", ")} or ${TIERS.at(-1)}`;

export const metadata = {
  title: "Terms · Coorwa",
  description: "The terms for using Coorwa.",
};

export default function TermsPage() {
  return (
    <SiteShell>
      <LegalPage
        label="Legal"
        title="Terms of use"
        updated="27 September 2026"
        intro={
          <p>
            These terms apply whenever you use the Coorwa website and the tools on it. By connecting
            a wallet or signing a transaction through Coorwa you accept them. If you do not agree,
            do not use Coorwa.
          </p>
        }
        sections={[
          {
            title: "What Coorwa is",
            body: (
              <>
                <p>
                  Coorwa is a website that lets you trade tokens on Cookie Chain, launch tokens on
                  Coorwa&apos;s own launch program, and compare a token&apos;s price with tokenised
                  stocks. Holders of a token can receive rewards in that token&apos;s paired stock.
                  Coorwa builds transactions for you to review and sign in your own wallet.
                </p>
                <p>
                  Coorwa is not a broker, exchange, bank, custodian of your wallet or investment
                  adviser. It does not issue any of the tokens or stocks shown on the site.
                </p>
              </>
            ),
          },
          {
            title: "Who may use it",
            body: (
              <>
                <p>
                  You must be at least 18 years old and allowed to use services like this where you
                  live. You may not use Coorwa if you are subject to sanctions, or if you are in a
                  country or region where using it would break the law.
                </p>
              </>
            ),
          },
          {
            title: "Your wallet",
            body: (
              <>
                <p>
                  You connect your own wallet and sign every transaction yourself. Coorwa never asks
                  for your seed phrase or private key and cannot move tokens out of your wallet.
                </p>
                <p>
                  Transactions on a blockchain are final. Check each one in your wallet before you
                  sign it. Coorwa cannot reverse, cancel or refund a transaction once it is sent.
                </p>
              </>
            ),
          },
          {
            title: "Launching a token",
            body: (
              <>
                <p>
                  Tokens are launched on Coorwa&apos;s launch program on Cookie Chain (
                  <span className="num break-all">{LAUNCH_PROGRAM_ADDRESS}</span>). The creator
                  picks the name, symbol, image, the paired stock and a transfer tax of {TIER_TEXT}.
                  None of these can be changed after launch.
                </p>
                <p>
                  Every token has a fixed supply of {whole(TOTAL_SUPPLY, CURVE_TOKEN_DECIMALS)}.{" "}
                  {whole(SALE_BASE, CURVE_TOKEN_DECIMALS)} are sold on a bonding curve against COOK.
                  When the curve has raised {whole(GRADUATION_QUOTE, COOK_DECIMALS)} COOK it
                  graduates: the program opens a Cookiebox pool with the COOK raised and the other{" "}
                  {whole(MIGRATION_BASE, CURVE_TOKEN_DECIMALS)} tokens, locks that liquidity
                  permanently and burns any tokens the curve did not sell. The token has no mint
                  authority and no freeze authority, so nobody, Coorwa included, can create more of
                  it, freeze it or take it from a wallet.
                </p>
                <p>
                  The creator is responsible for what the token is called and shows, and must have
                  the right to use its name and image. A token may not pretend to be another project,
                  person or company. Coorwa stores each token&apos;s name, symbol and image, and may
                  stop hosting them or stop showing a token on the site if it breaks these terms or
                  the law. That changes only what Coorwa displays: the token itself stays on chain.
                </p>
                <p>
                  Coorwa holds the program&apos;s upgrade authority and can pause new launches. It
                  plans to give the upgrade authority up once the program has run without problems
                  for a while. Until then, see the{" "}
                  <Link href="/risks" className="text-primary underline underline-offset-4">
                    risks
                  </Link>
                  .
                </p>
              </>
            ),
          },
          {
            title: "Fees",
            body: (
              <ul className="list-disc space-y-2 pl-5">
                <li>
                  A buy or sell on a Coorwa curve pays Coorwa {CURVE_FEE_BPS / 100}% of the trade,
                  shown in the trade panel before you sign.
                </li>
                <li>
                  Every transfer of a token launched on Coorwa pays that token&apos;s transfer tax,
                  wherever it happens: a buy, a sell, or a move between wallets. The tax is held back
                  on the token and goes to the token&apos;s holders. Coorwa keeps none of it, except
                  that selling the collected tax for COOK pays the same trading fee as any other
                  sale.
                </li>
                <li>
                  After graduation the locked pool earns the pool&apos;s own trading fee.{" "}
                  {CREATOR_LP_SHARE_BPS / 100}% of what it earns goes to the token&apos;s creator and{" "}
                  {100 - CREATOR_LP_SHARE_BPS / 100}% to Coorwa, paid out by the program.
                </li>
                <li>
                  For tokens launched elsewhere, a swap through the Coorwa terminal pays a{" "}
                  {COORWA_SWAP_FEE_BPS / 100}% fee, and on a MomoSwap curve buy made through Coorwa,
                  MomoSwap pays Coorwa part of its own curve fee, which does not add to what you pay.
                </li>
                <li>Network fees are paid by you to the network, not to Coorwa.</li>
              </ul>
            ),
          },
          {
            title: "Rewards",
            body: (
              <>
                <p>
                  A token launched on Coorwa pays its holders from its transfer tax. For tokens
                  launched elsewhere, Coorwa passes on the fees it earns on them. The wallet that
                  created a token is one of its holders: it is paid for what it holds, on the same
                  terms as anyone else. Coorwa collects the tax, sells it for COOK and, once a day,
                  bridges it to Solana, buys the token&apos;s paired stock and sends it to eligible
                  wallets. While this happens, the money is held in Coorwa&apos;s operator wallet.
                </p>
                <p>
                  To count as a holder a wallet must hold at least ${HOLDER_MIN_USD} of the token.
                  Balances are sampled at random times. Amounts under ${PAYOUT_MIN_USD} carry over.
                  Bridge, swap and network costs are taken out before payout. Pools, programs and
                  Coorwa&apos;s own wallets are never counted, and we may exclude wallets that try
                  to game the sampling.
                </p>
                <p>
                  Rewards are a voluntary programme, not a dividend, interest, a share of profits or
                  a right of any kind. They can be small or zero, can arrive late, and we may change
                  or end the programme at any time. Estimates on the site are estimates.
                </p>
              </>
            ),
          },
          {
            title: "Other services",
            body: (
              <p>
                Coorwa depends on services it does not run, including Cookie Chain, Cookiebox,
                MomoSwap, Candy Shop, the Hyperlane bridge, Solana, Jupiter, Backed, Cookiescan,
                Cloudflare and wallet providers. They have their own terms, can fail or change, and Coorwa is not
                responsible for them.
              </p>
            ),
          },
          {
            title: "What you may not do",
            body: (
              <ul className="list-disc space-y-2 pl-5">
                <li>Break the law, including sanctions and securities laws, through Coorwa.</li>
                <li>Manipulate markets, wash trade, or split holdings to game rewards.</li>
                <li>
                  Attack, overload or try to get unauthorised access to the site or its services.
                </li>
                <li>Use the site to mislead others about a token or about Coorwa.</li>
              </ul>
            ),
          },
          {
            title: "No warranty",
            body: (
              <p>
                Coorwa is provided as it is and as available. Prices, balances, estimates and other
                data can be wrong, delayed or missing. We do not promise that the site will work
                without interruption or errors, or that any token will keep any value.
              </p>
            ),
          },
          {
            title: "Limitation of liability",
            body: (
              <p>
                As far as the law allows, Coorwa and the people behind it are not liable for any
                loss from using the site, including lost tokens, trading losses, failed or delayed
                payouts, bugs in smart contracts, or problems with the services listed above. Where
                liability cannot be excluded, it is limited to the fees you paid to Coorwa in the 30
                days before the claim.
              </p>
            ),
          },
          {
            title: "Changes",
            body: (
              <p>
                We may update these terms. The date at the top shows the latest version. Using
                Coorwa after a change means you accept the new terms. Read also the{" "}
                <Link href="/risks" className="text-primary underline underline-offset-4">
                  risks
                </Link>{" "}
                and the{" "}
                <Link href="/privacy" className="text-primary underline underline-offset-4">
                  privacy notice
                </Link>
                .
              </p>
            ),
          },
          {
            title: "Contact",
            body: (
              <p>
                Questions about these terms or about Coorwa go to{" "}
                <a
                  href="https://x.com/coorwadotfun"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary underline underline-offset-4"
                >
                  @coorwadotfun on X
                </a>
                .
              </p>
            ),
          },
        ]}
      />
    </SiteShell>
  );
}
