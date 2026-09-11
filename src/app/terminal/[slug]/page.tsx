import { notFound } from "next/navigation";
import { findPair } from "@/lib/pairs";
import { PairView } from "@/components/pair-view";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: PageProps<"/terminal/[slug]">) {
  const { slug } = await params;
  const pair = await findPair(slug).catch(() => null);
  if (!pair) return { title: "Pair not found · Coorwa" };
  return {
    title: `${pair.base.symbol}/${pair.quote.ticker} · Coorwa`,
    description: `${pair.base.name} priced in ${pair.quote.name} shares, on Cookie Chain.`,
  };
}

export default async function PairPage({ params }: PageProps<"/terminal/[slug]">) {
  const { slug } = await params;
  const pair = await findPair(slug).catch(() => null);
  if (!pair) notFound();
  return <PairView initial={pair} />;
}
