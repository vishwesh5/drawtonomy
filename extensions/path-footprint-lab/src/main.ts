// Path Footprint Lab — Multi-path scene orchestration
//
// Architecture: Scene model
//   Scene owns an ordered list of PathConfig entries.
//   Each PathConfig stores segments, temporal start offset, template, cached
//   display points, and computed participants (local t-values + local timestamps).
//   A GlobalTimeline merges all paths' participants by adding startOffsetSec,
//   producing a single sorted event list used for visualization and video recording.
//
// JSON import/export serializes the full scene (minus cached geometry).

// =============================================================================
// INLINE EXTENSION CLIENT
// =============================================================================

interface InitPayload {
  hostVersion: string
  grantedCapabilities: string[]
  viewport: { width: number; height: number }
}

interface BaseShape {
  id: string
  type: string
  x: number
  y: number
  rotation: number
  zIndex: number
  props: Record<string, any>
}

class ExtensionClient {
  private manifestId: string
  private initPromise: Promise<InitPayload>
  private initResolve!: (payload: InitPayload) => void
  private pendingRequests = new Map<string, { resolve: (v: unknown) => void; reject: (r: unknown) => void; timeout: ReturnType<typeof setTimeout> }>()
  private requestTimeout: number
  private requestIdCounter = 0

  constructor(manifestId: string, options?: { requestTimeout?: number }) {
    this.manifestId = manifestId
    this.requestTimeout = options?.requestTimeout ?? 30_000
    this.initPromise = new Promise(resolve => { this.initResolve = resolve })
    window.addEventListener('message', this.handleMessage.bind(this))
    this.send({ type: 'ext:ready', payload: { manifestId } })
  }

  async waitForInit(): Promise<InitPayload> { return this.initPromise }
  addShapes(shapes: BaseShape[]) { this.send({ type: 'ext:shapes-add', payload: { shapes } }) }
  updateShapes(updates: Array<{ id: string; props: Record<string, unknown> }>) { this.send({ type: 'ext:shapes-update', payload: { updates } }) }
  deleteShapes(ids: string[]) { this.send({ type: 'ext:shapes-delete', payload: { ids } }) }

  async requestShapes(filter?: { types?: string[]; ids?: string[]; selectedOnly?: boolean }): Promise<BaseShape[]> {
    const requestId = this.nextRequestId()
    this.send({ type: 'ext:shapes-request', payload: { requestId, filter } })
    return ((await this.waitForResponse(requestId)) as { shapes: BaseShape[] }).shapes
  }

  async requestSelection(): Promise<{ ids: string[] }> {
    const requestId = this.nextRequestId()
    this.send({ type: 'ext:selection-request', payload: { requestId } })
    return await this.waitForResponse(requestId) as { ids: string[] }
  }

  notify(message: string, level: 'info' | 'success' | 'error' = 'info') {
    this.send({ type: 'ext:notify', payload: { message, level } })
  }

  private send(message: unknown) { window.parent.postMessage(message, '*') }

  private handleMessage(event: MessageEvent) {
    const data = event.data
    if (!data || typeof data !== 'object' || typeof data.type !== 'string' || !data.type.startsWith('ext:')) return
    if (data.type === 'ext:init') { this.initResolve(data.payload); return }
    if (data.type === 'ext:error' && data.payload?.requestId) {
      const p = this.pendingRequests.get(data.payload.requestId)
      if (p) { clearTimeout(p.timeout); this.pendingRequests.delete(data.payload.requestId); p.reject(new Error(data.payload.message)) }
      return
    }
    const rid = data.payload?.requestId
    if (rid) {
      const p = this.pendingRequests.get(rid)
      if (p) { clearTimeout(p.timeout); this.pendingRequests.delete(rid); p.resolve(data.payload) }
    }
  }

  private nextRequestId(): string { return `${this.manifestId}_${++this.requestIdCounter}_${Date.now().toString(36)}` }

  private waitForResponse(rid: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { this.pendingRequests.delete(rid); reject(new Error(`Request ${rid} timed out`)) }, this.requestTimeout)
      this.pendingRequests.set(rid, { resolve, reject, timeout })
    })
  }
}


// =============================================================================
// GEOMETRY
// =============================================================================

interface Point2D { x: number; y: number }
interface PathEvalResult { position: Point2D; tangentAngleDeg: number; tangentVec: Point2D }

function computeArcLengths(points: Point2D[]): number[] {
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

function totalArcLength(points: Point2D[]): number {
  const arcs = computeArcLengths(points)
  return arcs.length > 0 ? arcs[arcs.length - 1] : 0
}

function evaluatePathAt(points: Point2D[], t: number): PathEvalResult {
  const fallback: PathEvalResult = { position: points[0] ?? { x: 0, y: 0 }, tangentAngleDeg: 0, tangentVec: { x: 0, y: -1 } }
  if (points.length < 2) return fallback
  const arcLengths = computeArcLengths(points)
  const totalLen = arcLengths[arcLengths.length - 1]
  if (totalLen === 0) return fallback
  const clampedT = Math.max(0, Math.min(1, t))
  const targetLen = clampedT * totalLen
  let lo = 0, hi = points.length - 2
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arcLengths[mid + 1] < targetLen) lo = mid + 1; else hi = mid }
  const segStart = points[lo], segEnd = points[lo + 1]
  const segLen = arcLengths[lo + 1] - arcLengths[lo]
  const localT = segLen > 0 ? (targetLen - arcLengths[lo]) / segLen : 0
  const position: Point2D = { x: segStart.x + (segEnd.x - segStart.x) * localT, y: segStart.y + (segEnd.y - segStart.y) * localT }
  const dx = segEnd.x - segStart.x, dy = segEnd.y - segStart.y
  const len = Math.sqrt(dx * dx + dy * dy)
  const tangentVec: Point2D = len > 0 ? { x: dx / len, y: dy / len } : { x: 0, y: -1 }
  const angleRad = Math.atan2(dx, -dy)
  const tangentAngleDeg = ((angleRad * 180) / Math.PI + 360) % 360
  return { position, tangentAngleDeg, tangentVec }
}


// =============================================================================
// SIMULATION ENGINE — Segment-based piecewise speed profiles
// =============================================================================

type SpeedUnit = 'km/h' | 'm/s' | 'mph'
type TimeUnit = 's' | 'min' | 'hr'

type SegmentMode = 'time' | 'percent'

interface SpeedSegment {
  mode: SegmentMode
  speed: number
  speedUnit: SpeedUnit
  // Time mode fields
  duration?: number
  durationUnit?: TimeUnit
  // Percent mode fields
  pathPercent?: number   // 0-100, percentage of path length this segment covers
}

function speedToMs(value: number, unit: SpeedUnit): number {
  switch (unit) {
    case 'km/h': return value / 3.6
    case 'm/s':  return value
    case 'mph':  return value * 0.44704
  }
}

function timeToSeconds(value: number, unit: TimeUnit): number {
  switch (unit) {
    case 's':   return value
    case 'min': return value * 60
    case 'hr':  return value * 3600
  }
}

function formatDuration(seconds: number): string {
  if (seconds < 1) return `${(seconds * 1000).toFixed(0)} ms`
  if (seconds < 60) return `${seconds.toFixed(1)} s`
  if (seconds < 3600) return `${(seconds / 60).toFixed(1)} min`
  return `${(seconds / 3600).toFixed(2)} hr`
}

function formatDistance(meters: number): string {
  if (meters < 1) return `${(meters * 100).toFixed(1)} cm`
  if (meters < 1000) return `${meters.toFixed(1)} m`
  return `${(meters / 1000).toFixed(2)} km`
}

function formatSpeed(speedMs: number): string {
  const kmh = speedMs * 3.6
  if (kmh < 1) return `${speedMs.toFixed(2)} m/s`
  return `${kmh.toFixed(1)} km/h`
}

interface SegmentComputed {
  speedMs: number; durationSec: number
  distanceM: number; timeStartSec: number
  cumulativeDistM: number   // cumulative distance at end of this segment
  coveragePct: number       // cumulative path coverage at end of this segment (0-100)
}

interface SimulationResult {
  tValues: number[]
  localTimestamps: number[]  // absolute local time for each participant
  totalParticipants: number
  totalDurationSec: number
  totalDistanceM: number
  pathCoverage: number       // 0-100, how much of the path is covered
  segmentsComputed: SegmentComputed[]
}

