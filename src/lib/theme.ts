/**
 * Light or dark, chosen by the reader and remembered in localStorage.
 *
 * The theme is one attribute on <html>, `data-theme="dark"`, and globals.css redefines the design
 * tokens under it. Light is the default and carries no attribute at all, so a first visit, a
 * blocked localStorage and a crawler all see the page the way it was designed.
 *
 * No React in this file on purpose. The root layout is a server component and needs THEME_SCRIPT,
 * and a module that imports a client hook cannot be imported there. The hook is in use-theme.ts.
 */

export type Theme = "light" | "dark";

export const THEME_KEY = "coorwa-theme";

/**
 * Runs in <head> while the HTML is still being parsed, so a stored dark theme is on the page before
 * its first paint. Anything later, even a layout effect, flashes the light page first on a slow
 * connection.
 */
export const THEME_SCRIPT = `(function(){try{if(localStorage.getItem("${THEME_KEY}")==="dark")document.documentElement.setAttribute("data-theme","dark")}catch(e){}})()`;

export function currentTheme(): Theme {
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

export function storedTheme(): Theme {
  try {
    return localStorage.getItem(THEME_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === "dark") root.setAttribute("data-theme", "dark");
  else root.removeAttribute("data-theme");
}

export function saveTheme(theme: Theme) {
  applyTheme(theme);
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Private mode or storage switched off. The switch still works for this page view.
  }
}
