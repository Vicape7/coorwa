"use client";

import clsx from "clsx";
import { ChevronGlyph } from "./glyphs";

/**
 * A native `<select>` wearing a pill. Native because this is how the advanced controls get off the
 * surface: sixteen quote assets and four sort orders were previously fourteen visible buttons, and
 * a real select collapses them to two words without inventing a menu, a focus trap or a keyboard
 * model that the platform already ships.
 */
export function PillSelect({
  value,
  onChange,
  options,
  label,
  id,
  className,
  prefix,
}: {
  value: string;
  onChange: (value: string) => void;
  options: readonly { value: string; label: string }[];
  /** Visually hidden, but the control still needs a name. */
  label: string;
  id: string;
  className?: string;
  /** Rendered inside the pill ahead of the value, e.g. "Sort". */
  prefix?: string;
}) {
  return (
    <div className={clsx("relative shrink-0", className)}>
      <label className="sr-only" htmlFor={id}>
        {label}
      </label>
      {prefix && (
        <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-[13px] text-muted">
          {prefix}
        </span>
      )}
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="num h-full w-full glass-select cursor-pointer appearance-none rounded-full py-2.5 pr-8 text-[13px] font-medium text-primary outline-none"
        style={{ paddingLeft: prefix ? `${prefix.length * 7 + 22}px` : "14px" }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronGlyph className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2" />
    </div>
  );
}