/**
 * Resolves a segment's distance and duration from its mode.
 * Time mode: distance = speed × time
 * Percent mode: distance = (pct/100) × pathLengthM, time = distance / speed
 */
function resolveSegment(seg: SpeedSegment, pathLengthM: number): { distanceM: number; durationSec: number; speedMs: number } | { error: string } {
  const speedMs = speedToMs(seg.speed, seg.speedUnit)
  if (speedMs <= 0) return { error: 'speed must be positive' }

  if (seg.mode === 'percent') {
    const pct = seg.pathPercent ?? 0
    if (pct <= 0 || pct > 100) return { error: 'path % must be between 0 and 100' }
    const distanceM = (pct / 100) * pathLengthM
    const durationSec = distanceM / speedMs
    return { distanceM, durationSec, speedMs }
  } else {
    const durationSec = timeToSeconds(seg.duration ?? 0, seg.durationUnit ?? 's')
    if (durationSec <= 0) return { error: 'duration must be positive' }
    const distanceM = speedMs * durationSec
    return { distanceM, durationSec, speedMs }
  }
}

/**
 * Piecewise speed profile → uniformly sampled positions.
 *
 * Segments define speed × (time | path%). Sampling is global via samplesPerSec.
 * Distances are normalized by pathLengthM, so t-values represent actual
 * position on the physical path. Coverage ≤ 100% is enforced.
 *
 * Pipeline:
 *   1. Resolve each segment's speed, duration, distance (handling both modes)
 *   2. Validate cumulative distance ≤ pathLengthM
 *   3. totalSamples = ceil(samplesPerSec × totalDuration)
 *   4. Generate uniform timestamps, walk piecewise profile for cumulative distance
 *   5. Normalize by pathLengthM → path t-value [0, 1]
 */
function runSegmentPipeline(segments: SpeedSegment[], samplesPerSec: number, pathLengthM: number): SimulationResult | { error: string } {
  if (segments.length === 0) return { error: 'Add at least one segment' }
  if (samplesPerSec <= 0) return { error: 'Sampling rate must be positive' }
  if (pathLengthM <= 0) return { error: 'Set the path length first' }

  const computed: SegmentComputed[] = []
  let cumulativeTime = 0
  let cumulativeDistance = 0

  for (let i = 0; i < segments.length; i++) {
    const resolved = resolveSegment(segments[i], pathLengthM)
    if ('error' in resolved) return { error: `Segment ${i + 1}: ${resolved.error}` }

    cumulativeDistance += resolved.distanceM
    const coveragePct = (cumulativeDistance / pathLengthM) * 100

    if (coveragePct > 100.01) {
      const excess = cumulativeDistance - pathLengthM
      return { error: `Segment ${i + 1} exceeds path by ${formatDistance(excess)} (${coveragePct.toFixed(1)}% > 100%). Remove or shorten this segment.` }
    }

    computed.push({
      speedMs: resolved.speedMs,
      durationSec: resolved.durationSec,
      distanceM: resolved.distanceM,
      timeStartSec: cumulativeTime,
      cumulativeDistM: cumulativeDistance,
      coveragePct: Math.min(100, coveragePct),
    })
    cumulativeTime += resolved.durationSec
  }

  const totalDurationSec = cumulativeTime
  const totalDistanceM = cumulativeDistance
  const pathCoverage = Math.min(100, (totalDistanceM / pathLengthM) * 100)

  const totalSamples = Math.max(1, Math.ceil(samplesPerSec * totalDurationSec))
  if (totalSamples > 500) return { error: `Too many samples (${totalSamples}). Reduce rate or duration.` }

  const interval = totalDurationSec / totalSamples
  const localTimestamps: number[] = []
  const allDistances: number[] = []

  for (let i = 0; i < totalSamples; i++) {
    const timestamp = (i + 1) * interval
    localTimestamps.push(timestamp)

    // Walk piecewise segments to compute cumulative distance at this timestamp
    let cumulDist = 0
    let timeRemaining = timestamp

    for (const seg of computed) {
      if (timeRemaining <= 0) break
      const dtInSeg = Math.min(timeRemaining, seg.durationSec)
      cumulDist += seg.speedMs * dtInSeg
      timeRemaining -= seg.durationSec
    }

    allDistances.push(cumulDist)
  }

  // Normalize by pathLengthM — t represents actual position on the physical path
  const tValues = allDistances.map(d => Math.min(1, d / pathLengthM))

  return { tValues, localTimestamps, totalParticipants: totalSamples, totalDurationSec, totalDistanceM, pathCoverage, segmentsComputed: computed }
}


// =============================================================================
// SCENE DATA MODEL
// =============================================================================

const PATH_COLORS = [
  '#4f46e5', '#ea580c', '#16a34a', '#dc2626',
  '#8b5cf6', '#0891b2', '#d97706', '#be185d',
  '#0d9488', '#4338ca', '#c2410c', '#15803d',
]

interface LocalParticipant {
  t: number            // path-local parametric value [0, 1]
  localTimeSec: number // seconds from this path's own t=0
}

interface PathConfig {
  pathId: string
  label: string
  color: string
  startOffsetSec: number
  pathLengthM: number            // user-specified real-world path length in meters
  templateId: string
  segments: SpeedSegment[]
  displayPoints: Point2D[]       // cached from host
  participants: LocalParticipant[]
  placedShapeIds: string[]
  isPlaced: boolean
  localDurationSec: number       // total duration of this path's speed profile
}

interface GlobalParticipant {
  pathId: string
  pathColor: string
  pathLabel: string
  localT: number
  globalTimeSec: number
}

interface GlobalTimeline {
  events: GlobalParticipant[]    // sorted by globalTimeSec
  totalDurationSec: number       // max global end time across all paths
  pathCount: number
}

// The scene
let scene: PathConfig[] = []
let activePathId: string | null = null
let colorIndex = 0
let globalSamplingRate = 1.0 // samples per second — applies uniformly to all paths

function nextColor(): string {
  const c = PATH_COLORS[colorIndex % PATH_COLORS.length]
  colorIndex++
  return c
}


// =============================================================================
// TEMPLATES
// =============================================================================

const TEMPLATES = [
  { id: 'sedan', name: 'Sedan', w: 30, h: 56, type: 'vehicle' as const, svg: '/templates/vehicle/sedan.svg', vbW: 25, vbH: 47 },
  { id: 'bus', name: 'Bus', w: 37, h: 92, type: 'vehicle' as const, svg: '/templates/vehicle/bus.svg', vbW: 341, vbH: 850 },
  { id: 'truck', name: 'Truck', w: 43, h: 147, type: 'vehicle' as const, svg: '/templates/vehicle/truck.svg', vbW: 328, vbH: 1114 },
  { id: 'motorcycle', name: 'Moto', w: 18, h: 36, type: 'vehicle' as const, svg: '/templates/vehicle/motorcycle.svg', vbW: 410, vbH: 830 },
  { id: 'bicycle', name: 'Bicycle', w: 18, h: 36, type: 'vehicle' as const, svg: '/templates/vehicle/bicycle.svg', vbW: 619, vbH: 1212 },
  { id: 'golf_cart', name: 'Golf', w: 23, h: 43, type: 'vehicle' as const, svg: '/templates/vehicle/golf_cart.svg', vbW: 335, vbH: 613 },
  { id: 'rectangle', name: 'Rect', w: 30, h: 56, type: 'vehicle' as const, svg: '', vbW: 30, vbH: 56 },
  { id: 'filled', name: 'Ped', w: 22, h: 22, type: 'pedestrian' as const, svg: '/templates/pedestrian/pedestrian_filled.svg', vbW: 620, vbH: 620 },
  { id: 'walk', name: 'Walk', w: 22, h: 22, type: 'pedestrian' as const, svg: '/templates/pedestrian/pedestrian_walk.svg', vbW: 220, vbH: 220 },
  { id: 'simple', name: 'Simple', w: 22, h: 22, type: 'pedestrian' as const, svg: '/templates/pedestrian/pedestrian_simple.svg', vbW: 210, vbH: 210 },
]

function templateById(id: string) { return TEMPLATES.find(t => t.id === id) ?? TEMPLATES[0] }


// =============================================================================
// SCENE MANAGEMENT
// =============================================================================

