// SDK Geometry - Pure geometric utilities for path computation
// No dependency on Editor or Renderer

export interface Point2D {
  x: number
  y: number
}

export interface PathEvalResult {
  position: Point2D
  /** Rotation degrees: 0=up(-Y), 90=right(+X), 180=down(+Y), 270=left(-X) */
  tangentAngleDeg: number
  tangentVec: Point2D
}

export interface SnapResult {
  /** Parametric position [0..1] along the path */
  t: number
  snappedPoint: Point2D
  /** Perpendicular distance from query point to the path */
  distance: number
  segmentIndex: number
}

// --- Arc Length ---

export function computeArcLengths(points: Point2D[]): number[] {
  if (points.length === 0) return []
  const lengths = new Array<number>(points.length)
  lengths[0] = 0
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - points[i - 1].x
    const dy = points[i].y - points[i - 1].y
    lengths[i] = lengths[i - 1] + Math.sqrt(dx * dx + dy * dy)
  }
  return lengths
}

export function totalArcLength(points: Point2D[]): number {
  if (points.length < 2) return 0
  const lengths = computeArcLengths(points)
  return lengths[lengths.length - 1]
}

// --- Evaluate position + tangent at parametric t ---

export function evaluatePathAt(points: Point2D[], t: number): PathEvalResult {
  const fallback: PathEvalResult = {
    position: points[0] ?? { x: 0, y: 0 },
    tangentAngleDeg: 0,
    tangentVec: { x: 0, y: -1 },
  }
  if (points.length < 2) return fallback

  const arcLengths = computeArcLengths(points)
  const totalLen = arcLengths[arcLengths.length - 1]
  if (totalLen === 0) return fallback

  const clampedT = Math.max(0, Math.min(1, t))
  const targetLen = clampedT * totalLen

  // Binary search for the segment containing targetLen
  let lo = 0
  let hi = points.length - 2
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (arcLengths[mid + 1] < targetLen) lo = mid + 1
    else hi = mid
  }

  const segStart = points[lo]
  const segEnd = points[lo + 1]
  const segLen = arcLengths[lo + 1] - arcLengths[lo]
  const localT = segLen > 0 ? (targetLen - arcLengths[lo]) / segLen : 0

  const position: Point2D = {
    x: segStart.x + (segEnd.x - segStart.x) * localT,
    y: segStart.y + (segEnd.y - segStart.y) * localT,
  }

  const dx = segEnd.x - segStart.x
  const dy = segEnd.y - segStart.y
  const len = Math.sqrt(dx * dx + dy * dy)
  const tangentVec: Point2D = len > 0 ? { x: dx / len, y: dy / len } : { x: 0, y: -1 }

  // 0°=up(-Y), 90°=right(+X), 180°=down(+Y), 270°=left(-X)
  const angleRad = Math.atan2(dx, -dy)
  const tangentAngleDeg = ((angleRad * 180) / Math.PI + 360) % 360

  return { position, tangentAngleDeg, tangentVec }
}

// --- Snap a world-space point onto the path ---

export function snapToPath(points: Point2D[], queryPoint: Point2D): SnapResult {
  const fallback: SnapResult = {
    t: 0,
    snappedPoint: points[0] ?? { x: 0, y: 0 },
    distance: Infinity,
    segmentIndex: 0,
  }
  if (points.length < 2) return fallback

  const arcLengths = computeArcLengths(points)
  const totalLen = arcLengths[arcLengths.length - 1]
  if (totalLen === 0) return fallback

  let bestDist = Infinity
  let bestT = 0
  let bestPoint: Point2D = points[0]
  let bestSeg = 0

  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]
    const b = points[i + 1]
    const abx = b.x - a.x
    const aby = b.y - a.y
    const abLenSq = abx * abx + aby * aby
    if (abLenSq === 0) continue

    const apx = queryPoint.x - a.x
    const apy = queryPoint.y - a.y
    const localT = Math.max(0, Math.min(1, (apx * abx + apy * aby) / abLenSq))

    const proj: Point2D = { x: a.x + abx * localT, y: a.y + aby * localT }
    const dx = queryPoint.x - proj.x
    const dy = queryPoint.y - proj.y
    const dist = Math.sqrt(dx * dx + dy * dy)

    if (dist < bestDist) {
      bestDist = dist
      bestPoint = proj
      bestSeg = i
      bestT = (arcLengths[i] + (arcLengths[i + 1] - arcLengths[i]) * localT) / totalLen
    }
  }

  return {
    t: Math.round(bestT * 10000) / 10000,
    snappedPoint: bestPoint,
    distance: bestDist,
    segmentIndex: bestSeg,
  }
}

// --- Uniform spacing ---

export function uniformTValues(count: number): number[] {
  if (count <= 0) return []
  if (count === 1) return [0.5]
  return Array.from({ length: count }, (_, i) => i / (count - 1))
}

// --- Heading computation ---

export function computeHeadings(points: Point2D[]): number[] {
  if (points.length < 2) return points.map(() => 0)
  const headings: number[] = []
  for (let i = 0; i < points.length; i++) {
    const prev = points[Math.max(0, i - 1)]
    const next = points[Math.min(points.length - 1, i + 1)]
    const dx = next.x - prev.x
    const dy = next.y - prev.y
    const angleRad = Math.atan2(dx, -dy)
    headings.push(((angleRad * 180) / Math.PI + 360) % 360)
  }
  return headings
}

// --- Interpolation ---

export function interpolatePosition(p1: Point2D, p2: Point2D, t: number): Point2D {
  return {
    x: p1.x + (p2.x - p1.x) * t,
    y: p1.y + (p2.y - p1.y) * t,
  }
}

// --- Bounding box ---

export function getBoundingBox(points: Point2D[]): { x: number; y: number; width: number; height: number } {
  if (points.length === 0) return { x: 0, y: 0, width: 0, height: 0 }
  let minX = Infinity, minY = Infinity
  let maxX = -Infinity, maxY = -Infinity
  for (const pt of points) {
    minX = Math.min(minX, pt.x)
    minY = Math.min(minY, pt.y)
    maxX = Math.max(maxX, pt.x)
    maxY = Math.max(maxY, pt.y)
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

// --- Point-to-segment distance ---

export function distanceToSegment(point: Point2D, segStart: Point2D, segEnd: Point2D): number {
  const dx = segEnd.x - segStart.x
  const dy = segEnd.y - segStart.y
  const lenSq = dx * dx + dy * dy
  if (lenSq === 0) {
    const ex = point.x - segStart.x
    const ey = point.y - segStart.y
    return Math.sqrt(ex * ex + ey * ey)
  }
  const t = Math.max(0, Math.min(1, ((point.x - segStart.x) * dx + (point.y - segStart.y) * dy) / lenSq))
  const projX = segStart.x + t * dx
  const projY = segStart.y + t * dy
  const ex = point.x - projX
  const ey = point.y - projY
  return Math.sqrt(ex * ex + ey * ey)
}
