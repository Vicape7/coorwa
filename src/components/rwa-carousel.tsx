"use client";

import Image from "next/image";
import { useEffect, useRef } from "react";
import { RWA_ASSETS } from "@/lib/rwa";

/**
 * The benchmarks Coorwa actually carries, as tiles on a slowly turning ring.
 *
 * The projection is the one from the 21st.dev orbit slider: every tile sits on a circle that is
 * tilted almost flat and drawn through a pinhole camera, so a tile at the back is higher, smaller
 * and behind, and one at the front is lower, larger and in front. The tiles themselves never turn -
 * they stay square to the reader, which is what keeps sixteen brand logos readable.
 *
 * Three things are not from that component:
 *
 *   1. No GSAP. The library is there for its Flip plugin, which animates the jump between the four
 *      layout modes, and a hero that only ever shows one of them never calls it. The projection is
 *      about forty lines of trigonometry and the hover is a CSS transition, so the whole thing
 *      costs nothing to ship. If the Flat / Tilt / Ring / Gallery switcher is wanted, that is when
 *      the dependency earns its place.
 *   2. Size comes from a transform, not from `width` and `height`. The original writes both on
 *      every card on every frame, which is a layout pass sixteen times a frame; a scale is a
 *      compositor job.
 *   3. Hover lifts and tips the tile rather than flipping it 180 degrees. There is no back face
 *      here, so a flip would show a mirrored NVIDIA logo, which is the one thing a brand mark
 *      must not do.
 *
 * The list is `RWA_ASSETS` rather than a copy, so a benchmark added in `rwa.ts` shows up here and
 * cannot drift out of sync with what the terminal will actually quote.
 */

/*
 * The camera. `tilt` is how far the ring is laid down, in degrees: 0 is a circle seen head-on, 90
 * is edge-on. `radiusX` and `radiusY` stretch the result after the projection, which is what turns
 * a circle into a band as wide as the page and only as tall as the hero can spare. Every one of
 * these was picked against the real page, not derived.
 */
const ORBIT = {
  tilt: 70,
  radiusX: 3,
  radiusY: 1.5,
  scale: 1,
  /*
   * How far the whole ring is pushed down inside its band, as a fraction of its own height. This is
   * what makes it read as an arc rather than as a hoop: the ellipse is taller than the band, so the
   * near half - the big tiles at the bottom - falls outside and gets clipped, and what is left
   * crossing the band is the far arc, rising in the middle and running off both sides. Take it to
   * zero and the whole ellipse fits, which looks like a plate seen from above.
   *
   * A fraction rather than a pixel count because the ring shrinks with the tile on a phone, and a
   * fixed drop would leave the arc sitting in the bottom third of a band half the height.
   */
  drop: 0.66,
  /** Degrees of roll applied to the finished composition, so the band is not dead level. */
  roll: -2,
  /** Degrees per second. A full turn takes a minute and a half. */
  speed: 4,
  /** Where the ring sits inside its own band, 0.5 being centred. */
  anchorY: 0.5,
  /** How much of the depth reaches position, and how much reaches size. */
  positionScaleStrength: 0.45,
  sizeScaleStrength: 0.8,
};

interface Box {
  x: number;
  y: number;
  scale: number;
  depth: number;
}

/**
 * One ring of `count` tiles, projected. Returns a position and a scale per tile, in pixels
 * relative to the band's own box.
 */
function project(count: number, width: number, height: number, tile: number, offsetDeg: number) {
  // How big the circle has to be for `count` tiles of this size not to crowd each other.
  const span = tile;
  const baseRadius = Math.max(((count * span) / (2 * Math.PI)) * 0.62, span * 0.9);
  const radius = baseRadius * 1.12;
  // Distance from the eye to the middle of the ring. Nearer means a stronger near-far difference.
  const camera = radius * 1.75;
  const tilt = (ORBIT.tilt * Math.PI) / 180;
  const cx = width / 2;
  const cy = height * ORBIT.anchorY;

  /*
   * On a phone the band is a third of the width and the ring would run so far past both edges that
   * two tiles were left in the middle. Cap the horizontal stretch at a little over half the band, so
   * the arc always ends just outside the fade instead of somewhere off in the margin.
   */
  const radiusX = Math.min(ORBIT.radiusX, (width * 0.62) / radius);

  const boxes: Box[] = [];
  for (let i = 0; i < count; i++) {
    const theta = (((offsetDeg - 90 + (i / count) * 360) % 360) * Math.PI) / 180;
    const px = radius * Math.sin(theta);
    // Depth before the tilt, which the tilt then splits into height and remaining depth.
    const pz0 = -radius * Math.cos(theta);
    const py = -pz0 * Math.sin(tilt);
    const pz = pz0 * Math.cos(tilt);

    const perspective = Math.max(camera / (camera + pz), 0.05);
    const spread = 1 + (perspective - 1) * ORBIT.positionScaleStrength;
    const size = 1 + (perspective - 1) * ORBIT.sizeScaleStrength;

    boxes.push({
      x: px * spread * radiusX * ORBIT.scale,
      y: py * spread * ORBIT.radiusY * ORBIT.scale,
      scale: size * ORBIT.scale,
      depth: Math.round(perspective * 1000),
    });
  }

  // Roll the finished composition around its own anchor. It happens last, on flat coordinates,
  // which is why it tips the band without disturbing which tile is in front.
  const roll = (ORBIT.roll * Math.PI) / 180;
  const cos = Math.cos(roll);
  const sin = Math.sin(roll);
  const drop = radius * Math.sin(tilt) * ORBIT.radiusY * ORBIT.drop;
  return boxes.map((b) => ({
    ...b,
    x: cx + b.x * cos - b.y * sin,
    y: cy + b.x * sin + b.y * cos + drop,
  }));
}