function getPathConfig(pathId: string): PathConfig | undefined {
  return scene.find(p => p.pathId === pathId)
}

function addPathToScene(pathId: string, displayPoints: Point2D[], label?: string): PathConfig {
  const existing = getPathConfig(pathId)
  if (existing) {
    existing.displayPoints = displayPoints
    return existing
  }
  const config: PathConfig = {
    pathId,
    label: label ?? `Path ${scene.length + 1}`,
    color: nextColor(),
    startOffsetSec: 0,
    pathLengthM: 0,           // user must set this before generating
    templateId: 'sedan',
    segments: [],
    displayPoints,
    participants: [],
    placedShapeIds: [],
    isPlaced: false,
    localDurationSec: 0,
  }
  scene.push(config)
  return config
}

function removePathFromScene(pathId: string) {
  const idx = scene.findIndex(p => p.pathId === pathId)
  if (idx < 0) return
  // Clean up placed shapes
  const config = scene[idx]
  if (config.placedShapeIds.length > 0) {
    client.deleteShapes(config.placedShapeIds)
  }
  scene.splice(idx, 1)
  if (activePathId === pathId) {
    activePathId = scene.length > 0 ? scene[0].pathId : null
  }
}

function setActivePath(pathId: string | null) {
  activePathId = pathId
  renderAll()
}


// =============================================================================
// GLOBAL TIMELINE COMPUTATION
// =============================================================================

function computeGlobalTimeline(): GlobalTimeline {
  const events: GlobalParticipant[] = []
  let maxEnd = 0

  for (const pc of scene) {
    if (pc.participants.length === 0) continue
    const pathEnd = pc.startOffsetSec + pc.localDurationSec
    if (pathEnd > maxEnd) maxEnd = pathEnd

    for (const lp of pc.participants) {
      events.push({
        pathId: pc.pathId,
        pathColor: pc.color,
        pathLabel: pc.label,
        localT: lp.t,
        globalTimeSec: pc.startOffsetSec + lp.localTimeSec,
      })
    }
  }

  events.sort((a, b) => a.globalTimeSec - b.globalTimeSec)
  const pathsWithParticipants = new Set(events.map(e => e.pathId)).size

  return { events, totalDurationSec: maxEnd, pathCount: pathsWithParticipants }
}

/**
 * For a given global time, compute each active path's interpolated t-value.
 * Uses step interpolation: finds the last participant at or before globalTime.
 * Returns one entry per active path.
 */
function resolvePositionsAtGlobalTime(globalTimeSec: number): Array<{ pathConfig: PathConfig; t: number }> {
  const results: Array<{ pathConfig: PathConfig; t: number }> = []

  for (const pc of scene) {
    if (pc.participants.length === 0) continue
    const localTime = globalTimeSec - pc.startOffsetSec
    if (localTime < 0) continue // path hasn't started yet
    if (localTime > pc.localDurationSec + 0.001) continue // path finished

    // Find the participant with the largest localTimeSec <= localTime
    let bestT = pc.participants[0].t
    for (const lp of pc.participants) {
      if (lp.localTimeSec <= localTime + 0.001) bestT = lp.t
      else break // participants are sorted by time
    }
    results.push({ pathConfig: pc, t: bestT })
  }

  return results
}


// =============================================================================
// UI HELPERS
// =============================================================================

let client: ExtensionClient
let idCounter = 0
function nextId(prefix = 'fplab'): string { return `${prefix}_${++idCounter}_${Date.now().toString(36)}` }

function setStatus(msg: string) {
  const el = document.getElementById('status')
  if (el) el.textContent = msg
}

function hostUrl(path: string): string {
  try {
    const parentOrigin = document.referrer ? new URL(document.referrer).origin : window.location.origin
    return parentOrigin + path
  } catch { return path }
}

function getActiveConfig(): PathConfig | undefined {
  return activePathId ? getPathConfig(activePathId) : undefined
}


// =============================================================================
// RENDER EVERYTHING
// =============================================================================

function renderAll() {
  // Sync global sampling rate input if present
  const rateInput = document.getElementById('global-sampling-rate') as HTMLInputElement | null
  if (rateInput) rateInput.value = String(globalSamplingRate)

  renderPathTabs()
  renderPathConfig()
  renderGlobalTimeline()
  updateVideoUI()
}


// =============================================================================
// PATH TABS
// =============================================================================

function renderPathTabs() {
  const container = document.getElementById('path-tabs')!
  const emptyEl = document.getElementById('scene-empty')!
  container.innerHTML = ''

  if (scene.length === 0) {
    emptyEl.style.display = 'flex'
    document.getElementById('path-config')!.style.display = 'none'
    document.getElementById('global-timeline-section')!.style.display = 'none'
    document.getElementById('video-section')!.style.display = 'none'
    return
  }

  emptyEl.style.display = 'none'

  scene.forEach(pc => {
    const tab = document.createElement('div')
    tab.className = `path-tab${pc.pathId === activePathId ? ' active' : ''}`
    tab.innerHTML = `
      <span class="color-dot" style="background:${pc.color};"></span>
      <span class="path-label">${pc.label}</span>
      <button class="tab-remove" title="Remove from scene">&times;</button>
    `
    tab.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).classList.contains('tab-remove')) return
      setActivePath(pc.pathId)
    })
    tab.querySelector('.tab-remove')!.addEventListener('click', (e) => {
      e.stopPropagation()
      removePathFromScene(pc.pathId)
      renderAll()
    })
    container.appendChild(tab)
  })
}


// =============================================================================
// PER-PATH CONFIG PANEL
// =============================================================================

function renderPathConfig() {
  const panel = document.getElementById('path-config')!
  const config = getActiveConfig()

  if (!config) {
    panel.style.display = 'none'
    return
  }
  panel.style.display = 'block'

  // Path info
  const canvasArc = totalArcLength(config.displayPoints)
  const smoothed = config.displayPoints.length > 0 ? ' (smoothed)' : ''
  document.getElementById('path-info')!.textContent =
    `${config.label} — ${config.displayPoints.length} pts${smoothed} · ${canvasArc.toFixed(0)} canvas units`

  // Start offset
  ;(document.getElementById('path-start-offset') as HTMLInputElement).value = String(config.startOffsetSec)

  // Path length
  ;(document.getElementById('path-length-m') as HTMLInputElement).value = String(config.pathLengthM || '')

  // Template
  renderTemplateGrid(config)

  // Segments
  renderSegmentList(config)
  updateTotals(config)

  // Participants (fine-tune sliders)
  renderFootprintList(config)

  // Participant count badge
  document.getElementById('participant-count')!.textContent = String(config.participants.length)

  // Place button visibility
  const btnPlace = document.getElementById('btn-place')!
  const liveIndicator = document.getElementById('live-indicator')!
  const manualSection = document.getElementById('manual-section')!

  if (config.participants.length === 0) {
    btnPlace.style.display = 'none'
    liveIndicator.style.display = 'none'
    manualSection.style.display = 'none'
  } else if (!config.isPlaced) {
    btnPlace.style.display = 'block'
    liveIndicator.style.display = 'none'
    manualSection.style.display = 'block'
  } else {
    btnPlace.style.display = 'none'
    liveIndicator.style.display = 'block'
    manualSection.style.display = 'block'
  }

  // Init segment mode toggle styling
  onSegModeChange()
}


// =============================================================================
// TEMPLATE GRID
// =============================================================================

function renderTemplateGrid(config: PathConfig) {
  const container = document.getElementById('template-grid')!
  container.innerHTML = ''
  TEMPLATES.forEach(tmpl => {
    const btn = document.createElement('button')
    btn.className = `template-btn${tmpl.id === config.templateId ? ' active' : ''}`
    btn.title = tmpl.name
    const maxSize = 24, aspect = tmpl.vbW / tmpl.vbH
    let iconW = maxSize, iconH = maxSize
    if (aspect > 1) iconH = Math.round(maxSize / aspect); else iconW = Math.round(maxSize * aspect)
    if (tmpl.svg) {
      const isPed = tmpl.type === 'pedestrian'
      const style = isPed
        ? `width:${iconW}px;height:${iconH}px;object-fit:fill;transform:scaleY(-1);`
        : `width:${iconW}px;height:${iconH}px;object-fit:fill;filter:invert(40%);`
      btn.innerHTML = `<img src="${hostUrl(tmpl.svg)}" alt="${tmpl.name}" style="${style}" />`
    } else if (tmpl.id === 'rectangle') {
      btn.innerHTML = `<svg width="${iconW}" height="${iconH}" viewBox="0 0 30 56"><rect x="2" y="2" width="26" height="52" fill="none" stroke="#374151" stroke-width="3" rx="2" ry="2" /></svg>`
    } else {
      btn.innerHTML = `<span>${tmpl.name}</span>`
    }
    btn.addEventListener('click', () => {
      config.templateId = tmpl.id
      renderTemplateGrid(config)
    })
    container.appendChild(btn)
  })
}


