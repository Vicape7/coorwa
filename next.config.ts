import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
