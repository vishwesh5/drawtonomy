// SDK Helpers - Factory functions for creating shapes
import type {
  BaseShape,
  PointProps,
  LinestringProps,
  LaneProps,
  VehicleProps,
  PedestrianProps,
  RectangleProps,
  EllipseProps,
  TextProps,
  DrawtonomySnapshot,
  FootprintEntry,
} from './types'

let idCounter = 0

function nextId(prefix = 'ext'): string {
  return `${prefix}_${++idCounter}_${Date.now().toString(36)}`
}

export function resetIdCounter() {
  idCounter = 0
}

// --- Point ---

export function createPoint(
  x: number,
  y: number,
  options?: Partial<PointProps> & { id?: string }
): BaseShape<'point', PointProps> {
  return {
    id: options?.id ?? nextId('pt'),
    type: 'point',
    x,
    y,
    rotation: 0,
    zIndex: 0,
    props: {
      color: options?.color ?? 'black',
      visible: options?.visible ?? true,
      osmId: options?.osmId ?? '',
    },
  }
}

// --- Linestring ---

export function createLinestring(
  x: number,
  y: number,
  pointIds: string[],
  options?: Partial<LinestringProps> & { id?: string }
): BaseShape<'linestring', LinestringProps> {
  return {
    id: options?.id ?? nextId('ls'),
    type: 'linestring',
    x,
    y,
    rotation: 0,
    zIndex: 0,
    props: {
      pointIds,
      color: options?.color ?? 'black',
      strokeWidth: options?.strokeWidth ?? 2,
      attributes: options?.attributes ?? { type: 'linestring', subtype: 'solid' },
      osmId: options?.osmId ?? '',
    },
  }
}

// --- Lane ---

export function createLane(
  x: number,
  y: number,
  leftBoundaryId: string,
  rightBoundaryId: string,
  options?: Partial<LaneProps> & { id?: string }
): BaseShape<'lane', LaneProps> {
  return {
    id: options?.id ?? nextId('lane'),
    type: 'lane',
    x,
    y,
    rotation: 0,
    zIndex: 0,
    props: {
      leftBoundaryId,
      rightBoundaryId,
      invertLeft: options?.invertLeft ?? false,
      invertRight: options?.invertRight ?? false,
      color: options?.color ?? 'default',
      size: options?.size ?? 'm',
      attributes: options?.attributes ?? { type: 'lanelet', subtype: 'road', speed_limit: '30' },
      next: options?.next ?? [],
      prev: options?.prev ?? [],
      osmId: options?.osmId ?? '',
    },
  }
}

// --- Lane with boundaries (convenience) ---

export interface LaneWithBoundariesOptions {
  laneOptions?: Partial<LaneProps> & { id?: string }
  leftOptions?: Partial<LinestringProps> & { id?: string }
  rightOptions?: Partial<LinestringProps> & { id?: string }
}

export function createLaneWithBoundaries(
  leftPoints: Array<{ x: number; y: number }>,
  rightPoints: Array<{ x: number; y: number }>,
  options?: LaneWithBoundariesOptions
): BaseShape<string, any>[] {
  const shapes: BaseShape<string, any>[] = []

  const leftPointIds: string[] = []
  for (const pt of leftPoints) {
    const point = createPoint(pt.x, pt.y)
    leftPointIds.push(point.id)
    shapes.push(point)
  }

  const rightPointIds: string[] = []
  for (const pt of rightPoints) {
    const point = createPoint(pt.x, pt.y)
    rightPointIds.push(point.id)
    shapes.push(point)
  }

  const leftLs = createLinestring(0, 0, leftPointIds, options?.leftOptions)
  const rightLs = createLinestring(0, 0, rightPointIds, options?.rightOptions)
  shapes.push(leftLs)
  shapes.push(rightLs)

  const lane = createLane(0, 0, leftLs.id, rightLs.id, options?.laneOptions)
  shapes.push(lane)

  return shapes
}

// --- Vehicle ---

export function createVehicle(
  x: number,
  y: number,
  options?: Partial<VehicleProps> & { id?: string }
): BaseShape<'vehicle', VehicleProps> {
  return {
    id: options?.id ?? nextId('veh'),
    type: 'vehicle',
    x,
    y,
    rotation: options?.templateId ? 0 : 0,
    zIndex: 0,
    props: {
      w: options?.w ?? 30,
      h: options?.h ?? 56,
      color: options?.color ?? 'black',
      size: options?.size ?? 'm',
      attributes: options?.attributes ?? { type: 'vehicle', subtype: 'car' },
      osmId: options?.osmId ?? '',
      templateId: options?.templateId ?? 'default',
    },
  }
}

// --- Pedestrian ---

export function createPedestrian(
  x: number,
  y: number,
  options?: Partial<PedestrianProps> & { id?: string }
): BaseShape<'pedestrian', PedestrianProps> {
  return {
    id: options?.id ?? nextId('ped'),
    type: 'pedestrian',
    x,
    y,
    rotation: 0,
    zIndex: 0,
    props: {
      w: options?.w ?? 22,
      h: options?.h ?? 22,
      color: options?.color ?? 'black',
      size: options?.size ?? 'm',
      attributes: options?.attributes ?? { type: 'pedestrian', subtype: 'person' },
      osmId: options?.osmId ?? '',
      templateId: options?.templateId ?? 'filled',
    },
  }
}