// =============================================================================
// SEGMENT LIST UI
// =============================================================================

function renderSegmentList(config: PathConfig) {
  const container = document.getElementById('seg-list')!
  container.innerHTML = ''

  if (config.segments.length === 0) {
    container.innerHTML = '<div class="seg-empty">No segments yet</div>'
    return
  }

  let cumulDist = 0
  const pathLen = config.pathLengthM

  config.segments.forEach((seg, i) => {
    const resolved = pathLen > 0 ? resolveSegment(seg, pathLen) : null
    let dist = 0, dur = 0, coveragePct = 0, isOverflow = false

    if (resolved && !('error' in resolved)) {
      dist = resolved.distanceM
      dur = resolved.durationSec
      cumulDist += dist
      coveragePct = pathLen > 0 ? Math.min(100, (cumulDist / pathLen) * 100) : 0
      isOverflow = cumulDist > pathLen * 1.001
    }

    // Format segment label based on mode
    let mainLabel: string
    if (seg.mode === 'percent') {
      mainLabel = `${seg.speed} ${seg.speedUnit} × ${seg.pathPercent}% path`
    } else {
      mainLabel = `${seg.speed} ${seg.speedUnit} × ${seg.duration} ${seg.durationUnit}`
    }

    const card = document.createElement('div')
    card.className = 'seg-card'
    if (isOverflow) card.style.borderColor = '#fca5a5'
    card.innerHTML = `
      <span class="seg-num">${i + 1}</span>
      <div class="seg-info">
        <div class="seg-main">${mainLabel}</div>
        <div class="seg-detail">${formatDistance(dist)} · ${formatDuration(dur)}${pathLen > 0 ? ` · ${coveragePct.toFixed(1)}% covered` : ''}</div>
        ${pathLen > 0 ? `<div style="height:3px; background:#e4e4e7; border-radius:2px; margin-top:2px; overflow:hidden;">
          <div style="height:100%; width:${Math.min(100, coveragePct)}%; background:${isOverflow ? '#ef4444' : coveragePct > 95 ? '#f59e0b' : '#22c55e'}; border-radius:2px;"></div>
        </div>` : ''}
        ${isOverflow ? `<div style="font-size:7px; color:#ef4444; margin-top:1px;">⚠ Exceeds path length</div>` : ''}
      </div>
      <button class="seg-remove" data-index="${i}">&times;</button>
    `
    card.querySelector('.seg-remove')!.addEventListener('click', () => {
      config.segments.splice(i, 1)
      renderSegmentList(config)
      updateTotals(config)
    })
    container.appendChild(card)
  })
}

function updateTotals(config: PathConfig) {
  const totalsEl = document.getElementById('sim-totals')!
  const generateBtn = document.getElementById('btn-generate') as HTMLButtonElement

  if (config.segments.length === 0) {
    totalsEl.className = 'sim-totals empty'
    totalsEl.innerHTML = '<div style="text-align:center;">Add segments to build a speed profile</div>'
    generateBtn.disabled = true
    return
  }

  if (config.pathLengthM <= 0) {
    totalsEl.className = 'sim-totals empty'
    totalsEl.innerHTML = '<div style="text-align:center;color:#d97706;">Set the path length (m) above before generating</div>'
    generateBtn.disabled = true
    return
  }

  const result = runSegmentPipeline(config.segments, globalSamplingRate, config.pathLengthM)
  if ('error' in result) {
    totalsEl.className = 'sim-totals empty'
    totalsEl.innerHTML = `<div style="text-align:center;color:#991b1b;">${result.error}</div>`
    generateBtn.disabled = true
    return
  }

  const coverageColor = result.pathCoverage > 99.9 ? '#059669' : result.pathCoverage > 80 ? '#d97706' : '#6b7280'

  generateBtn.disabled = false
  totalsEl.className = 'sim-totals'
  totalsEl.innerHTML = `
    <div class="totals-line"><span>Path coverage</span><span class="totals-value" style="color:${coverageColor};">${result.pathCoverage.toFixed(1)}%</span></div>
    <div style="height:4px; background:#e4e4e7; border-radius:2px; margin:3px 0; overflow:hidden;">
      <div style="height:100%; width:${Math.min(100, result.pathCoverage)}%; background:${coverageColor}; border-radius:2px; transition:width 0.2s;"></div>
    </div>
    <div class="totals-line"><span>Participants</span><span class="totals-value">${result.totalParticipants}</span></div>
    <div class="totals-line"><span>Duration</span><span class="totals-value">${formatDuration(result.totalDurationSec)}</span></div>
    <div class="totals-line"><span>Distance</span><span class="totals-value">${formatDistance(result.totalDistanceM)} / ${formatDistance(config.pathLengthM)}</span></div>
    <div class="totals-line"><span>Sample interval</span><span class="totals-value">${formatDuration(1 / globalSamplingRate)}</span></div>
  `
}


// =============================================================================
// FOOTPRINT SLIDERS (fine-tune)
// =============================================================================

function renderFootprintList(config: PathConfig) {
  const container = document.getElementById('footprint-list')!
  container.innerHTML = ''

  config.participants.forEach((fp, i) => {
    const row = document.createElement('div')
    row.className = 'footprint-row'
    row.innerHTML = `
      <span class="index">${i + 1}</span>
      <input type="range" min="0" max="1" step="0.01" value="${fp.t}" data-index="${i}" />
      <span class="t-value">${fp.t.toFixed(2)}</span>
    `
    const slider = row.querySelector('input')!
    slider.addEventListener('input', (e) => {
      const idx = parseInt((e.target as HTMLInputElement).dataset.index!)
      config.participants[idx].t = parseFloat((e.target as HTMLInputElement).value)
      row.querySelector('.t-value')!.textContent = config.participants[idx].t.toFixed(2)
      if (config.isPlaced) debouncedLiveUpdate(config)
    })
    container.appendChild(row)
  })
}


// =============================================================================
// SEGMENT MODE TOGGLE
// =============================================================================

function onSegModeChange() {
  const mode = (document.querySelector('input[name="seg-mode"]:checked') as HTMLInputElement)?.value || 'time'
  const timeRow = document.getElementById('seg-time-row')!
  const pctRow = document.getElementById('seg-pct-row')!
  const timeLabel = document.getElementById('seg-mode-time-label')!
  const pctLabel = document.getElementById('seg-mode-pct-label')!

  if (mode === 'percent') {
    timeRow.style.display = 'none'
    pctRow.style.display = 'flex'
    pctLabel.style.background = '#fff'
    pctLabel.style.color = '#4f46e5'
    pctLabel.style.boxShadow = '0 1px 2px rgba(0,0,0,0.06)'
    timeLabel.style.background = 'transparent'
    timeLabel.style.color = '#71717a'
    timeLabel.style.boxShadow = 'none'
  } else {
    timeRow.style.display = 'flex'
    pctRow.style.display = 'none'
    timeLabel.style.background = '#fff'
    timeLabel.style.color = '#4f46e5'
    timeLabel.style.boxShadow = '0 1px 2px rgba(0,0,0,0.06)'
    pctLabel.style.background = 'transparent'
    pctLabel.style.color = '#71717a'
    pctLabel.style.boxShadow = 'none'
  }
}

// =============================================================================
// ACTIONS — GLOBAL
// =============================================================================

