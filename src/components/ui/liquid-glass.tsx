import Link from "next/link";
import clsx from "clsx";

/**
 * Liquid glass, adapted from the 21st.dev component of the same name.
 *
 * Four things changed on the way in, each because the original does not work here:
 *
 *   1. `rounded-inherit` is not a real Tailwind class. In the original, the absolutely positioned
 *      glass layers stayed square and stuck out of every rounded container. Those layers now live
 *      in CSS (`.glass-pane::before` and `::after` in globals.css), where `border-radius: inherit`
 *      does work. That also removes three divs per surface from the markup.
 *   2. The original displaces every pixel by the same amount, using turbulence at `scale="200"`.
 *      That smears rather than refracts. Real glass bends light at its edges and stays clear in the
 *      middle, so the filter below displaces from an edge ramp instead of from noise, and it does
 *      it in `backdrop-filter`, where the thing being bent is the page behind the pane.
 *   3. `font-semibold` and `text-black` contradict the design system, which stops at weight 500 and
 *      contains no pure black.
 *   4. The original animates `padding` on hover, which reflows every sibling. Lift is a transform.
 *
 * There is no `"use client"` here. Nothing holds state, so this renders on the server and ships no
 * JavaScript.
 */

type GlassElement = "div" | "section" | "article" | "header" | "aside";

interface GlassEffectProps {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  /** Internal route or external URL. Renders the surface as a link. */
  href?: string;
  /** Only consulted for external hrefs. */
  target?: string;
  /** Adds the hover lift. Defaults to on whenever the surface is a link. */
  interactive?: boolean;
  /**
   * How far the backdrop bends. `scale` on feDisplacementMap is a plain SVG attribute rather than
   * a CSS property, so this cannot be a custom property - it picks between filters that
   * `GlassFilter` has already declared.
   */
  refract?: "soft" | "deep";
  as?: GlassElement;
}

export function GlassEffect({
  children,
  className,
  style,
  href,
  target,
  interactive,
  refract = "soft",
  as: Tag = "div",
}: GlassEffectProps) {
  const lift = interactive ?? href !== undefined;
  const classes = clsx("glass-pane", lift && "glass-lift", className);

  if (href) {
    const external = /^https?:/.test(href);
    return external ? (
      <a
        href={href}
        target={target ?? "_blank"}
        rel="noreferrer"
        className={classes}
        style={style}
        data-refract={refract}
      >
        {children}
      </a>
    ) : (
      <Link href={href} className={classes} style={style} data-refract={refract}>
        {children}
      </Link>
    );
  }

  return (
    <Tag className={classes} style={style} data-refract={refract}>
      {children}
    </Tag>
  );
}

/**
 * The lenses every glass surface points at. Mount this once, in the root layout. An SVG filter
 * belongs to the whole document, so repeating it per surface only creates duplicate ids.
 *
 * These are used from `backdrop-filter`, not `filter`, and that distinction is the whole effect.
 * `filter` bends what the element paints, which for a glass pane is a flat translucent film -
 * bending a flat colour produces the same flat colour, which is why the earlier version looked
 * like a plain frosted card no matter how strong the displacement was. `backdrop-filter` bends
 * what is *behind* the element, so text and images passing under the pane actually move.
 *
 * Chromium supports `url()` inside `backdrop-filter`; Safari and Firefox do not, and fall back in
 * globals.css to blur alone. So the film and the specular edge still have to carry the look on
 * their own, and the bend stays a bonus rather than the thing the material depends on.
 */
export function GlassFilter() {
  return (
    <svg aria-hidden className="pointer-events-none absolute h-0 w-0" focusable="false">
      {LENSES.map(({ id, band, scale }) => (
        <filter
          key={id}
          id={id}
          x="0%"
          y="0%"
          width="100%"
          height="100%"
          filterUnits="objectBoundingBox"
          // linearRGB (the default) would gamma-bend the map before the displacement reads it,
          // which pulls the neutral grey off 0.5 and drifts the whole backdrop sideways.
          colorInterpolationFilters="sRGB"
        >
          {/*
            The map is a picture of the glass, not of the backdrop: a flat neutral middle with a
            ramp at each edge. feDisplacementMap moves every pixel by `scale × (channel - 0.5)`,
            so neutral means "show what is really there" and the ramps pull the backdrop inward
            from the four edges. That is what a thick pane does to what is behind it - clear in
            the middle, compressed at the rim.
          */}
          <feImage
            href={displacementMap(band)}
            x="0%"
            y="0%"
            width="100%"
            height="100%"
            preserveAspectRatio="none"
            result="map"
          />
          <feDisplacementMap
            in="SourceGraphic"
            in2="map"
            scale={scale}
            xChannelSelector="R"
            yChannelSelector="G"
          />
        </filter>
      ))}
    </svg>
  );
}

