/**
 * How a pair is addressed in a url: the token's mint, then the stock it trades against.
 *
 * A leaf of its own because both the page that builds the link and the metadata that a launched
 * mint carries have to spell it the same way, and the metadata runs in the browser where the pair
 * code's chain and database reads have no business being loaded.
 *
 * Always the mint, never the symbol. A symbol is free text, and a new launch calling itself after
 * an existing pair would otherwise take over its link.
 */
export function curveSlug(mint: string, ticker: string): string {
  return `${mint}-${ticker.toLowerCase()}`;
}
