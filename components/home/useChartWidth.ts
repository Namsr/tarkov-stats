"use client";

import { useEffect, useRef, useState } from "react";

export function useChartWidth(initialWidth: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(initialWidth);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}
