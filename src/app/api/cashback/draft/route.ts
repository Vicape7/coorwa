import { createPublicKey, verify } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import bs58 from "bs58";
import { PublicKey } from "@solana/web3.js";
import { EpochError, buildDraft, checkTree, cookieConnection, toCook } from "@/lib/epochs";
import { fetchVault } from "@/lib/vault";
import { VAULT_MINT } from "@/lib/config";
import { DRAFT_SIGNATURE_MAX_AGE_MS, draftMessage } from "@/lib/draft-message";

export const dynamic = "force-dynamic";

const Body = z.object({
  /**
   * Replace a draft that is already waiting. Off by default, because a draft the authority has
   * already signed against would be orphaned by a rebuild, and the publish would then be refused.
   */
  rebuild: z.boolean().default(false),
  /** The vault authority, the time it signed, and its signature over `draftMessage`. */
  authority: z.string().min(32).max(44),
  ts: z.number().int(),
  signature: z.string().min(64).max(100),
});

/** A raw ed25519 key wrapped as DER, which is the only shape node's verifier accepts. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** Signatures already spent, so one cannot be replayed to take a second snapshot inside its window. */
const spent = new Set<string>();

function signedBy(wallet: string, message: string, signature: string): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(bs58.decode(wallet))]),
      format: "der",
      type: "spki",
    });
    return verify(null, Buffer.from(message, "utf8"), key, Buffer.from(bs58.decode(signature)));
  } catch {
    return false;
  }
}

/** How many lines to show back. The tree can hold millions; a person reviewing it cannot. */
const PREVIEW = 25;

/**
 * Work out the next epoch and freeze it as a draft. Only the vault's authority may ask.
 *
 * A draft moves no money, but it does take the holder snapshot, and whoever picks that moment can
 * buy a token just before it and be paid for holding. So the caller proves it is the authority the
 * chain names, with a signature over a short-lived message, and a signature is spent once used. The
 * publish transaction is still the step that moves money, and the program checks that one itself.
 */
export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const b = parsed.data;
  try {
    const snapshot = await fetchVault(cookieConnection(), new PublicKey(VAULT_MINT));
    const authority = snapshot?.state.authority.toBase58();
    if (!authority || b.authority !== authority) {
      return NextResponse.json(
        { error: "only the vault's authority can build an epoch" },
        { status: 403 },
      );
    }
    if (Math.abs(Date.now() - b.ts) > DRAFT_SIGNATURE_MAX_AGE_MS || spent.has(b.signature)) {
      return NextResponse.json(
        { error: "that signature has expired or was already used, so sign again" },
        { status: 401 },
      );
    }
    if (!signedBy(authority, draftMessage({ authority, ts: b.ts, rebuild: b.rebuild }), b.signature)) {
      return NextResponse.json({ error: "the signature does not match the authority" }, { status: 401 });
    }
    spent.add(b.signature);

    const draft = await buildDraft({ rebuild: b.rebuild });

    // A tree that cannot open its own leaves would only be discovered by the first claimant, on
    // chain, after the money was already reserved. It costs nothing to find out here instead.
    checkTree(BigInt(draft.epoch.index), draft.lines);

    return NextResponse.json({
      epoch: draft.epoch,
      reused: draft.reused,
      holderSamples: draft.holderSamples,
      freeCook: draft.freeCook,
      shortfallCook: draft.shortfallCook,
      lines: draft.lines.slice(0, PREVIEW).map((l) => ({
        wallet: l.wallet,
        amountCook: toCook(l.amountRaw),
        amountUsd: l.amountUsd,
        holderUsd: l.holderUsd,
        creatorUsd: l.creatorUsd,
      })),
      truncated: Math.max(0, draft.lines.length - PREVIEW),
    });
  } catch (e) {
    const status = e instanceof EpochError ? e.status : 502;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "could not build the epoch" },
      { status },
    );
  }
}
