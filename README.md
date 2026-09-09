# Corwa

Trade Cookie Chain in shares.

Corwa prices every token on [Cookie Chain](https://www.cookiechain.wtf) against real equities -
NVDA, TSLA, SPY - so a trader can see the number no COOK-denominated terminal shows: **is this
beating the stock?** When they want actual exposure rather than a unit of account, Corwa routes
them cross-chain into the real xStock on Solana.

Three tools, one fee loop: a **terminal**, a **launchpad**, and an **LP maker**.

---

## The honest part

**There is no TOKEN/NVDA pool anywhere, and Corwa does not pretend there is.**

NVDAx, TSLAx and the rest are Backed Finance xStocks that live only on Solana, and Cookie Chain's
Hyperlane bridge carries COOK alone. So a Corwa pair is a *denomination*, built by dividing two
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

So Corwa never escrows an xStock. It routes the user into one, and the share lands in their own
Solana wallet where all of that is the issuer's problem and Jupiter's job.

---

## What it does

### Terminal
- Every Cookie Chain token with real pool depth, crossed with 16 xStocks.
- **Candles built from executed fills**, not standing pool quotes - and the pair chart is the ratio
  of two real series, so it shows genuine relative performance against the stock.
- A pair that has not traded in 24h shows `—`, never a phantom return from a flat price against a
  moving stock.
- Both Cookie Chain routers (Cookiebox and Candy Shop) quoted on every trade; the better fill wins.
- **Cross-chain settle**: `TOKEN → COOK → [Hyperlane] → COOK (Solana) → xStock`, three signatures,
  with per-leg progress and measured slippage.

### Launchpad
- Launch on a COOK bonding curve through [MomoSwap](https://momoswap.fun): sign a login message,
  Corwa builds, your wallet signs.
- The real fee split is read from the launchpad config at load time, not hardcoded.

### LP maker
- Every pool on the chain, with depth also expressed in shares.
- **Cookiebox DAMM v2 positions managed natively** - deposit, claim fees, withdraw - with
  instructions built against the fork's own program and IDL.
- Positions are found by scanning the Token-2022 NFTs you hold, so Corwa keeps no records of its
  own.

### Cashback
- Corwa names itself referrer on launchpad buys, earning 20% of the 1% curve fee. That share is
  paid out of the same fee either way - with nobody named, MomoSwap keeps it - so it costs a trader
  nothing.
- Split 50 / 30 / 20 between trader, creator and liquidity.
- **Swaps currently earn Corwa nothing**: neither Cookie Chain router exposes a platform-fee or
  referral parameter, so those fills are recorded at zero rather than credited with a rebate that
  no fee is backing.

---

## Non-custodial by construction

Corwa never holds a key, never co-signs, and never takes custody. Every transaction is built either
by an upstream service or by Corwa's own instruction builders, then **simulated**, then signed by
the user's wallet in their browser, then sent from there.

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
npm run build
```

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
    crosschain.ts   The three-leg route planner, with measured per-leg slippage
    bridge.ts       Hyperlane warp route, hand-encoded, with two preflight checks
    liquidity.ts    Cookiebox DAMM v2, built against the fork's IDL
    launchpad.ts    MomoSwap client
    cashback.ts     Fee accrual and the split
    tx.ts           Simulate → sign → send → confirm
  app/api/          Server routes: every rate-limited upstream call is proxied and cached here
  components/       UI
```

### Two preflight checks in the bridge that a simulation cannot catch

1. **Destination collateral.** The warp route *releases* from a fixed collateral account rather than
   minting. `simulateTransaction` runs on the source chain, so an oversized transfer simulates fine,
   locks the user's COOK, and only fails inside the relayer - leaving an undeliverable message. So
   the destination balance is read explicitly before anything is signed.

2. **Recipient token account.** On delivery the warp program creates the recipient's COOK account
   and pays rent from its own `ata_payer` PDA. That PDA is funded once at deploy and never topped
   up; when it runs dry the relayer's own simulation fails, nothing lands on chain, nothing errors,
   and the transfer simply hangs. Corwa does not depend on it - it creates the account itself first,
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

Corwa is a non-custodial interface. It never holds your assets and never signs for you. Tokens on
Cookie Chain are volatile and can lose all value; tokenised equities carry issuer and
transfer-restriction risk of their own. Nothing here is investment advice.
