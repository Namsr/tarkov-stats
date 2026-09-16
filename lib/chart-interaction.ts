/** Select the closest point inside its hit radius, including overlapping series. */
export function nearestChartPoint(points: readonly { x: number; y: number }[], x: number, y: number, radius = 13): number | null {
  let nearest: number | null = null;
  let distance = radius * radius;
  points.forEach((point, index) => {
    const candidate = (point.x - x) ** 2 + (point.y - y) ** 2;
    if (candidate <= distance) {
      nearest = index;
      distance = candidate;
    }
  });
  return nearest;
}

export function chartPointAtPointer(points: readonly { x: number; y: number }[], event: { currentTarget: SVGSVGElement; clientX: number; clientY: number }): number | null {
  const matrix = event.currentTarget.getScreenCTM();
  if (!matrix) return null;
  const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
  return nearestChartPoint(points, point.x, point.y);
}
