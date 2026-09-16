# Coorwa

Trade Cookie Chain in shares.

Coorwa prices every token on [Cookie Chain](https://www.cookiechain.wtf) against real equities -
NVDA, TSLA, SPY - so a trader can see the number no COOK-denominated terminal shows: **is this
beating the stock?** When they want actual exposure rather than a unit of account, Coorwa routes
them cross-chain into the real xStock on Solana.

Three tools, one fee loop: a **terminal**, a **launchpad**, and an **LP maker**.

---

## The honest part

**There is no TOKEN/NVDA pool anywhere, and Coorwa does not pretend there is.**

NVDAx, TSLAx and the rest are Backed Finance xStocks that live only on Solana, and Cookie Chain's
Hyperlane bridge carries COOK alone. So a Coorwa pair is a *denomination*, built by dividing two
independently verifiable live prices:

```
price(TOKEN in NVDA) = usd(TOKEN) ÷ usd(NVDAx)
```

The numerator comes from real reserves in a Cookie Chain pool (via Cookiescan). The denominator
comes from real Solana liquidity (via Jupiter). Neither is modelled, so the ratio is exact - it is
a change of units, not a synthetic instrument.

### Why not just wrap an xStock onto Cookie Chain?

Because reading the mint account says not to. Every xStock is Token-2022 and carries:

| Extension | State | Consequence for a bridge |
| --- | --- | --- |
| `permanentDelegate` | set | The issuer can claw tokens out of **any** account, escrow included - leaving wrapped supply unbacked |
| `pausableConfig` | `paused: false` | All transfers can be halted globally, freezing anything in flight |
| `freezeAuthority` | set | Individual accounts, including an escrow, can be frozen |
| `scaledUiAmountConfig` | live multiplier | **The token rebases.** A wrapper locking raw units and minting fixed supply drifts off its backing |
| `transferHook` | `programId: null` | Inactive today, but the authority exists - switching it on would break any pool holding it |

So Coorwa never escrows an xStock. It routes the user into one, and the share lands in their own
Solana wallet where all of that is the issuer's problem and Jupiter's job.

---

## What it does

### Terminal
- **A list of pairs somebody chose, not a cross product.** A token is only in the terminal once it
  has a pair. A token launched through Coorwa starts with the one its creator picked at launch, for
  free. Every other pair, on any token, is bought for a dollar on the pools page, by anyone. Crossing
  23 tokens with 16 assets produced 368 rows of arithmetic; this produces a market list.
- **Candles built from executed fills**, not standing pool quotes - and the pair chart is the ratio
  of two real series, so it shows genuine relative performance against the stock.
- A pair that has not traded in 24h shows `—`, never a phantom return from a flat price against a
  moving stock.
- Both Cookie Chain routers (Cookiebox and Candy Shop) quoted on every trade; the better fill wins.
- **Cross-chain settle, both ways**: `TOKEN → COOK → [Hyperlane] → COOK (Solana) → xStock`, and the
  same route run backwards to leave the position. Three signatures each, with per-leg progress and
  measured slippage. A pair you can only enter is a price; a pair you can leave is a market.
- **A stopped route can be resumed from the middle.** The bridge leg is asynchronous, so a failure
  after it dispatches is not a failed trade - it is a half-finished one, with your COOK on the other
  chain. Coorwa writes each leg to storage as it confirms and picks up where it stopped, after a
  rejected signature, a closed tab or a browser restart.

### Launchpad
- Launch on a COOK bonding curve through [MomoSwap](https://momoswap.fun): sign a login message,
  Coorwa builds, your wallet signs.
- **The creator picks the RWA the token is benchmarked against**, once, at launch. That is what
  makes a Coorwa launch a TOKEN/RWA instrument rather than one more row in a cross product. It is
  recorded only after the launch transaction has been read back from the chain and found to name
  that mint, so nobody can pin a token they did not create. Liquidity is still the COOK curve, as
  it is for everything on this chain; the benchmark is what the price is quoted and charted in.
- **Buy and sell on any curve**, priced before you sign. The launchpad publishes no quote endpoint,
  so Coorwa reconstructs the curve from the reserves the pool itself reports. Replayed against fills
  that already settled on chain it reproduces both legs to the raw unit.
- **Creators see and claim their own fees.** MomoSwap pays the creator 0.35% of every trade on
  their curve; it accrues on the pool and is claimed with the creator's own key.
- Every buy names Coorwa as referrer, which is the one place a fee reaches Coorwa at all, and the
  fill is reported for cashback with the token's creator attached so both sides accrue.
- The real fee split is read from the launchpad config at load time, not hardcoded, and the trade
  panel reads it per pool rather than assuming the current default.

### LP maker
- Every pool on the chain, with depth also expressed in shares.
- **The pools page lists pairs, not raw pools.** Each TOKEN/RWA pair is shown with the real
  TOKEN/COOK pool behind it, which is where a deposit goes.
- **A token has one pair, and only its creator picks it.** The pair is the stock the token's holders
  are paid in, so it is fixed: a token launched on Coorwa picks it at launch, and any other token
  gets it once its creator pays a dollar and chooses. Nobody else can add or change a pair. The
  creator is proved against the launch for tokens Coorwa made, and against the mint's metadata
  authority otherwise - which is worth nothing across the registry at large, where 4,449 of 5,088
  tokens share one launchpad key, and works for every token that actually has liquidity here, where
  each resolves to its own wallet. That shared key is refused by name.
- The dollar is a plain COOK transfer to the operator wallet and goes to the token's holders.
  Nothing is credited on the client's word: the payment is read back from the chain, has to be
  signed by the creator, and has to have credited the operator with enough COOK.
- What backs a pair is still the token's real COOK pool. A TOKEN/xStock pool cannot exist on Cookie
  Chain, for the reasons in the table above, and the pair's stock is what the price is quoted and
  charted in and what holders are paid in, rather than what it trades against.
- **Cookiebox DAMM v2 positions managed natively** - deposit, claim fees, withdraw - with
  instructions built against the fork's own program and IDL.
- Positions are found by scanning the Token-2022 NFTs you hold, so Coorwa keeps no records of its
  own.

### Holder rewards
- **Hold a token, get paid in its stock, every day, with nothing to claim.** Every fee Coorwa earns
  on a token is split 62.5 / 37.5 between the wallets holding it and the wallet that made it, and a
  pair's dollar goes entirely to holders. Coorwa keeps none of it. Having traded a token earns
  nothing on its own; holding it through the day does. This is how StonkFun pays its holders, on a
  chain where the stock cannot live: the stock is bought on Solana and sent to the holder's own
  address there, which is the same ed25519 key they hold the token with.
- **Holders are sampled at moments nobody can predict.** A scheduler calls the app every five
  minutes, and the app rolls a die on each call: never two samples within 30 minutes, always one
  within two hours, and otherwise a 15% chance, which lands a sample about once an hour at a random
  minute. A run adds one more snapshot, and each token's pool is shared by every wallet's balance
  summed across all of them. A wallet that buys before one sample and sells after it weighs one
  sample's worth against a holder's whole day. The rewards page shows each holder an estimate of
  their share from the samples so far.
- Each snapshot covers every paired token whose pool has something waiting. Holders are read from
  the chain: SPL token accounts under both token programs, and for a token still on its MomoSwap
  curve, curve shares netted from the launchpad's trade feed. Program addresses (pool vaults,
  curves, escrows) are dropped because nobody holds their keys, as is Coorwa's own operator wallet,
  and a wallet needs at least $5 of the token when it has a price.
- Coorwa names itself referrer on launchpad buys, earning 20% of the 1% curve fee. That share is
  paid out of the same fee either way - with nobody named, MomoSwap keeps it - so it costs a trader
  nothing.
- **Nothing is credited on the client's word.** A reported fill is re-read on chain before it is
  written: the transaction has to exist, to have succeeded, and to have been signed by the wallet
  being credited. For a launchpad fill the size of the trade is capped by the COOK that actually
  moved, and the referral fee is credited only when Coorwa's referrer address is named on the
  transaction itself. For a swap, the fee is whatever the transaction actually paid the operator.
- **Terminal swaps carry Coorwa's own 0.10% fee**, because neither Cookie Chain router will pay a
  referrer. Six plausible parameter names were tried on both aggregators and every quote came back
  identical, so there is nothing to collect unless Coorwa asks. It asks in the open: one COOK
  transfer to the operator appended to the aggregator's own transaction, shown on the panel before
  anything is signed. A route too long to carry it inside the 1,232-byte limit goes through
  unpriced rather than being refused.
- Balances accrue in USD and are converted into the stock only when the run buys it. xStocks rebase,
  so a debt carried in their units would quietly change value between the trade and the payout.

---

## What is signed where

Coorwa never co-signs a user's transaction and never holds a user's tokens. Every transaction a user
makes is built either by an upstream service or by Coorwa's own instruction builders, then
**simulated**, then signed by the user's wallet in their browser, then sent from there.

The one thing Coorwa does hold is the fees it collects, in its operator wallet, between the moment
they are paid and the day's payout run. That is custodial, the same way StonkFun's payout wallets
are, and it is said here rather than hidden: buying a stock on Solana for holders needs a key to
sign it. Every payout run, with its bridge transaction, its costs and every send, is listed on the
rewards page, so what the wallet collected and what it paid out can be checked against the chain.

### What the wallet is shown is what was asked for

Every launchpad transaction (launch, buy, sell, creator-fee claim) is built by MomoSwap, so the page
checks it in the browser before the wallet is asked to sign, on the exact bytes the wallet will
sign (`src/lib/expectation.ts`).

- **Against the builder's own declaration.** MomoSwap returns an `expectation` with every build: the
  fee payer, and for each instruction its program, its accounts with their flags, a sha256 of its
  data, and for a COOK transfer the exact recipient and amount. The bytes must match it exactly.
- **Against what the user asked for.** A builder that declares exactly what it built can still have
  built the wrong thing, so each instruction is also read for itself. Only five programs may
  appear. COOK may only move into the wallet's own wrapped COOK account, and never more than the
  trade spends. The token program may only sync or close that same account, so there is no room for
  a transfer or a delegate approval. The launchpad instruction must carry the amount, the pool and
  the referrer the user chose, and a launch must create the name, symbol and duration they typed.
  A priority fee above 0.001 COOK is refused, because that is the one way to burn a wallet's COOK
  without any instruction naming an amount.

Anything that fails either check stops with a sentence saying what differed, and nothing is signed.
The launchpad publishes no IDL, so the instruction layouts were read off real builds;
`tests/expectation.test.ts` runs the check on six captured responses and on twenty ways of
tampering with them.

### How a payout run works

Fees collect in the operator wallet (`NEXT_PUBLIC_COORWA_OPERATOR`) on Cookie Chain. A run starts a
day after the first holder sample since the last one, and advances one step each time the scheduler
calls the sample endpoint, because it spans two chains and a bridge that takes minutes
(`src/lib/payout-cycle.ts`):

1. **Allocate.** Every paired token's waiting pool is shared over its holders by the day's samples,
   and the creator's share is added, as one line per wallet per token in the token's stock
   (`src/lib/rewards-ledger.ts`). A wallet's lines in one stock are paid once they add up to $1;
   smaller balances wait for later runs, because the first payout into a stock opens a token
   account on Solana for about 0.002 SOL of rent.
2. **Bridge.** The run budgets its Solana costs (new token accounts, fees, swaps), unwraps any
   referral wCOOK, and bridges enough COOK to Solana over the Hyperlane warp route, keeping a small
   reserve on Cookie Chain.
3. **Swap.** Once the COOK arrives, Jupiter swaps it into SOL for the cost budget and into each
   stock being paid, in proportion to what is owed in each.
4. **Send.** Each stock is split over its wallets in whole units, with no unit created or lost, and
   sent five wallets per transaction, creating each holder's token account if needed.
5. **Done.** What the run really spent in SOL is measured and shown next to it.

Every transaction is written to the database before it is sent, so a call that dies mid-step leaves
enough behind for the next one to check what landed rather than pay twice. The operator key is the
`COORWA_OPERATOR_KEY` secret on the Worker and is refused unless it matches the operator address.

`programs/corwa-vault`, the epoch merkle distributor Coorwa used before daily payouts, is still
deployed on Cookie Chain and still in the repo, but the app no longer publishes epochs.

---

## Running it

```bash
npm install
cp .env.example .env.local   # every value has a working default except the optional ones
npm run dev
```

Then open <http://localhost:3000>. Nothing needs configuring to trade: the RPC, both aggregators,
the launchpad and the token registry are all public.

Optional:

```bash
npm run db:push     # enables the rewards page (needs DATABASE_URL)
npm run typecheck
npm run test        # merkle tree, epoch accounting, instruction layouts, IDL agreement
npm run build
```

### Deploying to Cloudflare

The app runs on Cloudflare Workers through the OpenNext adapter (`wrangler.jsonc`,
`open-next.config.ts`). The database is reached through a Hyperdrive config pointing at Postgres,
so each request opens its own client over warm connections; replace the `hyperdrive` id with your
own (`npx wrangler hyperdrive create <name> --connection-string <url>`, using Neon's direct host,
not the `-pooler` one).

```bash
npx wrangler secret put HOLDER_SAMPLE_SECRET   # any long random string
npx wrangler secret put COORWA_OPERATOR_KEY    # the operator keypair, base58 or JSON array
npx wrangler secret put JUPITER_API_KEY        # optional
npm run deploy                                 # builds, then uploads
```

`NEXT_PUBLIC_*` values are baked into the bundle at build time, so they come from `.env.local` on
the machine that builds. `npm run preview` runs the built Worker locally.

The holder sampler is a separate Worker with a cron trigger:

```bash
cd workers/holder-sampler
npm install
npx wrangler secret put HOLDER_SAMPLE_SECRET   # the same value as in the app
# set SAMPLE_URL in wrangler.jsonc to the deployed app, then
npx wrangler deploy
```

### The program

The vault is Rust, and its toolchain is a specific Rust, a specific Agave and a specific Anchor.
Rather than ask anyone to install all three, they are pinned as a container image, so the only
requirement is Docker running:

```bash
npm run program:build    # compile, and copy the IDL to programs/corwa-vault/idl.json
npm run program:test     # run tests/integration against a throwaway validator and postgres
```

`program:test` starts a validator with the program preloaded and a throwaway Postgres beside it,
then exercises two things. Against the program: claiming, double claiming, forged proofs and
unfunded epochs. Against both at once: the whole pipeline, from fills in the database through a
published root to tokens in a claimant's wallet, including the check that a claimed balance is
never offered to a second epoch. Both containers are torn down afterwards.

### Wallets

Cookie Chain is an SVM fork, so any Solana wallet signs for it unchanged - only the RPC differs.
Wallets implementing the Solana Wallet Standard (Nightly, Backpack, Solflare, Phantom) are detected
automatically. Launching a token additionally needs `signMessage`.

---

## Architecture

```
src/
  lib/
    config.ts       Chain, program and API constants - every one verified against the live network
    rwa.ts          The 16 xStocks, read from their own mint accounts
    pairs.ts        The pair engine: the ratio, and the relative-return maths
    candles.ts      Candles from executed fills; the RWA series; the ratio series
    cookiescan.ts   Token registry and markets feed
    jupiter.ts      RWA prices and the Solana leg of a cross-chain route
    swap.ts         Both Cookie Chain aggregators, quoted head to head
    crosschain.ts   The three-leg route planner, both directions, with measured per-leg slippage
    crosschain-exec.ts  The executor: signs the legs, and resumes a route from the middle
    journey.ts      A route in progress, written to storage leg by leg so it survives a failure
    rwa-holding.ts  An xStock position in raw units and in shares, which are not the same number
    bridge.ts       Hyperlane warp route, hand-encoded, with two preflight checks
    liquidity.ts    Cookiebox DAMM v2, built against the fork's IDL
    launchpad.ts    MomoSwap client
    expectation.ts  A launchpad transaction checked against what was asked for, before signing
    curve.ts        Bonding-curve pricing, kept free of the network so the browser can quote a fill
    launches.ts     Tokens launched here, and the RWA each creator benchmarked theirs against
    listings.ts     The one pair a creator buys for a token launched elsewhere, priced and proved
    creators.ts     Who made a token, from the launch record or the mint's metadata authority
    swap-fee.ts     Coorwa's fee, appended to the aggregator's transaction or dropped if it will not fit
    onchain.ts      Proving a reported transaction really happened before anything is written down
    cashback.ts     What the rewards page shows: pools, runs, a wallet's payouts and estimated share
    rewards-ledger.ts  Who is owed what in which stock, and what has been paid
    payout-cycle.ts The daily run: bridge, swap on Jupiter, send to holders on Solana
    operator.ts     The operator key, from a Worker secret
    epochs.ts       Holder samples and weights, plus the older epoch accounting for the vault
    holders.ts      Who holds a token right now, read from the chain and filtered to real wallets
    draft-message.ts  The message the vault authority signs to build an epoch
    merkle.ts       The epoch tree: leaves, roots and proofs, matching the program byte for byte
    vault.ts        Cashback vault client, encoded against the wire format rather than an IDL
    tx.ts           Simulate → sign → send → confirm
  app/api/          Server routes: every rate-limited upstream call is proxied and cached here
  components/       UI

programs/
  corwa-vault/    The cashback vault: fund, publish an epoch, claim against its root
    idl.json      What the built program accepts. Committed, and checked against the client in CI

workers/
  holder-sampler/ Cron Worker that asks the app for a holder sample every five minutes

tests/            Unit tests, offline and instant
  integration/    The vault against a real validator, started by npm run program:test
```

### Two preflight checks in the bridge that a simulation cannot catch

1. **Destination collateral.** The warp route *releases* from a fixed collateral account rather than
   minting. `simulateTransaction` runs on the source chain, so an oversized transfer simulates fine,
   locks the user's COOK, and only fails inside the relayer - leaving an undeliverable message. So
   the destination balance is read explicitly before anything is signed.

2. **Recipient token account.** On delivery the warp program creates the recipient's COOK account
   and pays rent from its own `ata_payer` PDA. That PDA is funded once at deploy and never topped
   up; when it runs dry the relayer's own simulation fails, nothing lands on chain, nothing errors,
   and the transfer simply hangs. Coorwa does not depend on it - it creates the account itself first,
   and only then dispatches.

---

## Verified, not assumed

Every address and endpoint in `config.ts` was checked against the live network rather than copied
from documentation:

- The RPC answers `getVersion` as solana-core 4.1.2.
- The bridge PDAs this code derives match the collateral accounts published on-chain
  (`CL2JoQ5j…` and `88q7zoKc…`), and the transfer-remote instruction encodes to exactly 77 bytes.
- The DAMM v2 vault PDAs this code derives match the vaults stored inside real pools.
- Every xStock mint was read from its own account, which is where the Token-2022 extension table
  above comes from.
- The vault client encodes instructions by hand, and `tests/vault-idl.test.ts` compares every one
  of them against the IDL the compiler emitted: dispatch bytes, account order, which accounts sign,
  which are written. A program change the client has not followed fails a test rather than a
  transaction.

---

## Built on

[Cookie Chain](https://www.cookiechain.wtf) ·
[Cookiescan](https://cookiescan.io) ·
[Cookiebox](https://cookiebox.app) ·
[Candy Shop](https://swap.cookiescan.io) ·
[MomoSwap](https://momoswap.fun) ·
[Hyperlane](https://hyperlane.cookiescan.io) ·
[Jupiter](https://jup.ag) ·
[xStocks by Backed](https://xstocks.com)

Reference implementations for several on-chain flows come from
[`cookiechain/cookie-mcp`](https://github.com/cookiechain/cookie-mcp).

---

## Disclaimer

Coorwa never holds your tokens and never signs for you. Fees it collects wait in its operator wallet
until the daily payout sends them to holders. Tokens on Cookie Chain are volatile and can lose all value; tokenised equities carry issuer and
transfer-restriction risk of their own. Nothing here is investment advice.
