import clsx from "clsx";

/**
 * The only two icons in the product, drawn inline rather than pulled from an icon set. A
 * dependency for two 20-line paths would outweigh both of them, and the design system's rule about
 * restraint applies to iconography as much as to type.
 */

export function SearchGlyph({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className={clsx("h-[18px] w-[18px] shrink-0 text-[color:var(--text-subtle)]", className)}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
    >
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4 4" />
    </svg>
  );
}

export function ChevronGlyph({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className={clsx("h-3 w-3 text-[color:var(--text-subtle)]", className)}
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}