function onGlobalSamplingRateChange() {
  const val = parseFloat((document.getElementById('global-sampling-rate') as HTMLInputElement).value) || 1
  globalSamplingRate = Math.max(0.01, val)

  // Re-generate participants for all paths that have segments
  for (const config of scene) {
    if (config.segments.length === 0 || config.pathLengthM <= 0) continue
    const result = runSegmentPipeline(config.segments, globalSamplingRate, config.pathLengthM)
    if ('error' in result) continue
    config.participants = result.tValues.map((t, i) => ({
      t: parseFloat(t.toFixed(4)),
      localTimeSec: result.localTimestamps[i],
    }))
    config.localDurationSec = result.totalDurationSec
    config.isPlaced = false
  }

  renderAll()
}

// =============================================================================
// ACTIONS — PER-PATH
// =============================================================================

function onStartOffsetChange() {
  const config = getActiveConfig()
  if (!config) return
  config.startOffsetSec = parseFloat((document.getElementById('path-start-offset') as HTMLInputElement).value) || 0
  renderGlobalTimeline()
  updateVideoUI()
}

function onPathLengthChange() {
  const config = getActiveConfig()
  if (!config) return
  config.pathLengthM = Math.max(0, parseFloat((document.getElementById('path-length-m') as HTMLInputElement).value) || 0)
  // Re-validate and re-render segments with new path length
  renderSegmentList(config)
  updateTotals(config)
  renderGlobalTimeline()
  updateVideoUI()
}

function addSegment() {
  const config = getActiveConfig()
  if (!config) return

  const mode = (document.querySelector('input[name="seg-mode"]:checked') as HTMLInputElement)?.value as SegmentMode || 'time'
  const speed = parseFloat((document.getElementById('seg-speed') as HTMLInputElement).value) || 0
  const speedUnit = (document.getElementById('seg-speed-unit') as HTMLSelectElement).value as SpeedUnit

  if (speed <= 0) { setStatus('Speed must be positive'); return }

  let newSeg: SpeedSegment

  if (mode === 'percent') {
    const pct = parseFloat((document.getElementById('seg-percent') as HTMLInputElement).value) || 0
    if (pct <= 0 || pct > 100) { setStatus('Path % must be between 0 and 100'); return }
    newSeg = { mode: 'percent', speed, speedUnit, pathPercent: pct }
  } else {
    const duration = parseFloat((document.getElementById('seg-time') as HTMLInputElement).value) || 0
    const durationUnit = (document.getElementById('seg-time-unit') as HTMLSelectElement).value as TimeUnit
    if (duration <= 0) { setStatus('Duration must be positive'); return }
    newSeg = { mode: 'time', speed, speedUnit, duration, durationUnit }
  }

  // Pre-validate: check if adding this segment would exceed path length
  if (config.pathLengthM > 0) {
    const testSegments = [...config.segments, newSeg]
    let totalDist = 0
    for (const seg of testSegments) {
      const resolved = resolveSegment(seg, config.pathLengthM)
      if ('error' in resolved) { setStatus(`Error: ${resolved.error}`); return }
      totalDist += resolved.distanceM
    }
    if (totalDist > config.pathLengthM * 1.001) {
      const excess = totalDist - config.pathLengthM
      const pct = ((totalDist / config.pathLengthM) * 100).toFixed(1)
      setStatus(`Cannot add: would exceed path by ${formatDistance(excess)} (${pct}%)`)
      return
    }
  }

  config.segments.push(newSeg)
  renderSegmentList(config)
  updateTotals(config)
  setStatus('')
}

function generateParticipants() {
  const config = getActiveConfig()
  if (!config) return
  if (config.pathLengthM <= 0) { setStatus('Set the path length (m) first'); return }

  const result = runSegmentPipeline(config.segments, globalSamplingRate, config.pathLengthM)
  if ('error' in result) { setStatus(`Error: ${result.error}`); return }

  config.participants = result.tValues.map((t, i) => ({
    t: parseFloat(t.toFixed(4)),
    localTimeSec: result.localTimestamps[i],
  }))
  config.localDurationSec = result.totalDurationSec
  config.isPlaced = false

  renderAll()
  setStatus(`Generated ${result.totalParticipants} positions for ${config.label}`)
  client.notify(`${result.totalParticipants} positions generated for ${config.label}`, 'success')
}

function clearActivePath() {
  const config = getActiveConfig()
  if (!config) return
  removePathFromScene(config.pathId)
  renderAll()
  client.notify('Path removed from scene', 'info')
}


// =============================================================================
// PLACEMENT — single path
// =============================================================================

async function placePathParticipants(config: PathConfig): Promise<number> {
  if (config.displayPoints.length < 2 || config.participants.length === 0) return 0

  try {
    // Refresh display points
    const freshShapes = await client.requestShapes({ ids: [config.pathId] })
    const freshPath = freshShapes.find(s => s.id === config.pathId)
    if (freshPath) {
      const dp = freshPath.props._displayPoints as Point2D[] | undefined
      if (dp && dp.length >= 2) config.displayPoints = dp
    }

    // Clear existing placed shapes for this path
    await clearPlacedShapesForPath(config)

    const sorted = [...config.participants].sort((a, b) => a.t - b.t)
    const tmpl = templateById(config.templateId)
    const shapeType = tmpl.type === 'pedestrian' ? 'pedestrian' : 'vehicle'
    const attrType = tmpl.type === 'pedestrian' ? 'pedestrian' : 'vehicle'
    const attrSubtype = tmpl.type === 'pedestrian' ? 'person' : 'car'

    const shapes: BaseShape[] = sorted.map(fp => {
      const ev = evaluatePathAt(config.displayPoints, fp.t)
      return {
        id: nextId('fp'), type: shapeType,
        x: ev.position.x, y: ev.position.y, rotation: ev.tangentAngleDeg,
        zIndex: shapeType === 'pedestrian' ? 3000 : 4000,
        props: {
          w: tmpl.w, h: tmpl.h,
          color: 'black', size: 'm', opacity: 1,
          attributes: { type: attrType, subtype: attrSubtype },
          osmId: '', templateId: tmpl.id, parentPathId: config.pathId,
        },
      }
    })
    client.addShapes(shapes)
    await new Promise(r => setTimeout(r, 500))

    // Query back to get actual IDs
    let allOfType: BaseShape[] = []
    for (const qt of ['vehicle', 'pedestrian']) {
      allOfType = allOfType.concat(await client.requestShapes({ types: [qt] }))
    }
    config.placedShapeIds = allOfType.filter(s => s.props.parentPathId === config.pathId).map(s => s.id)

    // Update path's footprint metadata
    if (config.placedShapeIds.length > 0) {
      const arcLengths = computeArcLengths(config.displayPoints)
      const totalLen = arcLengths[arcLengths.length - 1]
      const interval = sorted.length > 1 ? Math.round(totalLen / (sorted.length - 1)) : Math.round(totalLen)
      client.updateShapes([{
        id: config.pathId,
        props: {
          footprint: { interval, offset: 0, templateId: tmpl.id, anchorOffset: 0, mode: 'variable', tValues: sorted.map(f => f.t) },
          footprintIds: config.placedShapeIds,
        },
      }])
    }

    config.isPlaced = true
    return config.placedShapeIds.length
  } catch (e) {
    setStatus(`Error placing: ${e}`)
    return 0
  }
}

async function clearPlacedShapesForPath(config: PathConfig) {
  try {
    let all: BaseShape[] = []
    for (const qt of ['vehicle', 'pedestrian']) all = all.concat(await client.requestShapes({ types: [qt] }))
    const ids = all.filter(s => s.props.parentPathId === config.pathId).map(s => s.id)
    if (ids.length > 0) { client.deleteShapes(ids); await new Promise(r => setTimeout(r, 200)) }
    client.updateShapes([{ id: config.pathId, props: { footprintIds: [] } }])
    await new Promise(r => setTimeout(r, 100))
    config.placedShapeIds = []
  } catch (e) { console.warn('[FootprintLab] Error clearing shapes:', e) }
}

async function placeActivePathParticipants() {
  const config = getActiveConfig()
  if (!config) { setStatus('Select a path first'); return }
  setStatus(`Placing participants on ${config.label}…`)
  const count = await placePathParticipants(config)
  if (count > 0) {
    client.notify(`${count} participants placed on ${config.label}`, 'success')
    setStatus(`Placed ${count} — drag sliders to reposition`)
  }
  renderAll()
}

