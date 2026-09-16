"use client";

import { useState } from "react";

/**
 * Public gateways tried in order for an IPFS logo. ipfs.io, which most token metadata points at,
 * took 28 s to answer 504 when measured on 2026-09-16, so the image stayed blank for that long and
 * then fell back to initials. Filebase answered the same CID in 1.6 s and Pinata in 3 to 7 s.
 */
const IPFS_GATEWAYS = ["https://ipfs.filebase.io/ipfs/", "https://gateway.pinata.cloud/ipfs/"];

/** Every URL worth trying for a logo, best first. A non-IPFS URL is tried as it is. */
function logoSources(logo: string): string[] {
  const match =
    logo.match(/^ipfs:\/\/(?:ipfs\/)?(.+)$/) ?? logo.match(/^https?:\/\/[^/]+\/ipfs\/(.+)$/);
  if (!match) return [logo];
  const path = match[1];
  const sources = IPFS_GATEWAYS.map((g) => g + path);
  if (/^https?:/.test(logo) && !sources.includes(logo)) sources.push(logo);
  return sources;
}

/**
 * Token avatar. Logos come from arbitrary IPFS gateways, so next/image's remote-pattern allowlist
 * is the wrong tool - and any of them can 404, hence the gateway fallbacks and then the initials.
 */
export function TokenMark({
  logo,
  symbol,
  size = 32,
}: {
  logo: string | null;
  symbol: string;
  size?: number;
}) {
  const sources = logo ? logoSources(logo) : [];
  // Keyed by the logo, so a different token starts again from the first gateway.
  const [failed, setFailed] = useState<{ logo: string | null; count: number }>({ logo, count: 0 });
  const attempt = failed.logo === logo ? failed.count : 0;
  const style = { width: size, height: size };

  if (attempt < sources.length) {
    return (
      // Token logos come from arbitrary IPFS gateways, so next/image's remote-pattern allowlist
      // cannot cover them and its optimiser would proxy untrusted hosts.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        key={sources[attempt]}
        src={sources[attempt]}
        alt=""
        style={style}
        onError={() => setFailed({ logo, count: attempt + 1 })}
        className="shrink-0 rounded-full border border-hair object-cover"
      />
    );
  }

  return (
    <span
      style={style}
      className="grid shrink-0 place-items-center rounded-full bg-raised text-[11px] text-muted"
    >
      {symbol.slice(0, 2).toUpperCase()}
    </span>
  );
}
