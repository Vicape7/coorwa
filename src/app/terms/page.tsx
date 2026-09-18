import Link from "next/link";
import { SiteShell } from "@/components/site-shell";
import { LegalPage } from "@/components/legal-page";
import {
  REWARD_SPLIT,
  COORWA_SWAP_FEE_BPS,
  HOLDER_MIN_USD,
  PAIR_LISTING_USD,
  PAYOUT_MIN_USD,
} from "@/lib/config";

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
        updated="17 September 2026"
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
                  Coorwa is a website that lets you trade tokens on Cookie Chain, launch tokens
                  through the MomoSwap launchpad, add liquidity to existing pools, and compare a
                  token&apos;s price with tokenised stocks. It builds transactions for you to review
                  and sign in your own wallet.
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
            title: "Fees",
            body: (
              <ul className="list-disc space-y-2 pl-5">
                <li>
                  A swap through the Coorwa terminal pays a {COORWA_SWAP_FEE_BPS / 100}% fee, shown
                  in the swap panel before you sign.
                </li>
                <li>
                  On a launchpad buy, MomoSwap pays Coorwa part of its own curve fee. This does not
                  add to what you pay.
                </li>
                <li>
                  The creator of a token launched outside Coorwa pays ${PAIR_LISTING_USD} in COOK,
                  once, to choose the token&apos;s pair. This payment is not refundable.
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
                  Coorwa shares the fees it earns on a token with that token&apos;s holders (
                  {REWARD_SPLIT.holders * 100}%) and its creator ({REWARD_SPLIT.creator * 100}
                  %). When Coorwa cannot tell who created a token, the creator&apos;s part goes to
                  its holders as well. Fees are collected in Coorwa&apos;s operator wallet and, once
                  a day, bridged to Solana, used to buy the token&apos;s pair stock and sent to
                  eligible wallets.
                  While this happens, the fees are held by Coorwa.
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
                Coorwa depends on services it does not run, including Cookie Chain, MomoSwap,
                Cookiebox, Candy Shop, the Hyperlane bridge, Solana, Jupiter, Backed, Cookiescan and
                wallet providers. They have their own terms, can fail or change, and Coorwa is not
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
                  href="https://x.com/xVicape"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary underline underline-offset-4"
                >
                  @xVicape on X
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
