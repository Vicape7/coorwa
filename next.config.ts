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
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
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
