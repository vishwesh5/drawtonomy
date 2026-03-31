import { describe, it, expect } from 'vitest'
import {
  computeArcLengths,
  totalArcLength,
  evaluatePathAt,
  snapToPath,
  uniformTValues,
  computeHeadings,
  interpolatePosition,
  getBoundingBox,
  distanceToSegment,
} from '../src/geometry'

describe('computeArcLengths', () => {
  it('returns empty for empty input', () => {
    expect(computeArcLengths([])).toEqual([])
  })

  it('returns [0] for single point', () => {
    expect(computeArcLengths([{ x: 0, y: 0 }])).toEqual([0])
  })

  it('computes cumulative lengths for horizontal line', () => {
    const points = [{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 7, y: 0 }]
    const lengths = computeArcLengths(points)
    expect(lengths[0]).toBe(0)
    expect(lengths[1]).toBe(3)
    expect(lengths[2]).toBe(7)
  })

  it('computes diagonal distance', () => {
    const points = [{ x: 0, y: 0 }, { x: 3, y: 4 }]
    const lengths = computeArcLengths(points)
    expect(lengths[1]).toBe(5)
  })
})

describe('totalArcLength', () => {
  it('returns 0 for less than 2 points', () => {
    expect(totalArcLength([])).toBe(0)
    expect(totalArcLength([{ x: 0, y: 0 }])).toBe(0)
  })

  it('returns total path length', () => {
    const points = [{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 4 }]
    expect(totalArcLength(points)).toBe(7)
  })
})

describe('evaluatePathAt', () => {
  const line = [{ x: 0, y: 0 }, { x: 100, y: 0 }]

  it('returns start at t=0', () => {
    const result = evaluatePathAt(line, 0)
    expect(result.position.x).toBe(0)
    expect(result.position.y).toBe(0)
  })

  it('returns end at t=1', () => {
    const result = evaluatePathAt(line, 1)
    expect(result.position.x).toBe(100)
    expect(result.position.y).toBe(0)
  })

  it('returns midpoint at t=0.5', () => {
    const result = evaluatePathAt(line, 0.5)
    expect(result.position.x).toBe(50)
    expect(result.position.y).toBe(0)
  })

  it('clamps t to [0,1]', () => {
    const r1 = evaluatePathAt(line, -0.5)
    expect(r1.position.x).toBe(0)
    const r2 = evaluatePathAt(line, 1.5)
    expect(r2.position.x).toBe(100)
  })

  it('computes tangent angle for rightward path', () => {
    const result = evaluatePathAt(line, 0.5)
    // rightward (+X) = 90 degrees
    expect(result.tangentAngleDeg).toBeCloseTo(90, 0)
  })

  it('computes tangent angle for downward path', () => {
    const downward = [{ x: 0, y: 0 }, { x: 0, y: 100 }]
    const result = evaluatePathAt(downward, 0.5)
    // downward (+Y) = 180 degrees
    expect(result.tangentAngleDeg).toBeCloseTo(180, 0)
  })

  it('works with multi-segment path', () => {
    const path = [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }]
    // total length = 100, t=0.5 = 50px = end of first segment
    const result = evaluatePathAt(path, 0.5)
    expect(result.position.x).toBeCloseTo(50, 0)
    expect(result.position.y).toBeCloseTo(0, 0)
  })

  it('returns fallback for single point', () => {
    const result = evaluatePathAt([{ x: 42, y: 99 }], 0.5)
    expect(result.position.x).toBe(42)
    expect(result.position.y).toBe(99)
  })
})

