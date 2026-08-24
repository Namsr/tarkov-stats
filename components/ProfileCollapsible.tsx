"use client";

import { useEffect, useRef } from "react";
import type { ReactNode } from "react";

export default function ProfileCollapsible({
  id,
  expanded,
  className,
  children,
}: {
  id: string;
  expanded: boolean;
  className: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const measuredHeight = useRef<number | null>(null);

  useEffect(() => {
    const node = ref.current;
    const content = contentRef.current;
    if (!node || !content) return;
    const updateHeight = () => {
      const height = content.scrollHeight;
      if (measuredHeight.current === height) return;
      measuredHeight.current = height;
      node.style.setProperty("--profile-collapsible-height", `${height}px`);
    };
    updateHeight();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateHeight);
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

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