async function placeAllPaths() {
  let totalPlaced = 0
  for (const config of scene) {
    if (config.participants.length === 0) continue
    setStatus(`Placing ${config.label}…`)
    const count = await placePathParticipants(config)
    totalPlaced += count
  }
  if (totalPlaced > 0) {
    client.notify(`${totalPlaced} participants placed across ${scene.length} path(s)`, 'success')
    setStatus(`Placed ${totalPlaced} total participants`)
  }
  renderAll()
}


// =============================================================================
// LIVE UPDATE (debounced per-path)
// =============================================================================

let liveDebounceTimer: ReturnType<typeof setTimeout> | null = null

function debouncedLiveUpdate(config: PathConfig) {
  if (liveDebounceTimer) clearTimeout(liveDebounceTimer)
  liveDebounceTimer = setTimeout(() => { liveDebounceTimer = null; placePathParticipants(config).then(() => renderAll()) }, 200)
}


// =============================================================================
// GLOBAL TIMELINE RENDERING (canvas)
// =============================================================================

function renderGlobalTimeline() {
  const section = document.getElementById('global-timeline-section')!
  const hasParticipants = scene.some(p => p.participants.length > 0)

  if (scene.length === 0 || !hasParticipants) {
    section.style.display = 'none'
    return
  }
  section.style.display = 'block'

  const timeline = computeGlobalTimeline()
  const canvas = document.getElementById('timeline-canvas') as HTMLCanvasElement
  const ctx = canvas.getContext('2d')!

  // High-DPI
  const dpr = window.devicePixelRatio || 1
  const rect = canvas.getBoundingClientRect()
  canvas.width = rect.width * dpr
  canvas.height = 80 * dpr
  ctx.scale(dpr, dpr)
  const W = rect.width
  const H = 80

  ctx.clearRect(0, 0, W, H)

  if (timeline.totalDurationSec <= 0 || timeline.events.length === 0) {
    ctx.fillStyle = '#9ca3af'
    ctx.font = '9px system-ui'
    ctx.textAlign = 'center'
    ctx.fillText('No timeline data', W / 2, H / 2)
    return
  }

  const pathsWithData = scene.filter(p => p.participants.length > 0)
  const rowH = Math.min(16, (H - 20) / pathsWithData.length)
  const topPad = 4
  const leftPad = 4
  const rightPad = 4
  const bottomPad = 16
  const plotW = W - leftPad - rightPad
  const totalSec = timeline.totalDurationSec

  // Draw time axis
  ctx.strokeStyle = '#e4e4e7'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(leftPad, H - bottomPad)
  ctx.lineTo(W - rightPad, H - bottomPad)
  ctx.stroke()

  // Time labels
  ctx.fillStyle = '#9ca3af'
  ctx.font = '8px system-ui'
  ctx.textAlign = 'center'
  const numTicks = Math.min(8, Math.max(2, Math.floor(plotW / 50)))
  for (let i = 0; i <= numTicks; i++) {
    const t = (i / numTicks) * totalSec
    const x = leftPad + (i / numTicks) * plotW
    ctx.fillText(formatDuration(t), x, H - 3)
    ctx.beginPath()
    ctx.moveTo(x, H - bottomPad)
    ctx.lineTo(x, H - bottomPad + 3)
    ctx.stroke()
  }

  // Draw per-path rows
  pathsWithData.forEach((pc, rowIdx) => {
    const y = topPad + rowIdx * rowH
    const midY = y + rowH / 2

    // Row background
    ctx.fillStyle = pc.pathId === activePathId ? '#f0f0ff' : '#fafbff'
    ctx.fillRect(leftPad, y, plotW, rowH - 1)

    // Path color bar on left
    ctx.fillStyle = pc.color
    ctx.fillRect(leftPad, y + 2, 3, rowH - 5)

    // Start offset marker (vertical dashed line at path start)
    if (pc.startOffsetSec > 0) {
      const offsetX = leftPad + (pc.startOffsetSec / totalSec) * plotW
      ctx.strokeStyle = pc.color + '40'
      ctx.setLineDash([2, 2])
      ctx.beginPath()
      ctx.moveTo(offsetX, y)
      ctx.lineTo(offsetX, y + rowH - 1)
      ctx.stroke()
      ctx.setLineDash([])
    }

    // Participant ticks
    for (const lp of pc.participants) {
      const globalT = pc.startOffsetSec + lp.localTimeSec
      const x = leftPad + (globalT / totalSec) * plotW
      ctx.fillStyle = pc.color
      ctx.fillRect(x - 1, midY - 4, 2, 8)
    }
  })

  // Legend
  const legendContainer = document.getElementById('timeline-legend')!
  legendContainer.innerHTML = ''
  pathsWithData.forEach(pc => {
    const item = document.createElement('div')
    item.className = 'legend-item'
    item.innerHTML = `<span class="legend-dot" style="background:${pc.color};"></span>${pc.label} (${pc.participants.length})`
    legendContainer.appendChild(item)
  })
}


// =============================================================================
// SELECTION POLLING — auto-add paths to scene
// =============================================================================

let lastSelectionId: string | null = null
let deselectionGraceTimer: ReturnType<typeof setTimeout> | null = null

async function pollSelection() {
  try {
    const selection = await client.requestSelection()
    const currentId = selection.ids.length > 0 ? selection.ids[0] : null

    if (currentId !== lastSelectionId) {
      lastSelectionId = currentId

      if (currentId) {
        if (deselectionGraceTimer) { clearTimeout(deselectionGraceTimer); deselectionGraceTimer = null }

        const shapes = await client.requestShapes({ ids: [currentId] })
        const path = shapes.find(s => s.type === 'linestring' && s.props.isPath)

        if (path) {
          const displayPoints = path.props._displayPoints as Point2D[] | undefined
          let points: Point2D[] = []

          if (displayPoints && displayPoints.length >= 2) {
            points = displayPoints
          } else {
            const pointIds = path.props.pointIds as string[]
            const allShapes = await client.requestShapes({ ids: pointIds })
            points = pointIds.map(pid => {
              const pt = allShapes.find(s => s.id === pid)
              return pt ? { x: pt.x, y: pt.y } : { x: 0, y: 0 }
            }).filter(p => p.x !== 0 || p.y !== 0)
          }

          if (points.length >= 2) {
            addPathToScene(path.id, points)
            setActivePath(path.id)
          }
        }
      } else {
        // Deselection grace period — don't immediately lose context
        if (!deselectionGraceTimer && activePathId) {
          deselectionGraceTimer = setTimeout(() => {
            deselectionGraceTimer = null
            // Keep scene intact, just note deselection
          }, 600)
        }
      }
    }
  } catch { /* ignore */ }
}


// =============================================================================
// JSON IMPORT / EXPORT
// =============================================================================

interface SceneJSON {
  version: 1
  globalSamplingRate: number
  paths: Array<{
    pathId: string
    label: string
    startOffsetSec: number
    pathLengthM: number
    templateId: string
    segments: SpeedSegment[]
  }>
}

function exportSceneJSON() {
  const data: SceneJSON = {
    version: 1,
    globalSamplingRate,
    paths: scene.map(pc => ({
      pathId: pc.pathId,
      label: pc.label,
      startOffsetSec: pc.startOffsetSec,
      pathLengthM: pc.pathLengthM,
      templateId: pc.templateId,
      segments: pc.segments.map(s => ({ ...s })),
    })),
  }
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `scene-${new Date().toISOString().slice(0, 10)}.json`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
  client.notify('Scene exported', 'success')
}

