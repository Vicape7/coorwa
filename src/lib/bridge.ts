/**
 * The Hyperlane COOK warp route, Cookie Chain <-> Solana mainnet.
 *
 * This is leg 2 of a Corwa cross-chain trade. The Cookie side is a `native` warp (it locks native
 * COOK in a PDA); the Solana side is a `collateral` warp (it locks SPL COOK in an escrow token
 * account). Neither side mints - a transfer is RELEASED from the destination's collateral - which
 * drives the two preflight checks below.
 *
 * Instruction data has a fixed layout, so it is hand-encoded rather than pulling in a borsh dep:
 *   [8-byte discriminator][u8 instruction = 1][u32 dest domain LE][32-byte recipient][u256 amount LE]
 *
 * Two failure modes are invisible to a normal simulation, and both are checked before signing:
 *
 *  1. Destination collateral. simulateTransaction runs on the SOURCE chain, so a transfer larger
 *     than the far side can release still simulates fine, still locks the user's funds, and only
 *     fails inside the relayer - leaving an undeliverable message. So the destination balance is
 *     read explicitly first.
 *
 *  2. Recipient token account (cookie -> solana). Delivery credits the recipient's COOK ATA, and
 *     if it does not exist the warp program creates it from its own `ata_payer` PDA. That PDA is
 *     funded once at deploy time and never topped up, so when it runs dry the relayer's own
 *     simulation fails, nothing lands on chain, nothing errors, and the transfer simply hangs.
 *     Corwa does not depend on it: if the recipient has no COOK account, we create it ourselves on
 *     Solana first, and only dispatch on Cookie Chain once that has confirmed.
 */
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  type AccountMeta,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  BRIDGE,
  COOKIE_DOMAIN,
  SOLANA_DOMAIN,
  SPL_NOOP_PROGRAM_ID,
} from "./config";
import { rawToUi } from "./format";
import { CorwaError } from "./http";

export type BridgeDirection = "cookie-to-solana" | "solana-to-cookie";

const DISCRIMINATOR = Buffer.from([1, 1, 1, 1, 1, 1, 1, 1]);
const TRANSFER_REMOTE_INSTRUCTION = 1;
const SEP = "-";

// --- Instruction encoding -----------------------------------------------------------------------

export function encodeTransferRemoteIxData(
  destinationDomain: number,
  recipient32: Uint8Array,
  amount: bigint,
): Buffer {
  if (recipient32.length !== 32) {
    throw new CorwaError(`recipient must be 32 bytes, got ${recipient32.length}`);
  }
  const buf = Buffer.alloc(8 + 1 + 4 + 32 + 32);
  DISCRIMINATOR.copy(buf, 0);
  buf.writeUInt8(TRANSFER_REMOTE_INSTRUCTION, 8);
  buf.writeUInt32LE(destinationDomain, 9);
  Buffer.from(recipient32).copy(buf, 13);
  let a = amount;
  for (let i = 0; i < 32; i++) {
    buf[45 + i] = Number(a & 0xffn);
    a >>= 8n;
  }
  if (a !== 0n) throw new CorwaError("amount exceeds u256");
  return buf;
}

// --- PDA derivation (seeds joined by a literal '-', per the Hyperlane sealevel programs) ---------

function pda(seeds: Array<string | Buffer>, programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    seeds.map((s) => (typeof s === "string" ? Buffer.from(s) : s)),
    programId,
  )[0];
}

const deriveMailboxOutbox = (mailbox: PublicKey) => pda(["hyperlane", SEP, "outbox"], mailbox);
const deriveDispatchAuthority = (warp: PublicKey) =>
  pda(["hyperlane_dispatcher", SEP, "dispatch_authority"], warp);
const deriveDispatchedMessage = (mailbox: PublicKey, uniqueMsg: PublicKey) =>
  pda(["hyperlane", SEP, "dispatched_message", SEP, uniqueMsg.toBuffer()], mailbox);
const deriveTokenPda = (warp: PublicKey) =>
  pda(["hyperlane_message_recipient", SEP, "handle", SEP, "account_metas"], warp);
export const deriveNativeCollateralPda = (warp: PublicKey) =>
  pda(["hyperlane_token", SEP, "native_collateral"], warp);
