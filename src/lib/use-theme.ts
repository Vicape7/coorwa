import { useSyncExternalStore } from "react";
import { currentTheme, type Theme } from "./theme";

/**
 * The theme as React state, for the few components that paint with real colour values instead of
 * CSS tokens: the WebGL hero and the chart canvas. Everything else follows the tokens and never
 * needs this.
 *
 * It watches the attribute rather than keeping a copy of its own, so the head script, the toggle
 * and React's dev-mode remount (which strips the attribute and puts it back) all report through
 * one place.
 */
function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}

export function useTheme(): Theme {
  // The server always renders light, and hydration runs against that. The real value arrives in
  // the render straight after.
  return useSyncExternalStore(subscribe, currentTheme, () => "light");
}
