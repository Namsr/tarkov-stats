"use client";

interface RangeSliderProps {
  min: number;
  max: number;
  low: number;
  high: number;
  lowLabel: string;
  highLabel: string;
  onChange: (low: number, high: number) => void;
  disabled?: boolean;
}

function percent(value: number, min: number, max: number): number {
  if (max <= min) return 0;
  return ((value - min) / (max - min)) * 100;
}

export default function RangeSlider({
  min,
  max,
  low,
  high,
  lowLabel,
  highLabel,
  onChange,
  disabled = false,
}: RangeSliderProps) {
  const lowPercent = percent(low, min, max);
  const highPercent = percent(high, min, max);
  const sharedInputClasses =
    "pointer-events-none absolute inset-0 h-8 w-full appearance-none bg-transparent outline-none " +
    "[&::-webkit-slider-runnable-track]:h-1 [&::-webkit-slider-runnable-track]:bg-transparent " +
    "[&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:h-5 [&::-webkit-slider-thumb]:w-5 " +
    "[&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full " +
    "[&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-[var(--card-bg)] " +
    "[&::-webkit-slider-thumb]:bg-[var(--accent)] [&::-webkit-slider-thumb]:shadow-md " +
    "[&::-moz-range-track]:h-1 [&::-moz-range-track]:bg-transparent " +
    "[&::-moz-range-thumb]:pointer-events-auto [&::-moz-range-thumb]:h-5 [&::-moz-range-thumb]:w-5 " +
    "[&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2 " +
    "[&::-moz-range-thumb]:border-[var(--card-bg)] [&::-moz-range-thumb]:bg-[var(--accent)]";

  return (
    <div className={`relative h-8 w-full ${disabled ? "opacity-50" : ""}`}>
      <div
        aria-hidden="true"
        className="absolute left-0 right-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-[var(--card-border)]"
      />
      <div
        aria-hidden="true"
        className="absolute top-1/2 h-1 -translate-y-1/2 rounded-full bg-[var(--accent)]"
        style={{ left: `${lowPercent}%`, right: `${100 - highPercent}%` }}
      />
      <input
        type="range"
        min={min}
        max={max}
        step={1}
        value={low}
        disabled={disabled}
        aria-label={lowLabel}
        aria-valuemin={min}
        aria-valuemax={high}
        aria-valuenow={low}
        onChange={(event) => onChange(Math.min(Number(event.target.value), high), high)}
        className={`${sharedInputClasses} ${low >= max - (max - min) * 0.05 ? "z-30" : "z-20"}`}
      />
      <input
        type="range"
        min={min}
        max={max}
        step={1}
        value={high}
        disabled={disabled}
        aria-label={highLabel}
        aria-valuemin={low}
        aria-valuemax={max}
        aria-valuenow={high}
        onChange={(event) => onChange(low, Math.max(Number(event.target.value), low))}
        className={`${sharedInputClasses} z-20`}
      />
    </div>
  );
}
