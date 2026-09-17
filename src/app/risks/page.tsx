import { SiteShell } from "@/components/site-shell";
import { LegalPage } from "@/components/legal-page";

export const metadata = {
  title: "Risks · Coorwa",
  description: "What can go wrong when you trade, launch or hold tokens through Coorwa.",
};

export default function RisksPage() {
  return (
    <SiteShell>
      <LegalPage
        label="Legal"
        title="Risks"
        updated="17 September 2026"
        intro={
          <p>
            Only use money you can afford to lose completely. Nothing on Coorwa is investment, tax
            or legal advice.
          </p>
        }
        sections={[
          {
            title: "Tokens can go to zero",
            body: (
              <p>
                Tokens on Cookie Chain, and launchpad tokens most of all, are highly volatile. Many
                lose nearly all of their value, sometimes within minutes. Anyone can launch a token,
                and Coorwa does not check who is behind one.
              </p>
            ),
          },
          {
            title: "Thin liquidity",
            body: (
              <p>
                Small pools move a lot on each trade. You may get a worse price than quoted, or be
                unable to sell at all. Comparing a token with a stock does not make it more stable.
              </p>
            ),
          },
          {
            title: "xStocks are not shares",
            body: (
              <>
                <p>
                  xStocks are tracker certificates issued by Backed. Holding one does not make you a
                  shareholder: there are no voting rights, and you depend on the issuer keeping its
                  promises.
                </p>
                <p>
                  The issuer can freeze, pause or take back tokens. Their unit count changes with
                  corporate actions, so the number you hold can change while its value does not.
                </p>
              </>
            ),
          },
          {
            title: "Rewards are not guaranteed",
            body: (
              <p>
                Rewards depend on trading fees, which may be tiny or none. Fees wait in
                Coorwa&apos;s operator wallet until the daily payout, so for that time they depend
                on that wallet being safe. A payout can fail or be delayed if the bridge, Jupiter or
                a network does not work, and costs are deducted first.
              </p>
            ),
          },
          {
            title: "Smart contracts and bridges",
            body: (
              <p>
                Coorwa uses programs it did not write, and a bridge between Cookie Chain and Solana.
                Bugs, exploits or outages in any of them can lose funds. Cookie Chain is a young
                network and can halt or change.
              </p>
            ),
          },
          {
            title: "Your own mistakes",
            body: (
              <p>
                A lost seed phrase, a signed malicious transaction or a transfer to the wrong
                address cannot be undone by anyone. Only sign transactions you understand.
              </p>
            ),
          },
          {
            title: "Law and tax",
            body: (
              <p>
                Rules for tokens and tokenised stocks differ between countries and change often.
                Trades and rewards may be taxable where you live. You are responsible for following
                your local law and paying your taxes.
              </p>
            ),
          },
        ]}
      />
    </SiteShell>
  );
}
