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
- **A list of pairs somebody chose, not a cross product.** Every token with real pool depth carries
  one benchmark for free. A token launched through Coorwa carries the one its creator picked at
  launch and nothing else. Any other pair has to be bought, a dollar a time, on the pools page.
  Crossing 23 tokens with 16 assets produced 368 rows of arithmetic; this produces a market list.
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
- **A token's creator can add benchmarks to it, for a dollar a pair.** Only the creator: they earn
  the creator share of every fee the pair goes on to generate, so letting a stranger pick it would
  be handing away somebody else's position. Proved against the launch for tokens Coorwa made, and
  against the mint's metadata authority otherwise - which is worth nothing across the registry at
  large, where 4,449 of 5,088 tokens share one launchpad key, and works for every token that
  actually has liquidity here, where each resolves to its own wallet. That shared key is refused by
  name.
- The fee is paid in COOK by calling `fund` on the cashback vault, which the program lets anyone
  call, so it lands in the account the rebate is paid out of and Coorwa never holds it. Nothing is
  credited on the client's word: the payment is read back from the chain, and the amount that
  actually reached the vault decides how many pairs it bought. One transaction buys one batch.
- What backs a pair is still the token's real COOK pool. A TOKEN/xStock pool cannot exist on Cookie
  Chain, for the reasons in the table above, and the benchmark is what the price is quoted and
  charted in rather than what it trades against.
- **Cookiebox DAMM v2 positions managed natively** - deposit, claim fees, withdraw - with
  instructions built against the fork's own program and IDL.
- Positions are found by scanning the Token-2022 NFTs you hold, so Coorwa keeps no records of its
  own.

### Cashback
- Coorwa names itself referrer on launchpad buys, earning 20% of the 1% curve fee. That share is
  paid out of the same fee either way - with nobody named, MomoSwap keeps it - so it costs a trader
  nothing.
- Split 50 / 30 / 20 between trader, creator and liquidity.
- **Nothing is credited on the client's word.** A reported fill is re-read on chain before it is
  written: the transaction has to exist, to have succeeded, and to have been signed by the wallet
  being credited. For a launchpad fill the size of the trade is capped by the COOK that actually
  moved, and the referral fee is credited only when Coorwa's referrer address is named on the
  transaction itself. No referrer on chain, no revenue, so nothing to rebate.
- **Terminal swaps carry Coorwa's own 0.10% fee**, because neither Cookie Chain router will pay a
  referrer. Six plausible parameter names were tried on both aggregators and every quote came back
  identical, so there is nothing to collect unless Coorwa asks. It asks in the open: two extra
  instructions on the aggregator's own transaction, shown on the panel before anything is signed,
  paying the cashback vault rather than Coorwa. **All of it is returned** - 62.5% to the trader,
  37.5% to the token's creator - because a fee out of the trader's own pocket that Coorwa kept any
  of would be a toll, not a rebate. A route too long to carry the two instructions inside the
  1,232-byte limit goes through unpriced rather than being refused.
- Payouts go through Coorwa's own program on Cookie Chain rather than a payout wallet. Who is owed
  what is worked out off chain, because it depends on prices and on which wallet generated which
  fill. Custody is not, because "trust our payout wallet" is the part a user cannot check.
- Balances accrue in USD and are converted to COOK once, at the rate recorded on the epoch that
  pays them. A debt carried in tokens would quietly change value between the trade and the payout.

---

## Non-custodial by construction

Coorwa never holds a key, never co-signs, and never takes custody. Every transaction is built either
by an upstream service or by Coorwa's own instruction builders, then **simulated**, then signed by
the user's wallet in their browser, then sent from there.

### The cashback vault

Cashback is the one place Coorwa touches money at all, so it is the one place that needed a program
rather than a promise. `programs/corwa-vault` is an epoch merkle distributor: Coorwa funds it,
publishes a root naming who is owed what, and each claimant proves their own line and takes it.

What holds it up is what the program cannot do:

- **There is no instruction that pays the authority.** Tokens enter through `fund` and leave
  through `claim`, and nothing else. The authority is the right to publish, never the right to
  spend, and `set_authority` hands on only that.
