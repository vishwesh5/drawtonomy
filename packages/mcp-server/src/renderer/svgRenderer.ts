// Standalone SVG renderer for drawtonomy shapes
// Editor-independent: resolves point references via shape map

import type { BaseShape } from '../scene/sceneBuilder.js'
import { VEHICLE_TEMPLATES, PEDESTRIAN_TEMPLATES } from '../scene/svgTemplates.js'

// Color resolution (subset of useLaneColor.ts)
const COLOR_MAP: Record<string, string> = {
  black: '#000000',
  white: '#ffffff',
  red: '#EF4444',
  blue: '#2563EB',
  green: '#22C55E',
  yellow: '#EAB308',
  orange: '#F97316',
  purple: '#A855F7',
  pink: '#EC4899',
  grey: '#808080',
  'grey-100': '#e6e6e6',
  'grey-200': '#cccccc',
  'grey-300': '#b3b3b3',
  'grey-400': '#999999',
  'grey-500': '#808080',
  'grey-600': '#666666',
  'grey-700': '#4d4d4d',
  'grey-800': '#333333',
  'grey-900': '#1a1a1a',
  default: '#cccccc',
}

function resolveColor(color: string): string {
  if (color.startsWith('#')) return color
  if (color.startsWith('c-')) return '#' + color.slice(2)
  return COLOR_MAP[color] ?? COLOR_MAP['grey-500']
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

interface Bounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
  width: number
  height: number
}

function calculateBounds(shapes: BaseShape[], pointMap: Map<string, { x: number; y: number }>): Bounds {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity

  for (const shape of shapes) {
    if (shape.type === 'point') continue // skip points from bounds

    if (shape.type === 'linestring' || shape.type === 'lane') {
      // For linestring/lane, compute bounds from referenced points
      const pointIds = (shape.props as any).pointIds as string[] | undefined
      if (pointIds) {
        for (const pid of pointIds) {
          const pt = pointMap.get(pid)
          if (pt) {
            minX = Math.min(minX, pt.x)
            minY = Math.min(minY, pt.y)
            maxX = Math.max(maxX, pt.x)
            maxY = Math.max(maxY, pt.y)
          }
        }
      }
      // For lane, also check boundary linestrings' points
      if (shape.type === 'lane') {
        const leftId = (shape.props as any).leftBoundaryId as string
        const rightId = (shape.props as any).rightBoundaryId as string
        for (const lsId of [leftId, rightId]) {
          const ls = shapes.find(s => s.id === lsId)
          if (ls) {
            const pids = (ls.props as any).pointIds as string[]
            for (const pid of pids) {
              const pt = pointMap.get(pid)
              if (pt) {
                minX = Math.min(minX, pt.x)
                minY = Math.min(minY, pt.y)
                maxX = Math.max(maxX, pt.x)
                maxY = Math.max(maxY, pt.y)
              }
            }
          }
        }
      }
    } else {
      // Self-contained shapes: use x, y and size
      const w = (shape.props as any).w ?? 0
      const h = (shape.props as any).h ?? 0
      const halfW = w / 2
      const halfH = h / 2
      minX = Math.min(minX, shape.x - halfW)
      minY = Math.min(minY, shape.y - halfH)
      maxX = Math.max(maxX, shape.x + halfW)
      maxY = Math.max(maxY, shape.y + halfH)
    }
  }

  if (minX === Infinity) {
    return { minX: 0, minY: 0, maxX: 100, maxY: 100, width: 100, height: 100 }
  }

  return {
    minX, minY, maxX, maxY,
    width: maxX - minX,
    height: maxY - minY,
  }
}

// Render order (matching Canvas.tsx z-order)
const RENDER_ORDER: Record<string, number> = {
  lane: 0,
  image: 250,
  polygon: 500,
  freehand: 600,
  linestring: 1000,
  crosswalk: 1500,
  point: 2500,
  pedestrian: 3000,
  vehicle: 4000,
  traffic_light: 5000,
  text: 5500,
  rectangle: 500,
  ellipse: 500,
  arrow: 1000,
}

