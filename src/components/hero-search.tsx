"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { RWA_ASSETS } from "@/lib/rwa";
import { SearchGlyph } from "./ui/glyphs";
import { PillSelect } from "./ui/pill-select";

/**
 * The landing page's one control. Everything the terminal can do - sorting, the other fifteen
 * quote assets, the per-pair chart - is reachable from here or from the row you land on, so none of
 * it needs to be on the front page.
 *
 * The quote picker lives *inside* the pill rather than beside it, which is the whole reason the
 * hero holds a single object instead of a row of them.
 */
export function HeroSearch() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [quote, setQuote] = useState("NVDA");

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const params = new URLSearchParams({ quote });
    if (query.trim()) params.set("q", query.trim());
    router.push(`/terminal?${params}`);
  }

  return (
    <form
      onSubmit={submit}
      className="glass-pane glass-lift mx-auto flex w-full max-w-[560px] items-center gap-2 rounded-full py-2 pl-5 pr-2"
      role="search"
    >
      <SearchGlyph />

      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search any Cookie Chain token"
        aria-label="Search Cookie Chain tokens"
        className="min-w-0 flex-1 bg-transparent text-[15px] text-primary outline-none placeholder:text-[color:var(--text-subtle)]"
      />

      <PillSelect
        id="hero-quote"
        label="Quote in"
        value={quote}
        onChange={setQuote}
        options={RWA_ASSETS.map((a) => ({ value: a.ticker, label: a.ticker }))}
      />

      <button type="submit" className="btn btn-primary btn-sm shrink-0">
        Open
      </button>
    </form>
  );
}
