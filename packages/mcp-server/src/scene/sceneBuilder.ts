// SceneSpec → BaseShape[] conversion
// Ported from ai-scene-generator/src/sceneGenerator.ts (buildShapesFromSpec)

import type { SceneSpec } from './sceneSpec.js'

// Inline shape types and factory functions to avoid @drawtonomy/sdk dependency
// (SDK is designed for browser extension use, not Node.js MCP server)

export interface BaseShape {
  id: string
  type: string
  x: number
  y: number
  rotation: number
  zIndex: number
  props: Record<string, unknown>
}

let idCounter = 0

function nextId(prefix: string): string {
  return `${prefix}_${++idCounter}_${Date.now().toString(36)}`
}

export function resetIdCounter(): void {
  idCounter = 0
}

function createPoint(x: number, y: number): BaseShape {
  return {
    id: nextId('pt'),
    type: 'point',
    x, y, rotation: 0, zIndex: 0,
    props: { color: 'black', visible: true, osmId: '' },
  }
}

function createLinestring(x: number, y: number, pointIds: string[], options?: {
  color?: string; strokeWidth?: number; attributes?: { type: string; subtype: string }
}): BaseShape {
  return {
    id: nextId('ls'),
    type: 'linestring',
    x, y, rotation: 0, zIndex: 0,
    props: {
      pointIds,
      color: options?.color ?? 'black',
      strokeWidth: options?.strokeWidth ?? 2,
      attributes: options?.attributes ?? { type: 'linestring', subtype: 'solid' },
      osmId: '',
    },
  }
}

function createLane(x: number, y: number, leftId: string, rightId: string, options?: {
  attributes?: { type: string; subtype: string; speed_limit?: string }
}): BaseShape {
  return {
    id: nextId('lane'),
    type: 'lane',
    x, y, rotation: 0, zIndex: 0,
    props: {
      leftBoundaryId: leftId,
      rightBoundaryId: rightId,
      invertLeft: false,
      invertRight: false,
      color: 'default',
      size: 'm',
      attributes: options?.attributes ?? { type: 'lanelet', subtype: 'road', speed_limit: '30' },
      next: [],
      prev: [],
      osmId: '',
    },
  }
}

function createVehicle(x: number, y: number, options?: {
  w?: number; h?: number; templateId?: string; color?: string
  attributes?: { type: string; subtype: string }
}): BaseShape {
  return {
    id: nextId('veh'),
    type: 'vehicle',
    x, y, rotation: 0, zIndex: 0,
    props: {
      w: options?.w ?? 90,
      h: options?.h ?? 45,
      color: options?.color ?? 'black',
      size: 'm',
      attributes: options?.attributes ?? { type: 'vehicle', subtype: 'car' },
      osmId: '',
      templateId: options?.templateId ?? 'default',
    },
  }
}

function createPedestrian(x: number, y: number, options?: {
  templateId?: string; color?: string
}): BaseShape {
  return {
    id: nextId('ped'),
    type: 'pedestrian',
    x, y, rotation: 0, zIndex: 0,
    props: {
      w: 22, h: 22,
      color: options?.color ?? 'black',
      size: 'm',
      attributes: { type: 'pedestrian', subtype: 'person' },
      osmId: '',
      templateId: options?.templateId ?? 'filled',
    },
  }
}

function createText(x: number, y: number, text: string, options?: {
  color?: string; fontSize?: number
}): BaseShape {
  return {
    id: nextId('txt'),
    type: 'text',
    x, y, rotation: 0, zIndex: 0,
    props: {
      w: 200, h: 32,
      text,
      color: options?.color ?? 'black',
      fontSize: options?.fontSize ?? 20,
      font: 'sans',
      textAlign: 'left',
      autoSize: true,
    },
  }
}

// Vehicle size map (same as ai-scene-generator)
const VSZ: Record<string, { w: number; h: number }> = {
  sedan: { w: 30, h: 56 },
  bus: { w: 37, h: 92 },
  truck: { w: 43, h: 147 },
  motorcycle: { w: 18, h: 36 },
  bicycle: { w: 18, h: 36 },
}