function getShapeSvg(
  shape: BaseShape,
  offsetX: number,
  offsetY: number,
  pointMap: Map<string, { x: number; y: number }>,
  shapeMap: Map<string, BaseShape>,
): string {
  const x = shape.x - offsetX
  const y = shape.y - offsetY
  const props = shape.props as any
  const rotation = shape.rotation ?? 0

  switch (shape.type) {
    case 'point':
      return '' // Points are not rendered

    case 'linestring': {
      const pointIds: string[] = props.pointIds ?? []
      if (pointIds.length < 2) return ''
      const points = pointIds
        .map(id => pointMap.get(id))
        .filter((p): p is { x: number; y: number } => p !== null && p !== undefined)
      if (points.length < 2) return ''

      const color = resolveColor(props.color ?? 'black')
      const strokeWidth = props.strokeWidth ?? 2
      const opacity = props.opacity ?? 1
      const subtype = props.attributes?.subtype ?? 'solid'
      const dashArray = subtype === 'dashed' ? ` stroke-dasharray="${strokeWidth * 3} ${strokeWidth * 2}"` : ''

      const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x - offsetX} ${p.y - offsetY}`).join(' ')
      let svg = `<path d="${d}" fill="none" stroke="${color}" stroke-width="${strokeWidth}" opacity="${opacity}"${dashArray} stroke-linecap="round" stroke-linejoin="round"/>`

      // Arrow head
      if (props.isPath && props.arrowHead === 'end' && points.length >= 2) {
        const last = points[points.length - 1]
        const prev = points[points.length - 2]
        const angle = Math.atan2(last.y - prev.y, last.x - prev.x)
        const size = props.arrowHeadSize ?? 15
        const lx = last.x - offsetX
        const ly = last.y - offsetY
        const ax1 = lx - size * Math.cos(angle - Math.PI / 6)
        const ay1 = ly - size * Math.sin(angle - Math.PI / 6)
        const ax2 = lx - size * Math.cos(angle + Math.PI / 6)
        const ay2 = ly - size * Math.sin(angle + Math.PI / 6)
        svg += `<polygon points="${lx},${ly} ${ax1},${ay1} ${ax2},${ay2}" fill="${color}" opacity="${opacity}"/>`
      }

      return svg
    }

    case 'lane': {
      const leftId = props.leftBoundaryId as string
      const rightId = props.rightBoundaryId as string
      const leftLs = shapeMap.get(leftId)
      const rightLs = shapeMap.get(rightId)
      if (!leftLs || !rightLs) return ''

      const leftPointIds: string[] = (leftLs.props as any).pointIds ?? []
      const rightPointIds: string[] = (rightLs.props as any).pointIds ?? []

      const leftPoints = leftPointIds
        .map(id => pointMap.get(id))
        .filter((p): p is { x: number; y: number } => !!p)
      const rightPoints = rightPointIds
        .map(id => pointMap.get(id))
        .filter((p): p is { x: number; y: number } => !!p)

      if (leftPoints.length < 2 || rightPoints.length < 2) return ''

      const laneColor = resolveColor(props.color ?? 'default')
      const opacity = props.opacity ?? 0.3

      // Build polygon: left points forward + right points reversed
      const polyPoints = [
        ...leftPoints.map(p => `${p.x - offsetX},${p.y - offsetY}`),
        ...rightPoints.reverse().map(p => `${p.x - offsetX},${p.y - offsetY}`),
      ].join(' ')

      let svg = `<polygon points="${polyPoints}" fill="${laneColor}" opacity="${opacity}" stroke="none"/>`

      // Draw boundaries
      const boundaryColor = '#666666'
      const leftD = leftPoints.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x - offsetX} ${p.y - offsetY}`).join(' ')
      const rightD = rightPoints.reverse().map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x - offsetX} ${p.y - offsetY}`).join(' ')
      svg += `<path d="${leftD}" fill="none" stroke="${boundaryColor}" stroke-width="2" stroke-linecap="round"/>`
      svg += `<path d="${rightD}" fill="none" stroke="${boundaryColor}" stroke-width="2" stroke-linecap="round"/>`

      return svg
    }

    case 'vehicle': {
      const w = props.w ?? 30
      const h = props.h ?? 56
      const color = resolveColor(props.color ?? 'black')
      const templateId = props.templateId ?? 'sedan'
      // Fallback to 'sedan' if template not found
      const template = VEHICLE_TEMPLATES[templateId] ?? VEHICLE_TEMPLATES['sedan']

      if (template) {
        const transform = rotation !== 0
          ? `translate(${x}, ${y}) rotate(${rotation})`
          : `translate(${x}, ${y})`
        return `<g transform="${transform}"><svg x="${-w / 2}" y="${-h / 2}" width="${w}" height="${h}" viewBox="${template.viewBox}" preserveAspectRatio="none" fill="${color}">${template.paths}</svg></g>`
      }

      // Fallback: simple rectangle
      const transform = rotation !== 0
        ? `translate(${x}, ${y}) rotate(${rotation})`
        : `translate(${x}, ${y})`
      return `<g transform="${transform}"><rect x="${-w / 2}" y="${-h / 2}" width="${w}" height="${h}" fill="${color}" rx="3"/></g>`
    }

    case 'pedestrian': {
      const w = props.w ?? 22
      const h = props.h ?? 22
      const color = resolveColor(props.color ?? 'black')
      const templateId = props.templateId ?? 'filled'
      // Fallback to 'filled' if template not found (e.g. 'walking', 'person', etc.)
      const template = PEDESTRIAN_TEMPLATES[templateId] ?? PEDESTRIAN_TEMPLATES['filled']

      if (template) {
        const transform = rotation !== 0
          ? `translate(${x}, ${y}) rotate(${rotation})`
          : `translate(${x}, ${y})`
        return `<g transform="${transform}"><svg x="${-w / 2}" y="${-h / 2}" width="${w}" height="${h}" viewBox="${template.viewBox}" preserveAspectRatio="none" fill="${color}">${template.paths}</svg></g>`
      }

      // Fallback: circle
      return `<circle cx="${x}" cy="${y}" r="${w / 2}" fill="${color}"/>`
    }

    case 'text': {
      const color = resolveColor(props.color ?? 'black')
      const fontSize = props.fontSize ?? 20
      const text = escapeXml(props.text ?? '')
      return `<text x="${x}" y="${y}" fill="${color}" font-size="${fontSize}" font-family="Arial, sans-serif" dominant-baseline="middle">${text}</text>`
    }

    case 'rectangle': {
      const w = props.w ?? 50
      const h = props.h ?? 50
      const color = resolveColor(props.color ?? 'black')
      const fill = props.fill === 'none' ? 'none' : resolveColor(props.fill ?? 'none')
      const strokeWidth = props.strokeWidth ?? 2
      const transform = rotation !== 0
        ? `translate(${x}, ${y}) rotate(${rotation})`
        : `translate(${x}, ${y})`
      return `<g transform="${transform}"><rect x="${-w / 2}" y="${-h / 2}" width="${w}" height="${h}" fill="${fill}" stroke="${color}" stroke-width="${strokeWidth}"/></g>`
    }

    case 'ellipse': {
      const w = props.w ?? 50
      const h = props.h ?? 50
      const color = resolveColor(props.color ?? 'black')
      const fill = props.fill === 'none' ? 'none' : resolveColor(props.fill ?? 'none')
      const strokeWidth = props.strokeWidth ?? 2
      const transform = rotation !== 0
        ? `translate(${x}, ${y}) rotate(${rotation})`
        : `translate(${x}, ${y})`
      return `<g transform="${transform}"><ellipse cx="0" cy="0" rx="${w / 2}" ry="${h / 2}" fill="${fill}" stroke="${color}" stroke-width="${strokeWidth}"/></g>`
    }

    default:
      return ''
  }
}

export function renderShapesToSvg(shapes: BaseShape[], options?: {
  padding?: number
  background?: boolean
  backgroundColor?: string
}): string {
  const padding = options?.padding ?? 20
  const background = options?.background ?? true
  const backgroundColor = options?.backgroundColor ?? '#ffffff'

  // Build point map for resolving references
  const pointMap = new Map<string, { x: number; y: number }>()
  const shapeMap = new Map<string, BaseShape>()
  for (const shape of shapes) {
    shapeMap.set(shape.id, shape)
    if (shape.type === 'point') {
      pointMap.set(shape.id, { x: shape.x, y: shape.y })
    }
  }

  const bounds = calculateBounds(shapes, pointMap)
  const svgWidth = Math.ceil(bounds.width + padding * 2)
  const svgHeight = Math.ceil(bounds.height + padding * 2)
  const offsetX = bounds.minX - padding
  const offsetY = bounds.minY - padding

  // Sort by render order
  const sorted = [...shapes].sort((a, b) => {
    const orderA = RENDER_ORDER[a.type] ?? 1000
    const orderB = RENDER_ORDER[b.type] ?? 1000
    return orderA - orderB
  })

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}" viewBox="0 0 ${svgWidth} ${svgHeight}">`

  if (background) {
    svg += `<rect width="${svgWidth}" height="${svgHeight}" fill="${backgroundColor}"/>`
  }

  for (const shape of sorted) {
    svg += getShapeSvg(shape, offsetX, offsetY, pointMap, shapeMap)
  }

  svg += '</svg>'
  return svg
}