describe('snapToPath', () => {
  const line = [{ x: 0, y: 0 }, { x: 100, y: 0 }]

  it('snaps point on the line to t=0.5', () => {
    const result = snapToPath(line, { x: 50, y: 0 })
    expect(result.t).toBeCloseTo(0.5, 2)
    expect(result.distance).toBeCloseTo(0, 1)
  })

  it('snaps point above the line', () => {
    const result = snapToPath(line, { x: 50, y: 30 })
    expect(result.t).toBeCloseTo(0.5, 2)
    expect(result.snappedPoint.x).toBeCloseTo(50, 1)
    expect(result.snappedPoint.y).toBeCloseTo(0, 1)
    expect(result.distance).toBeCloseTo(30, 1)
  })

  it('clamps to start', () => {
    const result = snapToPath(line, { x: -50, y: 0 })
    expect(result.t).toBeCloseTo(0, 2)
  })

  it('clamps to end', () => {
    const result = snapToPath(line, { x: 150, y: 0 })
    expect(result.t).toBeCloseTo(1, 2)
  })

  it('works with multi-segment path', () => {
    const path = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }]
    const result = snapToPath(path, { x: 100, y: 50 })
    expect(result.snappedPoint.x).toBeCloseTo(100, 1)
    expect(result.snappedPoint.y).toBeCloseTo(50, 1)
    expect(result.t).toBeCloseTo(0.75, 1)
  })
})

describe('uniformTValues', () => {
  it('returns empty for count 0', () => {
    expect(uniformTValues(0)).toEqual([])
  })

  it('returns [0.5] for count 1', () => {
    expect(uniformTValues(1)).toEqual([0.5])
  })

  it('returns [0, 1] for count 2', () => {
    expect(uniformTValues(2)).toEqual([0, 1])
  })

  it('returns evenly spaced values', () => {
    const values = uniformTValues(5)
    expect(values).toEqual([0, 0.25, 0.5, 0.75, 1])
  })
})

describe('computeHeadings', () => {
  it('returns headings for each point', () => {
    const points = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }]
    const headings = computeHeadings(points)
    expect(headings.length).toBe(3)
    expect(headings[0]).toBeCloseTo(90, 0) // rightward
  })

  it('returns 0 for single point', () => {
    expect(computeHeadings([{ x: 0, y: 0 }])).toEqual([0])
  })
})

describe('interpolatePosition', () => {
  it('returns p1 at t=0', () => {
    const result = interpolatePosition({ x: 0, y: 0 }, { x: 100, y: 100 }, 0)
    expect(result.x).toBe(0)
    expect(result.y).toBe(0)
  })

  it('returns p2 at t=1', () => {
    const result = interpolatePosition({ x: 0, y: 0 }, { x: 100, y: 100 }, 1)
    expect(result.x).toBe(100)
    expect(result.y).toBe(100)
  })

  it('returns midpoint at t=0.5', () => {
    const result = interpolatePosition({ x: 0, y: 0 }, { x: 100, y: 100 }, 0.5)
    expect(result.x).toBe(50)
    expect(result.y).toBe(50)
  })
})

describe('getBoundingBox', () => {
  it('returns zero box for empty input', () => {
    expect(getBoundingBox([])).toEqual({ x: 0, y: 0, width: 0, height: 0 })
  })

  it('computes correct bounds', () => {
    const points = [{ x: 10, y: 20 }, { x: 50, y: 80 }, { x: 30, y: 40 }]
    const box = getBoundingBox(points)
    expect(box.x).toBe(10)
    expect(box.y).toBe(20)
    expect(box.width).toBe(40)
    expect(box.height).toBe(60)
  })
})

describe('distanceToSegment', () => {
  it('returns 0 for point on segment', () => {
    expect(distanceToSegment({ x: 50, y: 0 }, { x: 0, y: 0 }, { x: 100, y: 0 })).toBeCloseTo(0, 5)
  })

  it('returns perpendicular distance', () => {
    expect(distanceToSegment({ x: 50, y: 30 }, { x: 0, y: 0 }, { x: 100, y: 0 })).toBeCloseTo(30, 5)
  })

  it('returns distance to endpoint when projection is outside', () => {
    const dist = distanceToSegment({ x: -10, y: 0 }, { x: 0, y: 0 }, { x: 100, y: 0 })
    expect(dist).toBeCloseTo(10, 5)
  })

  it('handles zero-length segment', () => {
    const dist = distanceToSegment({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 })
    expect(dist).toBeCloseTo(5, 5)
  })
})