- **A published epoch is already funded.** `publish_epoch` reserves its total against the balance
  the vault holds free of earlier epochs and refuses if it cannot. So by the time a claimant sees a
  root, the tokens behind it are already committed and cannot be published twice.
- **A claim is bound to the claimant, the amount and the epoch.** The leaf is
  `sha256(0x00 || epoch || claimant || amount)`, so a proof cannot be replayed for another wallet,
  another figure, or another epoch. A claim record PDA makes a second attempt fail before anything
  runs.
- **`close_epoch` is permissionless.** It moves no tokens; it only returns an expired epoch's
  remainder to the vault for the next one. Requiring the authority would let a lost key strand
  every unclaimed reserve forever.

The honest cost of that shape: there is no withdrawal path at all, so tokens sent in by mistake can
only be routed back out by publishing an epoch that names the sender. And a program this young is
unaudited, which is stated here rather than buried.

The claim pays wrapped COOK. Turning that into an xStock is the cross-chain route above, run by the
user, signed by the user.

### How an epoch is run

The vault holds the money and knows nothing about who is owed it. Coorwa knows exactly who is owed
what and holds none of the money. The two halves meet at a merkle root and nowhere else.

1. **Build.** `POST /api/cashback/draft` sums every confirmed fill up to a cutoff, applies the
   split, subtracts anything already committed to an earlier epoch, drops balances under the claim
   floor, converts USD to COOK at a single rate recorded on the epoch, and freezes the result as a
   draft. It is deterministic on the cutoff, so rebuilding lands on the same root.
2. **Publish.** The authority signs `publish_epoch` in their own browser. Coorwa then reads that
   transaction back off the chain, decodes the instruction out of it, and marks the epoch published
   only if the root it carries matches the draft byte for byte. No key ever reaches the server, and
   Coorwa cannot talk an epoch into existing.
3. **Claim.** The rewards page hands a wallet the proof for its own line. One transaction, signed
   by the claimant, and the program pays them. The proof is not a secret: it opens the leaf naming
   that wallet and no other.
4. **Close.** After 30 days the window shuts and anyone may call `close_epoch`, returning the
   unclaimed remainder to the vault.

The rule that stops a double payout is that a balance counts as committed while it sits in a
published epoch which is either claimed or still inside its window. Only an expired, closed epoch
returns its balance to what can be published next, so an unclaimed line rolls into a later epoch
instead of being forfeited.

Two things are worth knowing before running this for the first time:

- **`initialize` is open to anyone**, and whoever calls it first for a mint is that vault's
  authority permanently. Deploy and initialize in the same sitting. The operator panel on the
  rewards page is shown to the wallet named by `NEXT_PUBLIC_VAULT_AUTHORITY` until a vault exists,
  and to the on-chain authority afterwards. Everyone else sees nothing.
- **Funding is one way.** Tokens leave only through an epoch that names their recipient, so an
  overfunded vault is corrected by publishing a root that pays it back, not by withdrawing.

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
    curve.ts        Bonding-curve pricing, kept free of the network so the browser can quote a fill
    launches.ts     Tokens launched here, and the RWA each creator benchmarked theirs against
    listings.ts     Benchmarks bought for tokens launched elsewhere, priced and proved
    creators.ts     Who made a token, from the launch record or the mint's metadata authority
    swap-fee.ts     Coorwa's fee, appended to the aggregator's transaction or dropped if it will not fit
    onchain.ts      Proving a reported transaction really happened before anything is written down
    cashback.ts     Fee accrual and the split
    epochs.ts       Epoch accounting: who is owed what, and what has already been committed
    merkle.ts       The epoch tree: leaves, roots and proofs, matching the program byte for byte
    vault.ts        Cashback vault client, encoded against the wire format rather than an IDL
    tx.ts           Simulate → sign → send → confirm
  app/api/          Server routes: every rate-limited upstream call is proxied and cached here
  components/       UI

programs/
  corwa-vault/    The cashback vault: fund, publish an epoch, claim against its root
    idl.json      What the built program accepts. Committed, and checked against the client in CI

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

Coorwa is a non-custodial interface. It never holds your assets and never signs for you. Tokens on
Cookie Chain are volatile and can lose all value; tokenised equities carry issuer and
transfer-restriction risk of their own. Nothing here is investment advice.
