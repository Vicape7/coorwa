import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /*
   * Nothing gains from announcing the framework, and a version number in a header is a free hint
   * for anyone scanning for known holes.
   */
  poweredByHeader: false,

  /*
   * Coorwa asks people to sign transactions, so the page must not be embeddable: a site that can
   * put Coorwa in an invisible frame can line its own buttons up with Swap and Launch. The rest are
   * the cheap ones that cost nothing and close off the usual tricks. A full content policy is not
   * here yet because the wallet adapters, the theme script and token logos from arbitrary IPFS
   * gateways each need their own allowance, and a policy that blocks a trade is worse than none.
   */
  /*
   * Plain HTTP is answered with a redirect to HTTPS, in the app rather than in the zone's settings.
   * Cloudflare's own "Always Use HTTPS" never sees these requests: coorwa.fun is a Workers custom
   * domain, so the Worker answers before the zone's redirect would happen, and the site served a
   * 200 over HTTP with the setting switched on.
   *
   * The scheme comes from the `cf-visitor` header Cloudflare puts on every request it forwards.
   * Nothing matches without that header, so a local dev server on http://localhost is untouched.
   */
  async redirects() {
    return [
      {
        source: "/:path*",
        has: [
          { type: "header" as const, key: "cf-visitor", value: '.*"scheme":"http".*' },
          { type: "host" as const, value: "(www\\.)?coorwa\\.fun" },
        ],
        destination: "https://coorwa.fun/:path*",
        permanent: true,
      },
    ];
  },

  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          /*
           * Six months, subdomains included. After one visit over HTTPS a browser will not use plain
           * HTTP for this domain again, which is the half of the problem a redirect cannot fix: the
           * first request of a session is the one somebody on the same network could answer.
           *
           * Set here for the same reason as the redirect above. Turning HTTPS off for coorwa.fun
           * after this ships would make the site unreachable until the six months run out.
           */
          {
            key: "Strict-Transport-Security",
            value: "max-age=15552000; includeSubDomains",
          },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
          },
        ],
      },
    ];
  },

  images: {
    /*
     * One host, and only this one. These are the xStock brand logos named in `src/lib/rwa.ts`, a
     * fixed list served from Backed's own metadata host, so the optimiser can resize 400px squares
     * down to the tiles the hero actually draws. Token logos stay on a plain <img> in TokenMark:
     * they come from arbitrary IPFS gateways, and allowlisting those would mean pointing the
     * optimiser at hosts nobody vetted.
     */
    remotePatterns: [
      {
        protocol: "https",
        hostname: "xstocks-metadata.backed.fi",
        pathname: "/logos/tokens/**",
      },
    ],
  },
};

export default nextConfig;