export function RwaCarousel() {
  const trackRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const cards = Array.from(track.querySelectorAll<HTMLElement>("[data-orbit-card]"));
    if (cards.length === 0) return;

    const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let offset = 0;
    let raf = 0;
    let last: number | null = null;
    let width = 0;
    let height = 0;
    let tile = 0;
    let hovered = 0;
    let visible = document.visibilityState === "visible";
    let inView = true;
    let disposed = false;

    const layout = () => {
      if (width === 0 || height === 0 || tile === 0) return;
      const boxes = project(cards.length, width, height, tile, offset);
      cards.forEach((card, i) => {
        const box = boxes[i];
        // translate, then scale, then pull back by half the card: in that order the card's centre
        // lands on the projected point whatever the scale is.
        card.style.transform = `translate3d(${box.x.toFixed(2)}px, ${box.y.toFixed(2)}px, 0) scale(${box.scale.toFixed(4)}) translate(-50%, -50%)`;
        card.style.zIndex = String(box.depth);
      });
    };

    const measure = () => {
      const rect = track.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      // The tile is sized in CSS so the band can shrink on small screens without new numbers here.
      tile = cards[0].getBoundingClientRect().width || 0;
      layout();
    };

    function frame(now: number) {
      raf = 0;
      if (disposed || !visible || !inView) return;
      const dt = last === null ? 0 : Math.min((now - last) / 1000, 0.1);
      last = now;
      if (hovered === 0) {
        offset = (offset + ORBIT.speed * dt) % 360;
        layout();
      }
      request();
    }

    function request() {
      if (disposed || calm || !visible || !inView || raf !== 0) return;
      raf = requestAnimationFrame(frame);
    }

    const pause = () => {
      if (raf === 0) return;
      cancelAnimationFrame(raf);
      raf = 0;
      last = null;
    };

    // Hover holds the ring still, so a tile can be read rather than chased.
    const onEnter = () => {
      hovered += 1;
    };
    const onLeave = () => {
      hovered = Math.max(0, hovered - 1);
      last = null;
    };
    for (const card of cards) {
      card.addEventListener("pointerenter", onEnter);
      card.addEventListener("pointerleave", onLeave);
    }

    const onVisibility = () => {
      visible = document.visibilityState === "visible";
      if (visible) request();
      else pause();
    };
    document.addEventListener("visibilitychange", onVisibility);

    const resizeObserver = new ResizeObserver(measure);
    resizeObserver.observe(track);
    const intersectionObserver = new IntersectionObserver(([entry]) => {
      inView = entry?.isIntersecting ?? true;
      if (inView) request();
      else pause();
    });
    intersectionObserver.observe(track);

    measure();
    request();

    return () => {
      disposed = true;
      pause();
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      for (const card of cards) {
        card.removeEventListener("pointerenter", onEnter);
        card.removeEventListener("pointerleave", onLeave);
      }
    };
  }, []);

  return (
    <div className="rwa-orbit" aria-label="Benchmarks available on Coorwa">
      <div ref={trackRef} className="rwa-orbit-track">
        {RWA_ASSETS.map((asset) => (
          <div
            key={asset.symbol}
            data-orbit-card
            className="rwa-orbit-card"
            title={`${asset.name} · ${asset.symbol}`}
          >
            <div className="rwa-orbit-face">
              {/*
                Local copies of the Backed logos with the xStocks "X" painted out, so the hero shows
                the company marks alone. Everywhere else keeps `asset.logo`, where the X tells a
                trader the token is the tokenised share. A benchmark added to `rwa.ts` needs its
                file in public/rwa too, as a 256px WebP.

                Served as they are rather than through the optimiser: sixteen files of 1 to 3 KB
                gain nothing from being resized per request, and the round trip through the Worker
                was what left the tiles blank while the ring turned. Eager, because every tile is
                on screen the moment the hero is.
              */}
              <Image
                src={`/rwa/${asset.ticker}.webp`}
                alt={asset.name}
                fill
                unoptimized
                loading="eager"
                draggable={false}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