export function parseSceneSpec(text: string): SceneSpec {
  let j = text.trim()
  // Strip markdown fences
  const fm = j.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fm) j = fm[1].trim()
  // Extract JSON object
  const s = j.indexOf('{')
  const e = j.lastIndexOf('}')
  if (s !== -1 && e > s) j = j.slice(s, e + 1)
  return JSON.parse(j) as SceneSpec
}

export function buildShapesFromSpec(spec: SceneSpec): BaseShape[] {
  resetIdCounter()
  const shapes: BaseShape[] = []

  // Lanes — share boundary linestrings between adjacent lanes
  const boundaryCache = new Map<string, { points: BaseShape[]; linestring: BaseShape }>()
  function boundaryKey(pts: Array<{ x: number; y: number }>): string {
    return pts.map(p => `${p.x},${p.y}`).join('|')
  }
  function getOrCreateBoundary(pts: Array<{ x: number; y: number }>) {
    const key = boundaryKey(pts)
    const cached = boundaryCache.get(key)
    if (cached) return { ...cached, isNew: false }
    const points = pts.map(p => createPoint(p.x, p.y))
    const linestring = createLinestring(0, 0, points.map(p => p.id))
    boundaryCache.set(key, { points, linestring })
    return { points, linestring, isNew: true }
  }
  for (const l of spec.lanes ?? []) {
    if (!l.leftPoints?.length || l.leftPoints.length < 2 ||
        !l.rightPoints?.length || l.rightPoints.length < 2) continue
    const left = getOrCreateBoundary(l.leftPoints)
    const right = getOrCreateBoundary(l.rightPoints)
    if (left.isNew) shapes.push(...left.points, left.linestring)
    if (right.isNew) shapes.push(...right.points, right.linestring)
    const ln = createLane(0, 0, left.linestring.id, right.linestring.id, {
      attributes: {
        type: 'lanelet',
        subtype: l.attributes?.subtype ?? 'road',
        speed_limit: l.attributes?.speed_limit ?? '30',
      },
    })
    shapes.push(ln)
  }

  // Vehicles
  for (const v of spec.vehicles ?? []) {
    const t = v.templateId ?? 'sedan'
    const sz = VSZ[t] ?? VSZ.sedan
    const vh = createVehicle(v.x, v.y, {
      templateId: t,
      color: v.color ?? 'black',
      attributes: {
        type: 'vehicle',
        subtype: t === 'bus' ? 'bus' : t === 'truck' ? 'truck' : t === 'motorcycle' ? 'motorcycle' : 'car',
      },
      ...sz,
    })
    vh.rotation = v.rotation ?? 0
    shapes.push(vh)
    if (v.label) {
      shapes.push(createText(v.x - 20, v.y - 40, v.label, { color: v.color ?? 'black', fontSize: 14 }))
    }
  }

  // Pedestrians
  for (const p of spec.pedestrians ?? []) {
    const pd = createPedestrian(p.x, p.y, { templateId: p.templateId ?? 'filled', color: p.color ?? 'black' })
    pd.rotation = p.rotation ?? 0
    shapes.push(pd)
    if (p.label) {
      shapes.push(createText(p.x - 20, p.y - 30, p.label, { color: p.color ?? 'black', fontSize: 12 }))
    }
  }

  // Annotations
  for (const a of spec.annotations ?? []) {
    shapes.push(createText(a.x, a.y, a.text, { color: a.color ?? 'black', fontSize: a.fontSize ?? 16 }))
  }

  // Paths
  for (const pt of spec.paths ?? []) {
    if (!pt.points || pt.points.length < 2) continue
    const ps = pt.points.map(p => createPoint(p.x, p.y))
    shapes.push(...ps)
    const ls = createLinestring(0, 0, ps.map(p => p.id), {
      color: pt.color ?? 'green',
      strokeWidth: pt.strokeWidth ?? 3,
      attributes: { type: 'linestring', subtype: pt.dashed ? 'dashed' : 'solid' },
    })
    if (pt.arrowHead !== false) {
      ls.props.isPath = true
      ls.props.arrowHead = 'end'
      ls.props.arrowHeadSize = 15
    }
    ls.props.opacity = 0.85
    shapes.push(ls)
    if (pt.label) {
      const m = Math.floor(pt.points.length / 2)
      shapes.push(createText(pt.points[m].x, pt.points[m].y - 15, pt.label, { color: pt.color ?? 'green', fontSize: 12 }))
    }
  }

  return shapes
}