export const deriveEscrowPda = (warp: PublicKey) => pda(["hyperlane_token", SEP, "escrow"], warp);
const deriveIgpProgramData = (igp: PublicKey) => pda(["hyperlane_igp", SEP, "program_data"], igp);
const deriveGasPayment = (igp: PublicKey, uniqueMsg: PublicKey) =>
  pda(["hyperlane_igp", SEP, "gas_payment", SEP, uniqueMsg.toBuffer()], igp);

/**
 * Read the inner IGP pubkey out of an OverheadIgpAccount.
 * Layout: initialized u8 · discriminator[8] · bump u8 · salt H256[32] · owner Option<Pubkey> ·
 *         inner Pubkey[32] <- wanted · gas_overheads HashMap
 */
async function readOverheadIgpInner(conn: Connection, account: PublicKey): Promise<PublicKey> {
  const info = await conn.getAccountInfo(account, "confirmed");
  if (!info) {
    throw new CorwaError(
      `Hyperlane OverheadIgp account not found: ${account.toBase58()}`,
      "the bridge IGP address looks wrong for this network",
    );
  }
  let off = 42; // initialized(1) + discriminator(8) + bump(1) + salt(32)
  const ownerTag = info.data.readUInt8(off);
  off += 1;
  if (ownerTag === 1) off += 32;
  const inner = info.data.subarray(off, off + 32);
  if (inner.length !== 32) {
    throw new CorwaError(`could not read inner IGP pubkey from ${account.toBase58()}`);
  }
  return new PublicKey(inner);
}

// --- Route wiring -------------------------------------------------------------------------------

interface Route {
  type: "native" | "collateral";
  sourceConn: Connection;
  destConn: Connection;
  sourceDecimals: number;
  destDecimals: number;
  destinationDomain: number;
  warp: PublicKey;
  mailbox: PublicKey;
  igpProgramId: PublicKey;
  overheadIgp: PublicKey;
  splMint?: PublicKey;
  destCollateral: PublicKey;
  destCollateralKind: "native" | "tokenAccount";
  destSplMint?: PublicKey;
  destChainLabel: string;
}

export function resolveRoute(
  direction: BridgeDirection,
  cookieConn: Connection,
  solanaConn: Connection,
): Route {
  if (direction === "cookie-to-solana") {
    return {
      type: "native",
      sourceConn: cookieConn,
      destConn: solanaConn,
      sourceDecimals: BRIDGE.cookie.decimals,
      destDecimals: BRIDGE.solana.decimals,
      destinationDomain: SOLANA_DOMAIN,
      warp: new PublicKey(BRIDGE.cookie.warpProgramId),
      mailbox: new PublicKey(BRIDGE.cookie.mailbox),
      igpProgramId: new PublicKey(BRIDGE.cookie.igpProgramId),
      overheadIgp: new PublicKey(BRIDGE.cookie.overheadIgp),
      destCollateral: deriveEscrowPda(new PublicKey(BRIDGE.solana.warpProgramId)),
      destCollateralKind: "tokenAccount",
      destSplMint: new PublicKey(BRIDGE.solana.splMint),
      destChainLabel: "Solana",
    };
  }
  return {
    type: "collateral",
    sourceConn: solanaConn,
    destConn: cookieConn,
    sourceDecimals: BRIDGE.solana.decimals,
    destDecimals: BRIDGE.cookie.decimals,
    destinationDomain: COOKIE_DOMAIN,
    warp: new PublicKey(BRIDGE.solana.warpProgramId),
    mailbox: new PublicKey(BRIDGE.solana.mailbox),
    igpProgramId: new PublicKey(BRIDGE.solana.igpProgramId),
    overheadIgp: new PublicKey(BRIDGE.solana.overheadIgp),
    splMint: new PublicKey(BRIDGE.solana.splMint),
    destCollateral: deriveNativeCollateralPda(new PublicKey(BRIDGE.cookie.warpProgramId)),
    destCollateralKind: "native",
    destChainLabel: "Cookie Chain",
  };
}

// --- Preflight ------------------------------------------------------------------------------------

