import { PairList } from "@/components/pair-list";

export const metadata = {
  title: "Terminal · Coorwa",
  description: "Every Cookie Chain token priced in real-world shares.",
};

/**
 * The landing page's search submits here, so the query and the quote asset arrive in the URL. Read
 * on the server and handed down as initial state - `useSearchParams` in the list itself would drag
 * the whole page into client rendering for two strings.
 */
export default async function TerminalPage({ searchParams }: PageProps<"/terminal">) {
  const params = await searchParams;

  return <PairList initialQuery={first(params.q)} initialQuote={first(params.quote)} />;
}

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}
