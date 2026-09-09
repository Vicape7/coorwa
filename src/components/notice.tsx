/**
 * Inline status message. Tinted from the signal colour rather than given a border, so it sits in
 * the same visual register as everything else.
 */
export function Notice({
  tone,
  children,
}: {
  tone: "up" | "down" | "note";
  children: React.ReactNode;
}) {
  const color =
    tone === "up"
      ? "var(--color-up)"
      : tone === "down"
        ? "var(--color-down)"
        : "var(--color-cookie-deep)";

  return (
    <div
      style={{ color, background: `color-mix(in srgb, ${color} 9%, transparent)` }}
      className="rounded-2xl px-3.5 py-3 text-[13px] leading-relaxed"
    >
      {children}
    </div>
  );
}