/**
 * Rescale a raw amount between the two sides' decimals (Cookie 9, Solana 6).
 * Scaling down truncates, which can only understate the requirement by sub-dust - never overstate
 * it into a false failure.
 */
export function scaleRaw(raw: bigint, fromDecimals: number, toDecimals: number): bigint {
  if (toDecimals === fromDecimals) return raw;
  const factor = 10n ** BigInt(Math.abs(toDecimals - fromDecimals));
  return toDecimals > fromDecimals ? raw * factor : raw / factor;
}

/** Releasable collateral on the destination, in its raw units. Null means "could not determine". */
async function readDestinationCollateral(route: Route): Promise<bigint | null> {
  try {
    if (route.destCollateralKind === "tokenAccount") {
      const bal = await route.destConn.getTokenAccountBalance(route.destCollateral, "confirmed");
      return BigInt(bal.value.amount);
    }
    const info = await route.destConn.getAccountInfo(route.destCollateral, "confirmed");
    if (!info) return null;
    // The PDA carries account data, so its rent-exempt reserve is not releasable.
    const rent = await route.destConn.getMinimumBalanceForRentExemption(info.data.length);
    const free = BigInt(info.lamports) - BigInt(rent);
    return free > 0n ? free : 0n;
  } catch {
    return null;
  }
}

export interface BridgePreflight {
  /** Destination collateral as a UI amount, or null when it could not be read. */
  availableCollateral: number | null;
  /** True when the recipient needs a COOK token account created on Solana first. */
  needsRecipientAta: boolean;
  recipientAta: string | null;
}

export async function preflightBridge(
  route: Route,
  amountRaw: bigint,
  recipient: PublicKey,
): Promise<BridgePreflight> {
  const available = await readDestinationCollateral(route);
  const needed = scaleRaw(amountRaw, route.sourceDecimals, route.destDecimals);

  if (available !== null && available < needed) {
    throw new CorwaError(
      `the warp route can only release ${rawToUi(available, route.destDecimals)} COOK on ` +
        `${route.destChainLabel}, but this transfer needs ${rawToUi(needed, route.destDecimals)}`,
      "Nothing has been signed. The route releases from a fixed collateral account, so a larger " +
        "transfer would lock your COOK on this side with a message that can never be delivered. " +
        "Bridge a smaller amount, or wait for the route to be topped up.",
    );
  }

  let needsRecipientAta = false;
  let recipientAta: string | null = null;

  if (route.type === "native" && route.destSplMint) {
    const mintInfo = await route.destConn.getAccountInfo(route.destSplMint, "confirmed");
    const tokenProgram = mintInfo?.owner;
    if (tokenProgram) {
      const ata = getAssociatedTokenAddressSync(route.destSplMint, recipient, true, tokenProgram);
      recipientAta = ata.toBase58();
      const info = await route.destConn.getAccountInfo(ata, "confirmed");
      needsRecipientAta = info === null;
    }
  }

  return {
    availableCollateral: available === null ? null : rawToUi(available, route.destDecimals),
    needsRecipientAta,
    recipientAta,
  };
}

// --- Instruction building ---------------------------------------------------------------------------

