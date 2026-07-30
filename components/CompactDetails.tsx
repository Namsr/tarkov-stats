import type { ReactNode } from "react";

export default function CompactDetails({
  summary,
  children,
  className = "",
}: {
  summary: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <details className={`compact-details ${className}`}>
      <summary>{summary}</summary>
      <div className="compact-details__body">{children}</div>
    </details>
  );
}
