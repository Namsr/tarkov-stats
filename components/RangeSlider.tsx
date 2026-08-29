"use client";

import { useEffect, useRef, type PointerEvent } from "react";

interface RangeSliderProps {
  min: number;
  max: number;
  low: number;
  high: number;
  lowLabel: string;
  highLabel: string;
  onChange: (low: number, high: number) => void;
  onChangeComplete?: (low: number, high: number) => void;
  disabled?: boolean;
  minSpan?: number;
  minVisualGap?: number;
  toPosition?: (value: number, edge: "low" | "high") => number;
  fromPosition?: (position: number, edge: "low" | "high") => number;
}

function percent(value: number, min: number, max: number): number {
  if (max <= min) return 0;
  return ((value - min) / (max - min)) * 100;
}

function arrowDelta(key: string): number | null {
  if (key === "ArrowLeft" || key === "ArrowDown") return -1;
  if (key === "ArrowRight" || key === "ArrowUp") return 1;
  return null;
}

export default function RangeSlider({
  min,
  max,
  low,
  high,
  lowLabel,
  highLabel,
  onChange,
  onChangeComplete,
  disabled = false,
  minSpan = 0,
  minVisualGap = 0,
  toPosition,
  fromPosition,
}: RangeSliderProps) {
  const latest = useRef({ low, high });
  useEffect(() => {
    latest.current = { low, high };
  }, [high, low]);
  const positionOf = (value: number, edge: "low" | "high") =>
    toPosition ? Math.min(1, Math.max(0, toPosition(value, edge))) : percent(value, min, max) / 100;
  const valueAt = (position: number, edge: "low" | "high") =>
    fromPosition
      ? fromPosition(Math.min(1, Math.max(0, position)), edge)
      : Math.round(min + position * (max - min));
  const change = (nextLow: number, nextHigh: number) => {
    latest.current = { low: nextLow, high: nextHigh };
    onChange(nextLow, nextHigh);
  };
  const complete = () => onChangeComplete?.(latest.current.low, latest.current.high);
  const capturePointer = (event: PointerEvent<HTMLInputElement>) => {
    if (onChangeComplete) event.currentTarget.setPointerCapture(event.pointerId);
  };
  const releasePointer = (event: PointerEvent<HTMLInputElement>) => {
    if (!onChangeComplete) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    complete();
  };
  const lowPosition = positionOf(low, "low");
  const highPosition = positionOf(high, "high");
  const lowPercent = lowPosition * 100;
  const highPercent = highPosition * 100;
  const sliderMax = 10_000;
  const sharedInputClasses =
    "pointer-events-none absolute inset-0 h-8 w-full appearance-none bg-transparent outline-none " +
    "[&::-webkit-slider-runnable-track]:h-1 [&::-webkit-slider-runnable-track]:bg-transparent " +
    "[&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:h-5 [&::-webkit-slider-thumb]:w-5 " +
    "[&::-webkit-slider-thumb]:-mt-2 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full " +
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
        min={0}
        max={sliderMax}
        step={1}
        value={Math.round(lowPosition * sliderMax)}
        disabled={disabled}
        aria-label={lowLabel}
        aria-valuemin={min}
        aria-valuemax={high}
        aria-valuenow={low}
        onKeyDown={(event) => {
          const delta = arrowDelta(event.key);
          if (delta == null) return;
          event.preventDefault();
          change(Math.max(min, Math.min(low + delta, high - minSpan)), high);
        }}
        onChange={(event) => {
          const requestedPosition = Number(event.target.value) / sliderMax;
          const position = Math.min(requestedPosition, highPosition - minVisualGap);
          const next = Math.min(valueAt(position, "low"), high - minSpan);
          change(Math.max(min, next), high);
        }}
        onPointerDown={onChangeComplete ? capturePointer : undefined}
        onPointerUp={onChangeComplete ? releasePointer : undefined}
        onPointerCancel={onChangeComplete ? releasePointer : undefined}
        onKeyUp={onChangeComplete ? complete : undefined}
        onBlur={onChangeComplete ? complete : undefined}
        className={`${sharedInputClasses} ${low >= max - (max - min) * 0.05 ? "z-30" : "z-20"}`}
      />
      <input
        type="range"
        min={0}
        max={sliderMax}
        step={1}
        value={Math.round(highPosition * sliderMax)}
        disabled={disabled}
        aria-label={highLabel}
        aria-valuemin={low}
        aria-valuemax={max}
        aria-valuenow={high}
        onKeyDown={(event) => {
          const delta = arrowDelta(event.key);
          if (delta == null) return;
          event.preventDefault();
          change(low, Math.min(max, Math.max(high + delta, low + minSpan)));
        }}
        onChange={(event) => {
          const requestedPosition = Number(event.target.value) / sliderMax;
          const position = Math.max(requestedPosition, lowPosition + minVisualGap);
          const next = Math.max(valueAt(position, "high"), low + minSpan);
          change(low, Math.min(max, next));
        }}
        onPointerDown={onChangeComplete ? capturePointer : undefined}
        onPointerUp={onChangeComplete ? releasePointer : undefined}
        onPointerCancel={onChangeComplete ? releasePointer : undefined}
        onKeyUp={onChangeComplete ? complete : undefined}
        onBlur={onChangeComplete ? complete : undefined}
        className={`${sharedInputClasses} z-20`}
      />
    </div>
  );
}