async function buildTransferRemoteIx(
  route: Route,
  sender: PublicKey,
  uniqueMsg: PublicKey,
  recipient32: Uint8Array,
  amountRaw: bigint,
): Promise<TransactionInstruction> {
  const { warp, mailbox, igpProgramId, overheadIgp, sourceConn } = route;
  const innerIgp = await readOverheadIgpInner(sourceConn, overheadIgp);

  const baseKeys: AccountMeta[] = [
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: new PublicKey(SPL_NOOP_PROGRAM_ID), isSigner: false, isWritable: false },
    { pubkey: deriveTokenPda(warp), isSigner: false, isWritable: false },
    { pubkey: mailbox, isSigner: false, isWritable: false },
    { pubkey: deriveMailboxOutbox(mailbox), isSigner: false, isWritable: true },
    { pubkey: deriveDispatchAuthority(warp), isSigner: false, isWritable: false },
    { pubkey: sender, isSigner: true, isWritable: false },
    { pubkey: uniqueMsg, isSigner: true, isWritable: false },
    { pubkey: deriveDispatchedMessage(mailbox, uniqueMsg), isSigner: false, isWritable: true },
    { pubkey: igpProgramId, isSigner: false, isWritable: false },
    { pubkey: deriveIgpProgramData(igpProgramId), isSigner: false, isWritable: true },
    { pubkey: deriveGasPayment(igpProgramId, uniqueMsg), isSigner: false, isWritable: true },
    { pubkey: overheadIgp, isSigner: false, isWritable: false },
    { pubkey: innerIgp, isSigner: false, isWritable: true },
  ];

  let extraKeys: AccountMeta[];
  if (route.type === "native") {
    extraKeys = [
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: deriveNativeCollateralPda(warp), isSigner: false, isWritable: true },
    ];
  } else {
    const mint = route.splMint!;
    // Read the token program off the mint owner - Solana COOK is Token-2022, so hardcoding the
    // classic program id would make the warp reject the transaction.
    const mintInfo = await sourceConn.getAccountInfo(mint, "confirmed");
    if (!mintInfo) throw new CorwaError(`SPL COOK mint not found: ${mint.toBase58()}`);
    const tokenProgram = mintInfo.owner;
    extraKeys = [
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: true },
      {
        pubkey: getAssociatedTokenAddressSync(mint, sender, true, tokenProgram),
        isSigner: false,
        isWritable: true,
      },
      { pubkey: deriveEscrowPda(warp), isSigner: false, isWritable: true },
    ];
  }

  return new TransactionInstruction({
    keys: [...baseKeys, ...extraKeys],
    programId: warp,
    data: encodeTransferRemoteIxData(route.destinationDomain, recipient32, amountRaw),
  });
}

export interface BuiltBridgeTx {
  transaction: Transaction;
  /** Ephemeral per-message signer (Hyperlane replay protection). Must partial-sign before the wallet. */
  uniqueMessage: Keypair;
  preflight: BridgePreflight;
  /** Set when the caller must first create the recipient's COOK account on Solana. */
  recipientAtaIx: TransactionInstruction | null;
}

/**
 * Build a transfer-remote transaction, already partial-signed by the ephemeral message signer.
 * The caller adds the wallet signature, simulates, and sends on the SOURCE chain.
 */
export async function buildBridgeTransfer(args: {
  direction: BridgeDirection;
  cookieConn: Connection;
  solanaConn: Connection;
  sender: PublicKey;
  recipient: PublicKey;
  amountRaw: bigint;
}): Promise<BuiltBridgeTx> {
  const route = resolveRoute(args.direction, args.cookieConn, args.solanaConn);
  const preflight = await preflightBridge(route, args.amountRaw, args.recipient);

  const uniqueMessage = Keypair.generate();
  const ix = await buildTransferRemoteIx(
    route,
    args.sender,
    uniqueMessage.publicKey,
    args.recipient.toBytes(),
    args.amountRaw,
  );

  const tx = new Transaction().add(ix);
  const { blockhash } = await route.sourceConn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = args.sender;
  tx.partialSign(uniqueMessage);

  // When the recipient has no COOK account on Solana, hand the caller the instruction to create it
  // rather than trusting the route's ata_payer PDA to still be funded.
  let recipientAtaIx: TransactionInstruction | null = null;
  if (preflight.needsRecipientAta && route.destSplMint) {
    const mintInfo = await route.destConn.getAccountInfo(route.destSplMint, "confirmed");
    if (mintInfo) {
      recipientAtaIx = createAssociatedTokenAccountIdempotentInstruction(
        args.sender,
        new PublicKey(preflight.recipientAta!),
        args.recipient,
        route.destSplMint,
        mintInfo.owner,
      );
    }
  }

  return { transaction: tx, uniqueMessage, preflight, recipientAtaIx };
}

/** Pull the Hyperlane message id out of the dispatch logs, so delivery can be tracked. */
export function messageIdFromLogs(logs: string[] | null | undefined): string | null {
  if (!logs?.length) return null;
  for (const line of logs) {
    const m = line.match(/ID (0x[a-fA-F0-9]{64})/i);
    if (m) return m[1].toLowerCase();
  }
  for (const line of logs) {
    const m = line.match(/(0x[a-fA-F0-9]{64})/);
    if (m) return m[1].toLowerCase();
  }
  return null;
}
