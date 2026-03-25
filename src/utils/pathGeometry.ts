// src/utils/pathGeometry.ts
//
// Arc-length parameterized path utilities for variable-position footprints.
// Provides: evaluatePathAt (position + tangent at any t), snapToPath (drag constraint),
// and uniformTValues (existing equidistant behavior).

import type { Point } from '../core/types'

export interface PathEvalResult {
  position: Point
  /** Drawtonomy rotation degrees: 0=up, 90=right, 180=down, 270=left */
  tangentAngleDeg: number
  /** Unit tangent vector in canvas coordinates */
  tangentVec: Point
}

export interface SnapResult {
  /** Parametric position [0..1] along the path */
  t: number
  /** Closest point on path to the query point */
  snappedPoint: Point
  /** Perpendicular distance from query point to the path */
  distance: number
  /** Index of the segment the snap landed on */
  segmentIndex: number
}

// ─── Arc Length ──────────────────────────────────────────────

/**
 * Cumulative arc lengths. lengths[0]=0, lengths[i]=distance from first point to point i.
 */
export function computeArcLengths(points: Point[]): number[] {
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

export function totalArcLength(points: Point[]): number {
  if (points.length < 2) return 0
  const lengths = computeArcLengths(points)
  return lengths[lengths.length - 1]
}

// ─── Evaluate position + tangent at parametric t ─────────────

/**
 * Given a polyline path and a parametric value t ∈ [0,1], returns the
 * world-space position and tangent angle at that point using arc-length
 * parameterization (constant speed along the polyline).
 */
export function evaluatePathAt(points: Point[], t: number): PathEvalResult {
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

  const position: Point = {
    x: segStart.x + (segEnd.x - segStart.x) * localT,
    y: segStart.y + (segEnd.y - segStart.y) * localT,
  }

  const dx = segEnd.x - segStart.x
  const dy = segEnd.y - segStart.y
  const len = Math.sqrt(dx * dx + dy * dy)
  const tangentVec: Point = len > 0 ? { x: dx / len, y: dy / len } : { x: 0, y: -1 }

  // Drawtonomy convention: 0°=up(-Y), 90°=right(+X), 180°=down(+Y), 270°=left(-X)
  const angleRad = Math.atan2(dx, -dy)
  const tangentAngleDeg = ((angleRad * 180) / Math.PI + 360) % 360

  return { position, tangentAngleDeg, tangentVec }
}

// ─── Snap a world-space point onto the path ──────────────────

/**
 * Projects a query point onto the nearest location on the polyline path.
 * Used to constrain drag operations to the path curve.
 */
export function snapToPath(points: Point[], queryPoint: Point): SnapResult {
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
  let bestPoint: Point = points[0]
  let bestSeg = 0

  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]
    const b = points[i + 1]
    const abx = b.x - a.x
    const aby = b.y - a.y
    const abLenSq = abx * abx + aby * aby
    if (abLenSq === 0) continue

    // Project queryPoint onto segment [a, b], clamped to [0, 1]
    const apx = queryPoint.x - a.x
    const apy = queryPoint.y - a.y
    const localT = Math.max(0, Math.min(1, (apx * abx + apy * aby) / abLenSq))

    const proj: Point = { x: a.x + abx * localT, y: a.y + aby * localT }
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

// ─── Uniform spacing (existing behavior) ─────────────────────

export function uniformTValues(count: number): number[] {
  if (count <= 0) return []
  if (count === 1) return [0.5]
  return Array.from({ length: count }, (_, i) => i / (count - 1))
}
