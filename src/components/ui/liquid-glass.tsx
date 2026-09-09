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
 *      middle, so the filter below builds its displacement from the pane's own outline instead.
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
 * The displacement maps that every `.glass-pane` points at. Mount this once, in the root layout.
 * An SVG filter belongs to the whole document, so repeating it per surface only creates duplicate
 * ids.
 *
 * Combining `filter: url()` with `backdrop-filter` works in Chromium. Firefox and Safari keep the
 * blur and drop the bend, which is why the film and the highlight in globals.css have to carry the
 * look on their own.
 */
export function GlassFilter() {
  return (
    <svg aria-hidden className="pointer-events-none absolute h-0 w-0" focusable="false">
      {LENSES.map(({ id, ramp, lens, liquid }) => (
        <filter
          key={id}
          id={id}
          x="0%"
          y="0%"
          width="100%"
          height="100%"
          filterUnits="objectBoundingBox"
          // linearRGB (the default) would bend the ramp before the convolution reads it, which
          // skews the gradient towards the dark end and lands the lens off the edge.
          colorInterpolationFilters="sRGB"
        >
          {/*
            1. The pane's own silhouette, blurred. The filter region is exactly the element, so
               blurring its alpha yields a ramp climbing inward from all four edges - and around
               the corners too, since the layer carries the border radius.
          */}
          <feGaussianBlur in="SourceAlpha" stdDeviation={ramp} result="ramp" />

          {/*
            2. Move that ramp out of alpha and into RGB, and force alpha to 1. Both matter: a
               convolution only reads colour channels, and feConvolveMatrix adds `bias × alpha`,
               so a varying alpha here would blow the neutral point out at the boundary.
          */}
          <feColorMatrix
            in="ramp"
            type="matrix"
            values="0 0 0 1 0
                    0 0 0 1 0
                    0 0 0 1 0
                    0 0 0 0 1"
            result="rampRGB"
          />

          {/*
            3. Sobel. The gradient of the ramp points straight out of the nearest edge and is zero
               in the flat middle, which is precisely the shape of refraction through a lens: the
               centre of a pane of glass shows you what is behind it, the rim bends it.
          */}
          <feConvolveMatrix
            in="rampRGB"
            order="3 3"
            preserveAlpha="true"
            divisor="2"
            bias="0.5"
            kernelMatrix="1 0 -1 2 0 -2 1 0 -1"
            result="gx"
          />
          <feConvolveMatrix
            in="rampRGB"
            order="3 3"
            preserveAlpha="true"
            divisor="2"
            bias="0.5"
            kernelMatrix="1 2 1 0 0 0 -1 -2 -1"
            result="gy"
          />

          {/* 4. Horizontal slope into red, vertical into green - the channels the map is read from. */}
          <feColorMatrix
            in="gx"
            type="matrix"
            values="1 0 0 0 0
                    0 0 0 0 0
                    0 0 0 0 0
                    0 0 0 0 1"
            result="gxR"
          />
          <feColorMatrix
            in="gy"
            type="matrix"
            values="0 0 0 0 0
                    1 0 0 0 0
                    0 0 0 0 0
                    0 0 0 0 1"
            result="gyG"
          />
          <feComposite
            in="gxR"
            in2="gyG"
            operator="arithmetic"
            k1="0"
            k2="1"
            k3="1"
            k4="0"
            result="normal"
          />

          {/* 5. Bend the backdrop along that normal. This is the lens. */}
          <feDisplacementMap
            in="SourceGraphic"
            in2="normal"
            scale={lens}
            xChannelSelector="R"
            yChannelSelector="G"
            result="lensed"
          />

          {/*
            6. A second, much smaller displacement from soft noise. The lens alone is geometric and
               reads as a bevel; this is the part that makes it liquid - the edge wanders slightly
               instead of following the rectangle exactly.
          */}
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.004 0.011"
            numOctaves="2"
            seed="11"
            result="noise"
          />
          <feGaussianBlur in="noise" stdDeviation="5" result="softNoise" />
          <feDisplacementMap
            in="lensed"
            in2="softNoise"
            scale={liquid}
            xChannelSelector="R"
            yChannelSelector="G"
          />
        </filter>
      ))}
    </svg>
  );
}

/**
 * `ramp` is how far in from the edge the bend reaches. `lens` is how hard it bends there. `liquid`
 * is how much the noise pass unsettles the result.
 *
 * feDisplacementMap moves each pixel by `scale * (channel - 0.5)`. A Sobel pass over a gently
 * sloped ramp comes out around 0.17 away from the neutral 0.5, so `lens: 60` works out at roughly
 * a 10px pull. That is enough to watch a shape move behind the rim without making text swim.
 */
const LENSES = [
  { id: "corwa-lens-soft", ramp: 12, lens: 60, liquid: 8 },
  { id: "corwa-lens-deep", ramp: 20, lens: 110, liquid: 14 },
] as const;

/**
 * The lit surface every glass pane sits on. One per shell. It reads the `--aurora-*` tokens from
 * whichever surface contains it, so the same element renders amber on the light pages and a much
 * deeper ember inside `.terminal`, without either side needing to know about the other.
 */
export function AuroraField() {
  return <div aria-hidden className="aurora-field" />;
}