// --- Rectangle ---

export function createRectangle(
  x: number,
  y: number,
  w: number,
  h: number,
  options?: Partial<RectangleProps> & { id?: string }
): BaseShape<'rectangle', RectangleProps> {
  return {
    id: options?.id ?? nextId('rect'),
    type: 'rectangle',
    x,
    y,
    rotation: 0,
    zIndex: 0,
    props: {
      w,
      h,
      color: options?.color ?? '#000000',
      fill: options?.fill ?? 'none',
      strokeWidth: options?.strokeWidth ?? 2,
    },
  }
}

// --- Ellipse ---

export function createEllipse(
  x: number,
  y: number,
  w: number,
  h: number,
  options?: Partial<EllipseProps> & { id?: string }
): BaseShape<'ellipse', EllipseProps> {
  return {
    id: options?.id ?? nextId('ell'),
    type: 'ellipse',
    x,
    y,
    rotation: 0,
    zIndex: 0,
    props: {
      w,
      h,
      color: options?.color ?? '#000000',
      fill: options?.fill ?? 'none',
      strokeWidth: options?.strokeWidth ?? 2,
    },
  }
}

// --- Text ---

export function createText(
  x: number,
  y: number,
  text: string,
  options?: Partial<TextProps> & { id?: string }
): BaseShape<'text', TextProps> {
  return {
    id: options?.id ?? nextId('txt'),
    type: 'text',
    x,
    y,
    rotation: 0,
    zIndex: 0,
    props: {
      w: options?.w ?? 200,
      h: options?.h ?? 32,
      text,
      color: options?.color ?? 'black',
      fontSize: options?.fontSize ?? 20,
      font: options?.font ?? 'sans',
      textAlign: options?.textAlign ?? 'left',
      autoSize: options?.autoSize ?? true,
    },
  }
}

// --- Snapshot ---

export function createSnapshot(shapes: BaseShape[]): DrawtonomySnapshot {
  return {
    version: '1.1',
    timestamp: new Date().toISOString(),
    shapes,
  }
}

// ─── NEW: Path with variable-position footprints ─────────────

export interface PathWithFootprintsOptions {
  /** 'uniform' (default) or 'variable' */
  mode?: 'uniform' | 'variable'
  /** Number of footprints for uniform mode (default: 5) */
  count?: number
  /** Explicit footprint positions for variable mode */
  footprints?: Array<{
    t: number
    label?: string
    templateOverride?: string
    colorOverride?: string
  }>
  /** Default vehicle template (default: 'sedan') */
  template?: string
  /** Path and footprint color (default: 'green') */
  color?: string
  /** Path stroke width (default: 3) */
  strokeWidth?: number
  /** Dashed line (default: true) */
  dashed?: boolean
  /** Arrow at path end (default: true) */
  arrowHead?: boolean
  /** Anchor offset along travel direction (default: 0) */
  anchorOffset?: number
}

/**
 * Create a path linestring pre-configured with variable-position footprint data.
 *
 * The footprint entries are stored in the path's props — the host renderer
 * reads them and creates the visual footprint shapes at render time.
 *
 * @returns Array of shapes: points first, then the path linestring.
 */
export function createPathWithFootprints(
  pathPoints: Array<{ x: number; y: number }>,
  options?: PathWithFootprintsOptions
): BaseShape[] {
  const shapes: BaseShape[] = []
  const mode = options?.mode ?? 'uniform'

  // Create path vertex points
  const ptShapes = pathPoints.map(p => createPoint(p.x, p.y, { visible: true, osmId: 'n0' }))
  shapes.push(...ptShapes)

  // Create the path linestring
  const pathLs = createLinestring(0, 0, ptShapes.map(p => p.id), {
    color: options?.color ?? 'green',
    strokeWidth: options?.strokeWidth ?? 3,
    attributes: {
      type: 'linestring',
      subtype: options?.dashed !== false ? 'dashed' : 'solid',
    },
  })

  // Set path-specific rendering props
  const props = pathLs.props as any
  props.isPath = true
  if (options?.arrowHead !== false) {
    props.arrowHead = 'end'
    props.arrowHeadSize = 15
  }
  props.opacity = 0.85

  // Set footprint configuration on the path
  props.footprintMode = mode
  props.footprintTemplate = options?.template ?? 'sedan'
  props.footprintColor = options?.color ?? 'green'
  props.footprintAnchorOffset = options?.anchorOffset ?? 0

  if (mode === 'uniform') {
    props.footprintCount = options?.count ?? 5
  } else if (mode === 'variable' && options?.footprints) {
    props.footprints = options.footprints.map((fp, i): FootprintEntry => ({
      id: `fp_${i}_${Date.now().toString(36)}`,
      t: fp.t,
      label: fp.label,
      templateOverride: fp.templateOverride,
      colorOverride: fp.colorOverride,
    }))
  }

  shapes.push(pathLs)
  return shapes
}