/**
 * The displacement map, as a data URI so it costs no request and cannot 404.
 *
 * Red carries horizontal displacement and green vertical, both neutral at 128. The ramp runs from
 * full at the very edge to neutral `band` of the way in, with a knee partway so the bend is
 * concentrated at the rim rather than spread evenly - a linear ramp reads as a lens the size of
 * the whole pane. `screen` merges the two ramps because each one is zero in the other's channel,
 * which makes the blend an exact addition.
 *
 * The bands are fractions rather than pixels because the map is stretched to whatever it is
 * applied to. A pane twice as wide gets a bend twice as wide, which is why the bar lens below
 * carries its own much narrower horizontal band.
 */
function displacementMap({ x, y }: { x: number; y: number }): string {
  // Distance from the edge, and the channel value there. 128 is neutral, 255 is a full pull.
  const RAMP: [number, number][] = [
    [0, 255],
    [0.35, 190],
    [1, 128],
  ];

  const stops = (band: number, channel: "r" | "g") => {
    const paint = (value: number) => (channel === "r" ? `rgb(${value},0,0)` : `rgb(0,${value},0)`);
    const leading = RAMP.map(
      ([at, value]) => `<stop offset="${(at * band).toFixed(4)}" stop-color="${paint(value)}"/>`,
    );
    // The far edge is the same ramp mirrored through neutral, so it pulls the other way.
    const trailing = [...RAMP]
      .reverse()
      .map(
        ([at, value]) =>
          `<stop offset="${(1 - at * band).toFixed(4)}" stop-color="${paint(255 - value)}"/>`,
      );
    return leading.join("") + trailing.join("");
  };

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240" ` +
    `viewBox="0 0 240 240" preserveAspectRatio="none">` +
    `<defs>` +
    `<linearGradient id="x" x1="0" y1="0" x2="1" y2="0">${stops(x, "r")}</linearGradient>` +
    `<linearGradient id="y" x1="0" y1="0" x2="0" y2="1">${stops(y, "g")}</linearGradient>` +
    `</defs>` +
    `<rect width="240" height="240" fill="url(#x)"/>` +
    `<rect width="240" height="240" fill="url(#y)" style="mix-blend-mode:screen"/>` +
    `</svg>`;

  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/**
 * `band` is how far in from each edge the bend reaches, as a fraction of that axis. `scale` is how
 * hard it bends: the pull at the very rim is `scale / 2` pixels, falling to nothing at the band's
 * inner edge.
 *
 * Measured rather than guessed. Past about 60 the compression at the rim folds a second copy of
 * whatever is behind into view, which reads as a mirror rather than as glass. A chromatic split
 * between the channels was tried and dropped: even a 5% spread fringed text across the whole pane
 * instead of only at the rim, because the pull is vertical too and headline type is tall.
 *
 * `bar` is for the nav island, which is wide and short. An even band would put its horizontal bend
 * 200px in from each end, so it gets a narrow one across and a deep one down the short axis, where
 * the page actually scrolls past.
 */
const LENSES = [
  { id: "corwa-lens-soft", band: { x: 0.12, y: 0.12 }, scale: 34 },
  { id: "corwa-lens-deep", band: { x: 0.18, y: 0.18 }, scale: 52 },
  { id: "corwa-lens-bar", band: { x: 0.04, y: 0.34 }, scale: 30 },
] as const;

/**
 * The lit surface every glass pane sits on. One per shell. It reads the `--aurora-*` tokens from
 * whichever surface contains it, so the same element renders amber on the light pages and a much
 * deeper ember inside `.terminal`, without either side needing to know about the other.
 */
export function AuroraField() {
  return <div aria-hidden className="aurora-field" />;
}
