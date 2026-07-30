"use client";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

export default function SegmentedRadio<T extends string>({
  name,
  legend,
  value,
  options,
  onChange,
  className = "",
}: {
  name: string;
  legend: string;
  value: T;
  options: readonly SegmentedOption<T>[];
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <fieldset className={`segmented-control ${className}`}>
      <legend>{legend}</legend>
      <div className="segmented-control__options">
        {options.map((option) => (
          <label key={option.value}>
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
