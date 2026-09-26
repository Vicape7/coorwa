import { notFound } from "next/navigation";
import { findPair } from "@/lib/pairs";
import { findCurvePair } from "@/lib/curve-pairs";
import { PairView } from "@/components/pair-view";
import { CurvePairView } from "@/components/curve-pair-view";
import { findCoorwaPair } from "@/lib/coorwa-pairs";
import { CoorwaPairView } from "@/components/coorwa-pair-view";

export const dynamic = "force-dynamic";

/** A pair with a pool first; a token still on its launchpad curve has no pool pair yet. */
async function resolve(slug: string) {
  const pair = await findPair(slug).catch(() => null);
  if (pair) return { pair, curve: null, coorwa: null };
  const coorwa = await findCoorwaPair(slug).catch(() => null);
  if (coorwa) return { pair: null, curve: null, coorwa };
  const curve = await findCurvePair(slug).catch(() => null);
  return curve ? { pair: null, curve, coorwa: null } : null;
}

export async function generateMetadata({ params }: PageProps<"/terminal/[slug]">) {
  const { slug } = await params;
  const found = await resolve(slug);
  const p = found?.pair ?? found?.curve ?? found?.coorwa;
  if (!p) return { title: "Pair not found · Coorwa" };
  return {
    title: `${p.base.symbol}/${p.quote.ticker} · Coorwa`,
    description: `${p.base.name} priced in ${p.quote.name} shares, on Cookie Chain.`,
  };
}

export default async function PairPage({ params }: PageProps<"/terminal/[slug]">) {
  const { slug } = await params;
  const found = await resolve(slug);
  if (!found) notFound();
  if (found.pair) return <PairView initial={found.pair} />;
  if (found.coorwa) return <CoorwaPairView initial={found.coorwa} />;
  return <CurvePairView initial={found.curve!} />;
}
