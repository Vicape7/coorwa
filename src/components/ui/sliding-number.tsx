/**
 * A number whose digits roll to their new value, each on its own drum.
 *
 * Ported from the motion-based "sliding number" snippet without motion or react-use-measure: every
 * digit is a column of 0-9 moved with a CSS transform in `em`, so nothing has to be measured and no
 * spring runs in JavaScript. The overshoot in the easing stands in for the spring.
 *
 * Takes an already formatted string, so separators, currency signs and decimals stay the caller's
 * choice. Digits are keyed by their place counted from the right, which keeps a drum on the same
 * place when the number grows a digit on the left.
 */
export function SlidingNumber({ value, className }: { value: string; className?: string }) {
  let place = 0;
  const keyed = value
    .split("")
    .reverse()
    .map((ch) => ({ ch, key: /\d/.test(ch) ? `d${place++}` : `s${place}-${ch}` }))
    .reverse();

  return (
    <span className={className} aria-label={value} role="img">
      {/* Every character gets the same 1.1em box, separators too, or they drift off the digits' line. */}
      <span aria-hidden className="inline-flex">
        {keyed.map(({ ch, key }) =>
          /\d/.test(ch) ? (
            <Digit key={key} digit={Number(ch)} />
          ) : (
            <span key={key} className="inline-block h-[1.1em] leading-[1.1em]">
              {ch}
            </span>
          ),
        )}
      </span>
    </span>
  );
}

function Digit({ digit }: { digit: number }) {
  return (
    <span className="relative inline-block h-[1.1em] w-[1ch] overflow-hidden leading-[1.1em]">
      <span
        className="absolute inset-x-0 top-0 flex flex-col items-center transition-transform duration-500 [transition-timing-function:cubic-bezier(0.34,1.4,0.64,1)] motion-reduce:transition-none"
        style={{ transform: `translateY(-${digit * 1.1}em)` }}
      >
        {DIGITS.map((d) => (
          <span key={d} className="h-[1.1em]">
            {d}
          </span>
        ))}
      </span>
    </span>
  );
}

const DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
