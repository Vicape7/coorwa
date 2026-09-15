"use client";

/**
 * The LP page, rendered in the browser only.
 *
 * `pools-view` builds positions through Anchor, and Anchor's bundle throws `exports is not defined`
 * when Next evaluates it during server rendering, which turned every request for /pools into a 500.
 * Nothing on that page means anything before the wallet and the chain have answered, so it skips
 * the server render instead.
 */
import dynamic from "next/dynamic";

export const PoolsViewClient = dynamic(() => import("./pools-view").then((m) => m.PoolsView), {
  ssr: false,
  loading: () => (
    <div className="mx-auto w-full max-w-[1160px] px-5 py-10 sm:py-14">
      <div className="skeleton h-40 w-full max-w-2xl" />
    </div>
  ),
});
