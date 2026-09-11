"use client";

import { useEffect, useRef } from "react";
import type { ReactNode } from "react";

export default function ProfileCollapsible({
  id,
  expanded,
  className,
  children,
  previewRows,
  rowSelector,
}: {
  id: string;
  expanded: boolean;
  className: string;
  children: ReactNode;
  previewRows?: number;
  rowSelector?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = ref.current;
    const content = contentRef.current;
    if (!node || !content) return;
    const updateHeight = () => {
      const height = content.scrollHeight;
      node.style.setProperty("--profile-collapsible-height", `${height}px`);
      if (previewRows == null || !rowSelector) return;
      const rows = [...content.querySelectorAll<HTMLElement>(rowSelector)].filter((row) => row.getClientRects().length > 0);
      const top = content.getBoundingClientRect().top;
      const positions = [...new Set(rows.map((row) => Math.round(row.getBoundingClientRect().top - top)))];
      const tailTop = positions[previewRows];
      const tail = rows.find((row) => Math.round(row.getBoundingClientRect().top - top) === tailTop);
      node.dataset.canCollapse = String(tail != null);
      const previewHeight = tail ? tailTop + Math.min(80, tail.getBoundingClientRect().height * .85) : height;
      node.style.setProperty("--profile-collapsible-collapsed-height", `${previewHeight}px`);
      for (const row of rows) {
        const position = Math.round(row.getBoundingClientRect().top - top);
        const hidden = !expanded && tailTop != null && position >= tailTop;
        row.inert = hidden;
        if (hidden) row.setAttribute("aria-hidden", "true");
        else row.removeAttribute("aria-hidden");
        row.classList.toggle("profile-collapsible__preview-tail", !expanded && position === tailTop);
      }
    };
    updateHeight();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateHeight);
    observer.observe(content);
    return () => observer.disconnect();
  }, [children, expanded, previewRows, rowSelector]);

  return (
    <div
      ref={ref}
      id={id}
      className={`profile-collapsible__content ${className} ${expanded ? "is-expanded" : "is-collapsed"}`}
    >
      <div ref={contentRef} className="profile-collapsible__inner">
        {children}
      </div>
    </div>
  );
}

export function ProfileCollapseToggle({ expanded, controls, label, onToggle }: {
  expanded: boolean; controls: string; label: string; onToggle: () => void;
}) {
  return <button type="button" className="profile-collapsible__toggle" aria-expanded={expanded} aria-controls={controls} onClick={() => {
    if (expanded) {
      const content = document.getElementById(controls);
      if (content && content.getBoundingClientRect().top < 0) content.closest("section")?.scrollIntoView({ block: "start", behavior: "instant" });
    }
    onToggle();
  }}><span>{label}</span><span aria-hidden="true">{expanded ? "↑" : "↓"}</span></button>;
}
