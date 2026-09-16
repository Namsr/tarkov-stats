"use client";

import { useLayoutEffect, useRef } from "react";

export default function ChartCrosshair({ point, visible, left, bottom, labelY, width }: {
  point: { x: number; y: number; xLabel: string; yLabel: string; color: string } | null;
  visible: boolean;
  left: number;
  bottom: number;
  labelY: number;
  width: number;
}) {
  const ref = useRef<SVGGElement>(null);

  useLayoutEffect(() => {
    const group = ref.current;
    if (!group) return;
    const labels = [...group.querySelectorAll("text")];
    for (const label of labels) {
      // Reset before measuring, so repeated renders do not accumulate an offset.
      label.removeAttribute("transform");
      const box = label.getBBox();
      const offset = box.x < 2 ? 2 - box.x : box.x + box.width > width - 2 ? width - 2 - box.x - box.width : 0;
      label.setAttribute("transform", `translate(${offset} 0)`);
    }
    const boxes = labels.map((label) => label.getBoundingClientRect());
    for (const tick of group.ownerSVGElement?.querySelectorAll<SVGTextElement>("[data-chart-tick]") ?? []) {
      const box = tick.getBoundingClientRect();
      const overlaps = visible && boxes.some((other) => box.left < other.right + 3 && box.right + 3 > other.left && box.top < other.bottom + 3 && box.bottom + 3 > other.top);
      tick.style.opacity = overlaps ? "0" : "1";
    }
  });

  return <g ref={ref} className="chart-crosshair" opacity={visible && point ? 1 : 0} aria-hidden="true" pointerEvents="none">
    {point && <>
      <line className="chart-crosshair__guide" x1={point.x} x2={point.x} y1={point.y} y2={bottom} stroke={point.color} />
      <line className="chart-crosshair__guide" x1={left} x2={point.x} y1={point.y} y2={point.y} stroke={point.color} />
      <circle cx={point.x} cy={point.y} r="6" fill={point.color} />
      <text x={left - 10} y={point.y + 4} textAnchor="end" className="chart-crosshair__label" style={{ fill: point.color }}>{point.yLabel}</text>
      <text x={point.x} y={labelY} textAnchor="middle" className="chart-crosshair__label" style={{ fill: point.color }}>{point.xLabel}</text>
    </>}
  </g>;
}
