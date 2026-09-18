import { SiteShell } from "@/components/site-shell";
import { LegalPage } from "@/components/legal-page";

export const metadata = {
  title: "Privacy · Coorwa",
  description: "What Coorwa stores about you, and who else sees it.",
};

export default function PrivacyPage() {
  return (
    <SiteShell>
      <LegalPage
        label="Legal"
        title="Privacy"
        updated="17 September 2026"
        intro={
          <p>
            Coorwa has no accounts, no sign-up and no tracking cookies. It works with public
            blockchain addresses. This page says what is stored and who else sees it.
          </p>
        }
        sections={[
          {
            title: "What we store",
            body: (
              <>
                <p>
                  Coorwa keeps a database of public, on-chain information needed to pay rewards:
                </p>
                <ul className="list-disc space-y-2 pl-5">
                  <li>
                    trades made through Coorwa: wallet address, token, value, fee and transaction
                    signature;
                  </li>
                  <li>token balances of holders, read from the chain at random times;</li>
                  <li>tokens launched and pairs chosen, with the wallet that paid;</li>
                  <li>rewards owed and paid, with the Solana transaction that paid them.</li>
                </ul>
                <p>
                  We do not ask for your name, email or any other personal details, and we do not
                  link wallet addresses to people.
                </p>
              </>
            ),
          },
          {
            title: "What stays in your browser",
            body: (
              <p>
                Your theme choice, the wallet you last connected, the progress of a transfer
                between chains and a payment whose pair could not be saved yet are kept in your
                browser&apos;s local storage. They stay there, apart from that payment, which is
                sent to Coorwa again when you retry saving its pair. Clearing your site data
                removes them.
              </p>
            ),
          },
          {
            title: "Who else sees your requests",
            body: (
              <>
                <p>Using Coorwa sends requests to these services, which see your IP address:</p>
                <ul className="list-disc space-y-2 pl-5">
                  <li>Cloudflare, which hosts the site;</li>
                  <li>
                    Cookie Chain RPC nodes, which your browser asks for Cookie Chain data directly;
                  </li>
                  <li>
                    Helius, for Solana data. Your browser asks Coorwa, and Coorwa passes the
                    request on, so Helius sees Coorwa&apos;s server rather than your IP address;
                  </li>
                  <li>MomoSwap, Cookiescan and Jupiter, for prices, quotes and transactions;</li>
                  <li>your wallet provider.</li>
                </ul>
                <p>
                  Our database is hosted by Neon. Each of these services handles data under its own
                  privacy policy.
                </p>
              </>
            ),
          },
          {
            title: "Blockchain data is public",
            body: (
              <p>
                Everything you do on Cookie Chain or Solana is public and permanent, whether or not
                you use Coorwa. We cannot delete or change it. Records in our database are kept for
                as long as they are needed to calculate and prove payouts.
              </p>
            ),
          },
          {
            title: "We do not sell data",
            body: <p>We do not sell or rent any data, and we do not show ads.</p>,
          },
          {
            title: "Changes",
            body: <p>We may update this page. The date at the top shows the latest version.</p>,
          },
          {
            title: "Contact",
            body: (
              <p>
                Questions about your data go to{" "}
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