async function importSceneJSON(input: HTMLInputElement) {
  const file = input.files?.[0]
  if (!file) return
  try {
    const text = await file.text()
    const data = JSON.parse(text) as SceneJSON

    if (!data.version || !Array.isArray(data.paths)) {
      setStatus('Invalid scene JSON'); return
    }

    // Restore global sampling rate if present
    if (typeof data.globalSamplingRate === 'number' && data.globalSamplingRate > 0) {
      globalSamplingRate = data.globalSamplingRate
    }

    let imported = 0, skipped = 0

    for (const entry of data.paths) {
      try {
        // Verify path exists on canvas
        const shapes = await client.requestShapes({ ids: [entry.pathId] })
        const path = shapes.find(s => s.type === 'linestring' && s.props.isPath)
        if (!path) { skipped++; continue }

        const dp = path.props._displayPoints as Point2D[] | undefined
        let points: Point2D[] = []
        if (dp && dp.length >= 2) {
          points = dp
        } else {
          const pointIds = path.props.pointIds as string[]
          const allShapes = await client.requestShapes({ ids: pointIds })
          points = pointIds.map(pid => {
            const pt = allShapes.find(s => s.id === pid)
            return pt ? { x: pt.x, y: pt.y } : { x: 0, y: 0 }
          }).filter(p => p.x !== 0 || p.y !== 0)
        }

        if (points.length < 2) { skipped++; continue }

        const config = addPathToScene(entry.pathId, points, entry.label)
        config.startOffsetSec = entry.startOffsetSec ?? 0
        config.pathLengthM = entry.pathLengthM ?? 0
        config.templateId = entry.templateId ?? 'sedan'
        config.segments = (entry.segments ?? []).map(s => ({ ...s }))

        // Auto-generate participants if segments exist and path length is set
        if (config.segments.length > 0 && config.pathLengthM > 0) {
          const result = runSegmentPipeline(config.segments, globalSamplingRate, config.pathLengthM)
          if (!('error' in result)) {
            config.participants = result.tValues.map((t, i) => ({
              t: parseFloat(t.toFixed(4)),
              localTimeSec: result.localTimestamps[i],
            }))
            config.localDurationSec = result.totalDurationSec
          }
        }

        imported++
      } catch (e) {
        console.warn(`[FootprintLab] Failed to import path ${entry.pathId}:`, e)
        skipped++
      }
    }

    if (scene.length > 0 && !activePathId) {
      activePathId = scene[0].pathId
    }

    renderAll()
    const msg = `Imported ${imported} path(s)${skipped > 0 ? `, ${skipped} skipped (not found on canvas)` : ''}`
    setStatus(msg)
    client.notify(msg, imported > 0 ? 'success' : 'error')
  } catch (e) {
    setStatus(`JSON parse error: ${e}`)
  }
  input.value = '' // reset so same file can be re-imported
}

// Drag-and-drop support
function initJSONDropZone() {
  const zone = document.getElementById('json-drop-zone')!
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drag-over') })
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'))
  zone.addEventListener('drop', async (e) => {
    e.preventDefault()
    zone.classList.remove('drag-over')
    const file = e.dataTransfer?.files[0]
    if (!file || !file.name.endsWith('.json')) { setStatus('Please drop a .json file'); return }
    // Simulate file input
    const input = document.getElementById('json-file-input') as HTMLInputElement
    const dt = new DataTransfer()
    dt.items.add(file)
    input.files = dt.files
    await importSceneJSON(input)
  })
}


// =============================================================================
// VIDEO — Multi-path composite recording
// =============================================================================

let videoBlob: Blob | null = null
let videoRecording = false
let videoCancelled = false

interface CompositeFrameSpec {
  globalTimeSec: number
  displayDurationSec: number
  positions: Array<{ pathConfig: PathConfig; t: number }>
}

function computeCompositeFrameSpecs(targetDurationSec: number): CompositeFrameSpec[] | { error: string } {
  const timeline = computeGlobalTimeline()
  if (timeline.events.length === 0) return { error: 'No participants in scene' }
  if (targetDurationSec <= 0) return { error: 'Duration must be positive' }

  const realDuration = timeline.totalDurationSec
  if (realDuration <= 0) return { error: 'Scene has zero duration' }

  const playbackSpeed = realDuration / targetDurationSec

  // Collect unique global timestamps (deduplicated)
  const timestamps = [...new Set(timeline.events.map(e => e.globalTimeSec))].sort((a, b) => a - b)

  const frames: CompositeFrameSpec[] = []

  for (let i = 0; i < timestamps.length; i++) {
    const globalTime = timestamps[i]
    const prevTime = i === 0 ? 0 : timestamps[i - 1]
    const realInterval = globalTime - prevTime

    frames.push({
      globalTimeSec: globalTime,
      displayDurationSec: realInterval / playbackSpeed,
      positions: resolvePositionsAtGlobalTime(globalTime),
    })
  }

  return frames
}

function updateVideoUI() {
  const section = document.getElementById('video-section')!
  const hasParticipants = scene.some(p => p.participants.length > 0)
  section.style.display = hasParticipants ? 'block' : 'none'
  if (!hasParticipants) return

  onVideoSettingsChange()
}

function onVideoSettingsChange() {
  const dur = parseFloat((document.getElementById('vid-duration') as HTMLInputElement).value) || 10
  const specs = computeCompositeFrameSpecs(dur)

  const countEl = document.getElementById('vid-frame-count')!
  const activeEl = document.getElementById('vid-active-paths')!
  const realDurEl = document.getElementById('vid-real-duration')!

  if ('error' in specs) {
    countEl.textContent = '—'
    activeEl.textContent = specs.error
    realDurEl.textContent = '—'
    return
  }

  const timeline = computeGlobalTimeline()
  countEl.textContent = `${specs.length}`
  activeEl.textContent = `${timeline.pathCount}`
  realDurEl.textContent = formatDuration(timeline.totalDurationSec)
}

function buildShapeForPath(config: PathConfig, ev: PathEvalResult): BaseShape {
  const tmpl = templateById(config.templateId)
  const shapeType = tmpl.type === 'pedestrian' ? 'pedestrian' : 'vehicle'
  const attrType = tmpl.type === 'pedestrian' ? 'pedestrian' : 'vehicle'
  const attrSubtype = tmpl.type === 'pedestrian' ? 'person' : 'car'
  return {
    id: nextId('vfr'), type: shapeType,
    x: ev.position.x, y: ev.position.y, rotation: ev.tangentAngleDeg,
    zIndex: shapeType === 'pedestrian' ? 3000 : 4000,
    props: {
      w: tmpl.w, h: tmpl.h,
      color: 'black', size: 'm', opacity: 1,
      attributes: { type: attrType, subtype: attrSubtype },
      osmId: '', templateId: tmpl.id, parentPathId: config.pathId,
    },
  }
}

async function clearAllPlacedShapes() {
  for (const config of scene) {
    await clearPlacedShapesForPath(config)
  }
}

async function captureHostFrame(): Promise<string> {
  const requestId = 'frame_' + (++idCounter) + '_' + Date.now().toString(36)
  return new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      window.removeEventListener('message', handler)
      reject(new Error('Host frame capture timed out'))
    }, 10000)

    function handler(event: MessageEvent) {
      const data = event.data
      if (!data || typeof data !== 'object') return
      if (data.type === 'ext:export-response' && data.payload?.requestId === requestId) {
        window.removeEventListener('message', handler)
        clearTimeout(timeout)
        if (data.payload.data) resolve(data.payload.data as string)
        else reject(new Error('No data in export response'))
      }
      if (data.type === 'ext:error' && data.payload?.requestId === requestId) {
        window.removeEventListener('message', handler)
        clearTimeout(timeout)
        reject(new Error(data.payload.message || 'Export error'))
      }
    }
    window.addEventListener('message', handler)
    window.parent.postMessage({
      type: 'ext:export-request',
      payload: { requestId, format: 'png', returnData: true },
    }, '*')
  })
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Failed to load image'))
    img.src = dataUrl
  })
}

/**
 * Refresh display points for all scene paths from the host.
 * Ensures positions are correct even if the canvas was moved.
 */
async function refreshAllDisplayPoints() {
  for (const config of scene) {
    try {
      const shapes = await client.requestShapes({ ids: [config.pathId] })
      const path = shapes.find(s => s.id === config.pathId)
      if (path) {
        const dp = path.props._displayPoints as Point2D[] | undefined
        if (dp && dp.length >= 2) config.displayPoints = dp
      }
    } catch (e) {
      console.warn(`[FootprintLab] Failed to refresh ${config.label}:`, e)
    }
  }
}

