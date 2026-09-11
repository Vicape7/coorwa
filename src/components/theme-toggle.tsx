"use client";

import { useLayoutEffect } from "react";
import { applyTheme, currentTheme, saveTheme, storedTheme } from "@/lib/theme";
import { useTheme } from "@/lib/use-theme";
import { MoonGlyph, SunGlyph } from "./ui/glyphs";

/**
 * The light and dark switch, left of Connect, where Pons puts theirs.
 *
 * Which icon shows is decided by CSS off the `data-theme` attribute, not by React state. The head
 * script may already have set dark before hydration, and an icon picked in render would show the
 * moon for a frame and then swap. Only `aria-pressed` and the tooltip come from state, and a stale
 * value there for one frame is invisible.
 */
export function ThemeToggle() {
  const theme = useTheme();

  // React's dev-mode remount resets <html> to the attributes it renders, which drops the one the
  // head script set. Put it back before paint. In production this finds it already there.
  useLayoutEffect(() => {
    applyTheme(storedTheme());
  }, []);

  return (
    <button
      type="button"
      onClick={() => saveTheme(currentTheme() === "dark" ? "light" : "dark")}
      aria-label="Dark theme"
      aria-pressed={theme === "dark"}
      title={theme === "dark" ? "Switch to light" : "Switch to dark"}
      className="nav-round"
    >
      <MoonGlyph className="theme-moon" />
      <SunGlyph className="theme-sun" />
    </button>
  );
}
