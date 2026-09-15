/**
 * The message the vault authority signs to build or rebuild an epoch draft.
 *
 * A draft used to be safe to build by anyone, because it was arithmetic over public fills and came
 * out the same whoever asked. Holder rewards changed that: a draft takes a snapshot of who holds each
 * token at the moment it is built, so whoever chooses that moment can buy just before it and be paid.
 * The moment is therefore the authority's to choose, proved by a signature over this message.
 *
 * Shared by the operator panel, which signs it, and the draft endpoint, which rebuilds it from the
 * same parts and verifies. Line order is part of the contract.
 */
export const DRAFT_SIGNATURE_MAX_AGE_MS = 2 * 60 * 1000;

export function draftMessage(args: { authority: string; ts: number; rebuild: boolean }): string {
  return [
    "Coorwa epoch draft",
    `authority: ${args.authority}`,
    `rebuild: ${args.rebuild ? "yes" : "no"}`,
    `ts: ${args.ts}`,
  ].join("\n");
}
