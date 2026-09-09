"use client";

import { useState } from "react";

/**
 * Token avatar. Logos come from arbitrary IPFS gateways, so next/image's remote-pattern allowlist
 * is the wrong tool - and any of them can 404, hence the initials fallback.
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
  const [broken, setBroken] = useState(false);
  const style = { width: size, height: size };

  if (logo && !broken) {
    return (
      // Token logos come from arbitrary IPFS gateways, so next/image's remote-pattern allowlist
      // cannot cover them and its optimiser would proxy untrusted hosts.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={logo}
        alt=""
        style={style}
        onError={() => setBroken(true)}
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