async function recordVideo() {
  const hasParticipants = scene.some(p => p.participants.length > 0)
  if (!hasParticipants) { setStatus('No participants to animate'); return }

  onVideoSettingsChange()

  const dur = parseFloat((document.getElementById('vid-duration') as HTMLInputElement).value) || 10
  const specs = computeCompositeFrameSpecs(dur)
  if ('error' in specs) { setStatus(`Error: ${specs.error}`); return }
  if (specs.length === 0) { setStatus('No frames to record'); return }

  videoRecording = true
  videoCancelled = false
  videoBlob = null

  const canvas = document.getElementById('vid-canvas') as HTMLCanvasElement
  const ctx = canvas.getContext('2d')!
  const recordBtn = document.getElementById('vid-record-btn')!
  const cancelBtn = document.getElementById('vid-cancel-btn')!
  const downloadBtn = document.getElementById('vid-download-btn')!
  const progressWrap = document.getElementById('vid-progress-wrap')!
  const progressBar = document.getElementById('vid-progress-bar')!
  const progressText = document.getElementById('vid-progress-text')!
  const progressPct = document.getElementById('vid-progress-pct')!

  recordBtn.style.display = 'none'
  cancelBtn.style.display = 'inline-block'
  downloadBtn.style.display = 'none'
  progressWrap.style.display = 'block'
  progressBar.style.width = '0%'
  progressText.textContent = 'Preparing…'
  progressPct.textContent = '0%'

  const stream = canvas.captureStream(0)

  let mimeType = 'video/webm;codecs=vp9'
  if (!MediaRecorder.isTypeSupported(mimeType)) {
    mimeType = 'video/webm;codecs=vp8'
    if (!MediaRecorder.isTypeSupported(mimeType)) mimeType = 'video/webm'
  }

  const mediaRecorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 4_000_000 })
  const chunks: Blob[] = []
  mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data) }

  mediaRecorder.onstop = () => {
    if (!videoCancelled && chunks.length > 0) {
      videoBlob = new Blob(chunks, { type: 'video/webm' })
      downloadBtn.style.display = 'block'
      progressText.textContent = `Done — ${specs.length} frames, ${(videoBlob.size / 1024).toFixed(0)} KB`
      setStatus('Video recorded successfully')
      client.notify('Video recording complete', 'success')
    } else {
      progressText.textContent = 'Cancelled'
    }
    videoRecording = false
    cancelBtn.style.display = 'none'
    recordBtn.style.display = 'block'
    recordBtn.style.flex = '1'
  }

  mediaRecorder.start()

  try {
    // Initial refresh of all path coordinates
    await refreshAllDisplayPoints()

    for (let i = 0; i < specs.length; i++) {
      if (videoCancelled) break

      const frame = specs[i]
      const pct = ((i + 1) / specs.length * 100).toFixed(0)
      progressBar.style.width = `${pct}%`
      progressPct.textContent = `${pct}%`
      progressText.textContent = `Frame ${i + 1}/${specs.length} (${frame.positions.length} vehicles)…`

      // 1. Clear all placed shapes
      await clearAllPlacedShapes()
      if (videoCancelled) break
      await new Promise(r => setTimeout(r, 80))

      // 2. Re-fetch all path coordinates (guards against canvas pan/zoom)
      await refreshAllDisplayPoints()
      if (videoCancelled) break

      // 3. Place all active vehicles for this frame
      const tempShapeIds: string[] = []
      for (const pos of frame.positions) {
        const ev = evaluatePathAt(pos.pathConfig.displayPoints, pos.t)
        const shape = buildShapeForPath(pos.pathConfig, ev)
        client.addShapes([shape])
        tempShapeIds.push(shape.id)
      }

      // 4. Wait for host to render
      await new Promise(r => setTimeout(r, 350))
      if (videoCancelled) { client.deleteShapes(tempShapeIds); break }

      // 5. Capture composite scene
      let dataUrl: string
      try {
        dataUrl = await captureHostFrame()
      } catch (e) {
        console.warn(`[FootprintLab] Frame ${i + 1} capture failed:`, e)
        client.deleteShapes(tempShapeIds)
        continue
      }

      // 6. Remove temp shapes
      client.deleteShapes(tempShapeIds)

      // 7. Draw to canvas
      try {
        const img = await loadImage(dataUrl)
        const imgAspect = img.width / img.height
        const canvasAspect = canvas.width / canvas.height
        let drawW = canvas.width, drawH = canvas.height, drawX = 0, drawY = 0
        if (imgAspect > canvasAspect) {
          drawH = canvas.width / imgAspect
          drawY = (canvas.height - drawH) / 2
        } else {
          drawW = canvas.height * imgAspect
          drawX = (canvas.width - drawW) / 2
        }
        ctx.fillStyle = '#fff'
        ctx.fillRect(0, 0, canvas.width, canvas.height)
        ctx.drawImage(img, drawX, drawY, drawW, drawH)
      } catch (e) {
        console.warn(`[FootprintLab] Frame ${i + 1} draw failed:`, e)
        continue
      }

      // 8. Capture canvas frame
      const track = stream.getVideoTracks()[0] as any
      if (track.requestFrame) track.requestFrame()

      // 9. Hold for correct duration
      const holdMs = Math.max(33, frame.displayDurationSec * 1000)
      await new Promise(r => setTimeout(r, holdMs))
    }

    if (!videoCancelled) await new Promise(r => setTimeout(r, 500))
  } finally {
    mediaRecorder.stop()
    progressText.textContent = 'Restoring scene…'
    // Restore all paths' placed shapes
    try {
      for (const config of scene) {
        if (config.participants.length > 0) await placePathParticipants(config)
      }
    } catch {}
  }
}

function cancelRecording() { videoCancelled = true }

function downloadVideo() {
  if (!videoBlob) return
  const url = URL.createObjectURL(videoBlob)
  const a = document.createElement('a')
  a.href = url
  a.download = `scene-animation-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.webm`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}


// =============================================================================
// STATIC EXPORT
// =============================================================================

let selectedExportFormat = 'svg'

function initFormatButtons() {
  document.querySelectorAll('.format-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.format-btn').forEach(b => b.classList.remove('active'))
      btn.classList.add('active')
      selectedExportFormat = (btn as HTMLElement).dataset.format || 'svg'
    })
  })
}

async function exportScene() {
  const exportStatus = document.getElementById('export-status')!
  exportStatus.textContent = 'Exporting...'
  try {
    const requestId = 'export_' + Date.now().toString(36)
    const result = await new Promise<{ filename: string }>((resolve, reject) => {
      const handler = (event: MessageEvent) => {
        if (event.data?.type === 'ext:export-response' && event.data?.payload?.requestId === requestId) { window.removeEventListener('message', handler); resolve(event.data.payload) }
        if (event.data?.type === 'ext:error' && event.data?.payload?.requestId === requestId) { window.removeEventListener('message', handler); reject(new Error(event.data.payload.message)) }
      }
      window.addEventListener('message', handler)
      window.parent.postMessage({ type: 'ext:export-request', payload: { requestId, format: selectedExportFormat } }, '*')
      setTimeout(() => reject(new Error('timeout')), 30000)
    })
    exportStatus.textContent = `Exported ${result.filename}`
  } catch (e) { exportStatus.textContent = `Error: ${e}` }
}


// =============================================================================
// EXPOSE TO WINDOW (for inline onclick handlers)
// =============================================================================

;(window as any).addSegment = addSegment
;(window as any).onSegModeChange = onSegModeChange
;(window as any).generateParticipants = generateParticipants
;(window as any).placeActivePathParticipants = placeActivePathParticipants
;(window as any).placeAllPaths = placeAllPaths
;(window as any).clearActivePath = clearActivePath
;(window as any).onStartOffsetChange = onStartOffsetChange
;(window as any).onPathLengthChange = onPathLengthChange
;(window as any).onGlobalSamplingRateChange = onGlobalSamplingRateChange
;(window as any).exportSceneJSON = exportSceneJSON
;(window as any).importSceneJSON = importSceneJSON
;(window as any).exportScene = exportScene
;(window as any).onVideoSettingsChange = onVideoSettingsChange
;(window as any).recordVideo = recordVideo
;(window as any).cancelRecording = cancelRecording
;(window as any).downloadVideo = downloadVideo

Object.defineProperty(window, 'scene', { get: () => scene })
Object.defineProperty(window, 'activePathId', { get: () => activePathId })
Object.defineProperty(window, 'globalSamplingRate', { get: () => globalSamplingRate, set: (v: number) => { globalSamplingRate = v } })


// =============================================================================
// INIT
// =============================================================================

async function main() {
  client = new ExtensionClient('path-footprint-lab')
  const init = await client.waitForInit()
  console.log('Path Footprint Lab (multi-path) connected:', init.grantedCapabilities)
  initFormatButtons()
  initJSONDropZone()
  renderAll()
  setInterval(pollSelection, 500)
}

main()