// Path Footprint Lab - Development extension for variable footprint positioning
// Segment-based simulation: piecewise speed profiles with per-segment sampling

// --- Inline ExtensionClient ---

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

// --- Inline geometry ---

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
//
// Each segment defines a constant-speed phase:
//   { speed, speedUnit, duration, durationUnit, samplingRate, samplingRateUnit }
//
// Pipeline (per segment, then concatenated):
//   1. Resolve N_i samples and time window [T_start, T_end] for segment i
//   2. Generate sample timestamps within the window
//   3. Compute cumulative distance at each timestamp:
//        dist(t) = prior_segments_distance + speed_i × (t - T_start_i)
//   4. Normalize all distances by total distance → path t-values [0, 1]
//
// This naturally produces non-uniform spacing when segments have different speeds.
// =============================================================================

type SpeedUnit = 'km/h' | 'm/s' | 'mph'
type TimeUnit = 's' | 'min' | 'hr'
type SamplingRateUnit = 'total' | '/s' | '/min' | '/hr'

interface SpeedSegment {
  speed: number
  speedUnit: SpeedUnit
  duration: number
  durationUnit: TimeUnit
  samplingRate: number
  samplingRateUnit: SamplingRateUnit
}

// --- Unit conversions ---

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

function resolveCount(rate: number, rateUnit: SamplingRateUnit, durationSec: number): number {
  switch (rateUnit) {
    case 'total': return Math.max(1, Math.round(rate))
    case '/s':    return Math.max(1, Math.round(rate * durationSec))
    case '/min':  return Math.max(1, Math.round(rate * (durationSec / 60)))
    case '/hr':   return Math.max(1, Math.round(rate * (durationSec / 3600)))
  }
}

// --- Display formatting ---

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

// --- Pipeline ---

interface SegmentComputed {
  speedMs: number
  durationSec: number
  numSamples: number
  distanceM: number
  intervalSec: number
  timeStartSec: number   // absolute start time
}

interface SimulationResult {
  tValues: number[]
  totalParticipants: number
  totalDurationSec: number
  totalDistanceM: number
  segmentsComputed: SegmentComputed[]
}

function runSegmentPipeline(segments: SpeedSegment[]): SimulationResult | { error: string } {
  if (segments.length === 0) return { error: 'Add at least one segment' }

  // 1. Pre-compute each segment's resolved values
  const computed: SegmentComputed[] = []
  let cumulativeTime = 0
  let totalParticipants = 0

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    const speedMs = speedToMs(seg.speed, seg.speedUnit)
    const durationSec = timeToSeconds(seg.duration, seg.durationUnit)
    const numSamples = resolveCount(seg.samplingRate, seg.samplingRateUnit, durationSec)

    if (speedMs <= 0) return { error: `Segment ${i + 1}: speed must be positive` }
    if (durationSec <= 0) return { error: `Segment ${i + 1}: duration must be positive` }

    const distanceM = speedMs * durationSec
    const intervalSec = durationSec / numSamples

    computed.push({
      speedMs,
      durationSec,
      numSamples,
      distanceM,
      intervalSec,
      timeStartSec: cumulativeTime,
    })

    cumulativeTime += durationSec
    totalParticipants += numSamples
  }

  if (totalParticipants > 200) return { error: `Too many participants (${totalParticipants}). Max 200.` }

  const totalDurationSec = cumulativeTime
  const totalDistanceM = computed.reduce((sum, c) => sum + c.distanceM, 0)

  if (totalDistanceM <= 0) return { error: 'Total distance is zero' }

  // 2. Generate sample timestamps and compute cumulative distances
  const allDistances: number[] = []
  let priorDistance = 0

  for (const seg of computed) {
    for (let j = 1; j <= seg.numSamples; j++) {
      // Time within this segment: j * interval (excludes seg start, includes seg end)
      const dt = j * seg.intervalSec
      const cumulDist = priorDistance + seg.speedMs * dt
      allDistances.push(cumulDist)
    }
    priorDistance += seg.distanceM
  }

  // 3. Normalize to t ∈ [0, 1]
  const tValues = allDistances.map(d => Math.min(1, d / totalDistanceM))

  return {
    tValues,
    totalParticipants,
    totalDurationSec,
    totalDistanceM,
    segmentsComputed: computed,
  }
}


// =============================================================================
// STATE
// =============================================================================

let idCounter = 0
function nextId(prefix = 'fplab'): string { return `${prefix}_${++idCounter}_${Date.now().toString(36)}` }

let client: ExtensionClient
let selectedPathId: string | null = null
let selectedPathPoints: Point2D[] = []
let footprints: Array<{ t: number }> = []

let activeMode: 'manual' | 'simulation' = 'manual'

// Segment list for simulation mode
let segments: SpeedSegment[] = []

// Per-path state persistence
interface PathState {
  footprints: Array<{ t: number }>
  templateId: string
  placedShapeIds: string[]
  isPlaced: boolean
  needsUpdate: boolean
  activeMode: 'manual' | 'simulation'
  segments: SpeedSegment[]
}
const pathStateMap = new Map<string, PathState>()

// UI state tracking
let isPlaced = false
let needsUpdate = false
let placedShapeIds: string[] = []

// Template definitions
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
let selectedTemplate = TEMPLATES[0]


// =============================================================================
// UI STATE MANAGEMENT
// =============================================================================

function showPanel(hasPath: boolean) {
  document.getElementById('no-path-state')!.style.display = hasPath ? 'none' : 'flex'
  document.getElementById('path-panel')!.style.display = hasPath ? 'block' : 'none'
}

function updateUIState() {
  const btnPlace = document.getElementById('btn-place')!
  const updateBanner = document.getElementById('update-banner')!
  const liveIndicator = document.getElementById('live-indicator')!
  const btnRemoveLast = document.getElementById('btn-remove-last')!
  const participantCount = document.getElementById('participant-count')!

  participantCount.textContent = String(footprints.length)
  btnRemoveLast.style.display = footprints.length > 0 ? 'inline-block' : 'none'

  if (footprints.length === 0) {
    btnPlace.style.display = 'none'
    updateBanner.style.display = 'none'
    liveIndicator.style.display = 'none'
  } else if (!isPlaced) {
    btnPlace.style.display = 'block'
    updateBanner.style.display = 'none'
    liveIndicator.style.display = 'none'
  } else if (needsUpdate) {
    btnPlace.style.display = 'none'
    updateBanner.style.display = 'block'
    liveIndicator.style.display = 'none'
  } else {
    btnPlace.style.display = 'none'
    updateBanner.style.display = 'none'
    liveIndicator.style.display = 'block'
  }

  // Update video section visibility
  updateVideoUI()
}

function switchMode(mode: 'manual' | 'simulation') {
  activeMode = mode
  document.querySelectorAll('.mode-tab').forEach(tab => {
    tab.classList.toggle('active', (tab as HTMLElement).dataset.mode === mode)
  })
  document.getElementById('mode-manual')!.classList.toggle('active', mode === 'manual')
  document.getElementById('mode-simulation')!.classList.toggle('active', mode === 'simulation')
  if (mode === 'simulation') {
    renderSegmentList()
    updateTotals()
  }
  saveCurrentPathState()
}


// =============================================================================
// SEGMENT LIST UI
// =============================================================================

function renderSegmentList() {
  const container = document.getElementById('seg-list')!
  container.innerHTML = ''

  if (segments.length === 0) {
    container.innerHTML = '<div class="seg-empty">No segments yet</div>'
    return
  }

  segments.forEach((seg, i) => {
    const speedMs = speedToMs(seg.speed, seg.speedUnit)
    const durSec = timeToSeconds(seg.duration, seg.durationUnit)
    const count = resolveCount(seg.samplingRate, seg.samplingRateUnit, durSec)
    const dist = speedMs * durSec

    const card = document.createElement('div')
    card.className = 'seg-card'
    card.innerHTML = `
      <span class="seg-num">${i + 1}</span>
      <div class="seg-info">
        <div class="seg-main">${seg.speed} ${seg.speedUnit} × ${seg.duration} ${seg.durationUnit}</div>
        <div class="seg-detail">${count} pts · ${formatDistance(dist)} · ${formatDuration(durSec / count)} interval</div>
      </div>
      <button class="seg-remove" data-index="${i}">&times;</button>
    `

    card.querySelector('.seg-remove')!.addEventListener('click', () => {
      segments.splice(i, 1)
      renderSegmentList()
      updateTotals()
      saveCurrentPathState()
    })

    container.appendChild(card)
  })
}

function updateTotals() {
  const totalsEl = document.getElementById('sim-totals')!
  const generateBtn = document.getElementById('btn-generate') as HTMLButtonElement

  if (segments.length === 0) {
    totalsEl.className = 'sim-totals empty'
    totalsEl.innerHTML = '<div style="text-align:center;">Add segments to build a speed profile</div>'
    generateBtn.disabled = true
    return
  }

  const result = runSegmentPipeline(segments)

  if ('error' in result) {
    totalsEl.className = 'sim-totals empty'
    totalsEl.innerHTML = `<div style="text-align:center;color:#991b1b;">${result.error}</div>`
    generateBtn.disabled = true
    return
  }

  generateBtn.disabled = false
  totalsEl.className = 'sim-totals'
  totalsEl.innerHTML = `
    <div class="totals-line"><span>Total participants</span><span class="totals-value">${result.totalParticipants}</span></div>
    <div class="totals-line"><span>Total duration</span><span class="totals-value">${formatDuration(result.totalDurationSec)}</span></div>
    <div class="totals-line"><span>Total distance</span><span class="totals-value">${formatDistance(result.totalDistanceM)}</span></div>
    <div class="totals-line"><span>Segments</span><span class="totals-value">${segments.length}</span></div>
  `
}

function addSegment() {
  const speed = parseFloat((document.getElementById('seg-speed') as HTMLInputElement).value) || 0
  const speedUnit = (document.getElementById('seg-speed-unit') as HTMLSelectElement).value as SpeedUnit
  const duration = parseFloat((document.getElementById('seg-time') as HTMLInputElement).value) || 0
  const durationUnit = (document.getElementById('seg-time-unit') as HTMLSelectElement).value as TimeUnit
  const samplingRate = parseFloat((document.getElementById('seg-rate') as HTMLInputElement).value) || 0
  const samplingRateUnit = (document.getElementById('seg-rate-unit') as HTMLSelectElement).value as SamplingRateUnit

  if (speed <= 0 || duration <= 0 || samplingRate <= 0) {
    setStatus('All segment values must be positive')
    return
  }

  segments.push({ speed, speedUnit, duration, durationUnit, samplingRate, samplingRateUnit })
  renderSegmentList()
  updateTotals()
  saveCurrentPathState()
}

function generateFromSimulation() {
  const result = runSegmentPipeline(segments)

  if ('error' in result) {
    setStatus(`Error: ${result.error}`)
    return
  }

  cancelLiveUpdate()

  const wasPlaced = isPlaced

  footprints = result.tValues.map(t => ({ t: parseFloat(t.toFixed(4)) }))

  // Switch to manual to show generated sliders for fine-tuning
  switchMode('manual')
  renderFootprintList()

  if (wasPlaced) {
    needsUpdate = true
  }
  updateUIState()
  saveCurrentPathState()

  const segSummary = result.segmentsComputed.map((s, i) =>
    `Seg${i + 1}: ${formatSpeed(s.speedMs)}×${formatDuration(s.durationSec)}→${s.numSamples}pts`
  ).join(' | ')
  setStatus(`Generated ${result.totalParticipants} positions. ${segSummary}`)
  client.notify(`${result.totalParticipants} positions generated from ${segments.length} segment(s)`, 'success')
}


// =============================================================================
// SAVE / RESTORE PER-PATH STATE
// =============================================================================

function saveCurrentPathState() {
  if (!selectedPathId) return
  pathStateMap.set(selectedPathId, {
    footprints: footprints.map(f => ({ t: f.t })),
    templateId: selectedTemplate.id,
    placedShapeIds: [...placedShapeIds],
    isPlaced,
    needsUpdate,
    activeMode,
    segments: segments.map(s => ({ ...s })),
  })
}

function restorePathState(pathId: string) {
  const saved = pathStateMap.get(pathId)
  if (saved) {
    footprints = saved.footprints.map(f => ({ t: f.t }))
    const tmpl = TEMPLATES.find(t => t.id === saved.templateId)
    if (tmpl) selectedTemplate = tmpl
    placedShapeIds = [...saved.placedShapeIds]
    isPlaced = saved.isPlaced
    needsUpdate = saved.needsUpdate
    activeMode = saved.activeMode
    segments = saved.segments.map(s => ({ ...s }))
  } else {
    footprints = []
    placedShapeIds = []
    isPlaced = false
    needsUpdate = false
    activeMode = 'manual'
    segments = []
  }
}


// =============================================================================
// UI RENDERING
// =============================================================================

function hostUrl(path: string): string {
  try {
    const parentOrigin = document.referrer ? new URL(document.referrer).origin : window.location.origin
    return parentOrigin + path
  } catch { return path }
}

function renderTemplateGrid() {
  const container = document.getElementById('template-grid')!
  container.innerHTML = ''
  TEMPLATES.forEach(tmpl => {
    const btn = document.createElement('button')
    btn.className = `template-btn${tmpl.id === selectedTemplate.id ? ' active' : ''}`
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
    btn.addEventListener('click', () => { selectedTemplate = tmpl; renderTemplateGrid(); saveCurrentPathState() })
    container.appendChild(btn)
  })
}

function renderFootprintList() {
  const container = document.getElementById('footprint-list')!
  container.innerHTML = ''

  footprints.forEach((fp, i) => {
    const row = document.createElement('div')
    row.className = 'footprint-row'
    row.innerHTML = `
      <span class="index">${i + 1}</span>
      <input type="range" min="0" max="1" step="0.01" value="${fp.t}" data-index="${i}" />
      <span class="t-value">${fp.t.toFixed(2)}</span>
      <button class="btn-remove" data-index="${i}">&times;</button>
    `
    const slider = row.querySelector('input')!
    slider.addEventListener('input', (e) => {
      const idx = parseInt((e.target as HTMLInputElement).dataset.index!)
      footprints[idx].t = parseFloat((e.target as HTMLInputElement).value)
      row.querySelector('.t-value')!.textContent = footprints[idx].t.toFixed(2)
      if (isPlaced && !needsUpdate) debouncedLiveUpdate()
      saveCurrentPathState()
    })
    const removeBtn = row.querySelector('button')!
    removeBtn.addEventListener('click', (e) => {
      const idx = parseInt((e.target as HTMLButtonElement).dataset.index!)
      footprints.splice(idx, 1)
      renderFootprintList()
      cancelLiveUpdate()
      if (isPlaced) { needsUpdate = true }
      if (footprints.length === 0) { clearPlacedShapes(); isPlaced = false; needsUpdate = false }
      updateUIState()
      saveCurrentPathState()
    })
    container.appendChild(row)
  })
  updateUIState()
}

function setStatus(msg: string) {
  document.getElementById('status')!.textContent = msg
}


// =============================================================================
// LIVE UPDATE (debounced delete-and-recreate)
// =============================================================================

let liveDebounceTimer: ReturnType<typeof setTimeout> | null = null
let liveUpdateBusy = false
let liveUpdateDirty = false
let liveUpdateAborted = false

function cancelLiveUpdate() {
  if (liveDebounceTimer) { clearTimeout(liveDebounceTimer); liveDebounceTimer = null }
  liveUpdateAborted = true
  liveUpdateDirty = false
}

function debouncedLiveUpdate() {
  if (liveDebounceTimer) clearTimeout(liveDebounceTimer)
  liveDebounceTimer = setTimeout(() => { liveDebounceTimer = null; runLiveUpdate() }, 120)
}

async function runLiveUpdate() {
  if (!selectedPathId || selectedPathPoints.length < 2) return
  if (!isPlaced || needsUpdate) return
  if (footprints.length === 0) return
  if (liveUpdateBusy) { liveUpdateDirty = true; return }

  liveUpdateBusy = true
  liveUpdateDirty = false
  liveUpdateAborted = false
  const pathId = selectedPathId

  try {
    if (liveUpdateAborted) return
    const freshShapes = await client.requestShapes({ ids: [pathId] })
    if (liveUpdateAborted) return
    const freshPath = freshShapes.find(s => s.id === pathId)
    if (freshPath) {
      const dp = freshPath.props._displayPoints as Point2D[] | undefined
      if (dp && dp.length >= 2) selectedPathPoints = dp
    }
    if (liveUpdateAborted) return

    if (placedShapeIds.length > 0) {
      client.deleteShapes(placedShapeIds)
      await new Promise(r => setTimeout(r, 150))
    }
    if (liveUpdateAborted) return

    const sorted = [...footprints].sort((a, b) => a.t - b.t)
    const shapeType = selectedTemplate.type === 'pedestrian' ? 'pedestrian' : 'vehicle'
    const attrType = selectedTemplate.type === 'pedestrian' ? 'pedestrian' : 'vehicle'
    const attrSubtype = selectedTemplate.type === 'pedestrian' ? 'person' : 'car'

    const shapes: BaseShape[] = sorted.map(fp => {
      const ev = evaluatePathAt(selectedPathPoints, fp.t)
      return {
        id: nextId('fp'), type: shapeType,
        x: ev.position.x, y: ev.position.y, rotation: ev.tangentAngleDeg,
        zIndex: shapeType === 'pedestrian' ? 3000 : 4000,
        props: {
          w: selectedTemplate.w, h: selectedTemplate.h,
          color: 'black', size: 'm', opacity: 1,
          attributes: { type: attrType, subtype: attrSubtype },
          osmId: '', templateId: selectedTemplate.id, parentPathId: pathId,
        },
      }
    })
    client.addShapes(shapes)
    await new Promise(r => setTimeout(r, 350))
    if (liveUpdateAborted) return

    let allOfType: BaseShape[] = []
    for (const qt of ['vehicle', 'pedestrian']) {
      allOfType = allOfType.concat(await client.requestShapes({ types: [qt] }))
    }
    if (liveUpdateAborted) return

    placedShapeIds = allOfType.filter(s => s.props.parentPathId === pathId).map(s => s.id)

    if (placedShapeIds.length > 0) {
      const arcLengths = computeArcLengths(selectedPathPoints)
      const totalLen = arcLengths[arcLengths.length - 1]
      const interval = sorted.length > 1 ? Math.round(totalLen / (sorted.length - 1)) : Math.round(totalLen)
      client.updateShapes([{
        id: pathId,
        props: {
          footprint: { interval, offset: 0, templateId: selectedTemplate.id, anchorOffset: 0, mode: 'variable', tValues: sorted.map(f => f.t) },
          footprintIds: placedShapeIds,
        },
      }])
    }
    saveCurrentPathState()
  } catch (e) {
    console.warn('[FootprintLab] Live update error:', e)
  } finally {
    liveUpdateBusy = false
    if (!liveUpdateAborted && liveUpdateDirty) { liveUpdateDirty = false; runLiveUpdate() }
  }
}


// =============================================================================
// FULL RE-PLACE SHAPES
// =============================================================================

async function fullRePlaceShapes() {
  if (!selectedPathId || selectedPathPoints.length < 2) return 0
  if (footprints.length === 0) return 0
  try {
    const freshShapes = await client.requestShapes({ ids: [selectedPathId] })
    const freshPath = freshShapes.find(s => s.id === selectedPathId)
    if (freshPath) {
      const dp = freshPath.props._displayPoints as Point2D[] | undefined
      if (dp && dp.length >= 2) selectedPathPoints = dp
    }
    await clearPlacedShapes()

    const sorted = [...footprints].sort((a, b) => a.t - b.t)
    const arcLengths = computeArcLengths(selectedPathPoints)
    const totalLen = arcLengths[arcLengths.length - 1]
    const interval = sorted.length > 1 ? Math.round(totalLen / (sorted.length - 1)) : Math.round(totalLen)

    const shapeType = selectedTemplate.type === 'pedestrian' ? 'pedestrian' : 'vehicle'
    const attrType = selectedTemplate.type === 'pedestrian' ? 'pedestrian' : 'vehicle'
    const attrSubtype = selectedTemplate.type === 'pedestrian' ? 'person' : 'car'

    const shapes: BaseShape[] = sorted.map(fp => {
      const ev = evaluatePathAt(selectedPathPoints, fp.t)
      return {
        id: nextId('fp'), type: shapeType,
        x: ev.position.x, y: ev.position.y, rotation: ev.tangentAngleDeg,
        zIndex: shapeType === 'pedestrian' ? 3000 : 4000,
        props: {
          w: selectedTemplate.w, h: selectedTemplate.h,
          color: 'black', size: 'm', opacity: 1,
          attributes: { type: attrType, subtype: attrSubtype },
          osmId: '', templateId: selectedTemplate.id, parentPathId: selectedPathId,
        },
      }
    })
    client.addShapes(shapes)
    await new Promise(r => setTimeout(r, 500))

    let allOfType: BaseShape[] = []
    for (const qt of ['vehicle', 'pedestrian']) {
      allOfType = allOfType.concat(await client.requestShapes({ types: [qt] }))
    }
    placedShapeIds = allOfType.filter(s => s.props.parentPathId === selectedPathId).map(s => s.id)

    if (placedShapeIds.length > 0) {
      client.updateShapes([{
        id: selectedPathId,
        props: {
          footprint: { interval, offset: 0, templateId: selectedTemplate.id, anchorOffset: 0, mode: 'variable', tValues: sorted.map(f => f.t) },
          footprintIds: placedShapeIds,
        },
      }])
    }
    isPlaced = true; needsUpdate = false
    updateUIState(); saveCurrentPathState()
    return placedShapeIds.length
  } catch (e) { setStatus(`Error: ${e}`); return 0 }
}

async function clearPlacedShapes() {
  if (!selectedPathId) return
  try {
    let all: BaseShape[] = []
    for (const qt of ['vehicle', 'pedestrian']) all = all.concat(await client.requestShapes({ types: [qt] }))
    const ids = all.filter(s => s.props.parentPathId === selectedPathId).map(s => s.id)
    if (ids.length > 0) { client.deleteShapes(ids); await new Promise(r => setTimeout(r, 200)) }
    client.updateShapes([{ id: selectedPathId, props: { footprintIds: [] } }])
    await new Promise(r => setTimeout(r, 100))
    placedShapeIds = []
  } catch (e) { console.warn('[FootprintLab] Error clearing shapes:', e) }
}


// =============================================================================
// ACTIONS
// =============================================================================

async function refreshSelection() {
  try {
    const selection = await client.requestSelection()
    if (selection.ids.length === 0) {
      saveCurrentPathState()
      document.getElementById('path-info')!.textContent = 'No path selected'
      selectedPathId = null; selectedPathPoints = []; showPanel(false); return
    }
    const shapes = await client.requestShapes({ ids: selection.ids })
    const path = shapes.find(s => s.type === 'linestring' && s.props.isPath)
    if (!path) {
      document.getElementById('path-info')!.textContent = 'Selected shape is not a path'
      selectedPathId = null; selectedPathPoints = []; showPanel(false); return
    }

    const previousPathId = selectedPathId
    if (previousPathId && previousPathId !== path.id) saveCurrentPathState()
    selectedPathId = path.id

    const displayPoints = path.props._displayPoints as Point2D[] | undefined
    if (displayPoints && displayPoints.length >= 2) {
      selectedPathPoints = displayPoints
    } else {
      const pointIds = path.props.pointIds as string[]
      const allShapes = await client.requestShapes({ ids: pointIds })
      selectedPathPoints = pointIds.map(pid => {
        const pt = allShapes.find(s => s.id === pid)
        return pt ? { x: pt.x, y: pt.y } : { x: 0, y: 0 }
      }).filter(p => p.x !== 0 || p.y !== 0)
    }

    restorePathState(path.id)

    const smoothed = displayPoints ? ' (smoothed)' : ' (raw)'
    document.getElementById('path-info')!.textContent = `Path: ${path.id.slice(0, 16)}... (${selectedPathPoints.length} pts${smoothed})`

    showPanel(true)
    renderTemplateGrid()
    renderFootprintList()
    switchMode(activeMode)
    renderSegmentList()
    updateTotals()
    updateUIState()
    setStatus('Path selected')
  } catch (e) { setStatus(`Error: ${e}`) }
}

function addFootprint() {
  const maxT = footprints.length > 0 ? Math.max(...footprints.map(f => f.t)) : 0
  footprints.push({ t: parseFloat(Math.min(1, maxT + 0.1).toFixed(2)) })
  renderFootprintList()
  cancelLiveUpdate()
  if (isPlaced) needsUpdate = true
  updateUIState(); saveCurrentPathState()
}

function removeLastFootprint() {
  if (footprints.length === 0) return
  footprints.pop(); renderFootprintList(); cancelLiveUpdate()
  if (isPlaced) {
    if (footprints.length === 0) { clearPlacedShapes(); isPlaced = false; needsUpdate = false }
    else needsUpdate = true
  }
  updateUIState(); saveCurrentPathState()
}

async function placeParticipants() {
  if (!selectedPathId || selectedPathPoints.length < 2) { setStatus('Select a path first'); return }
  if (footprints.length === 0) { setStatus('Add at least one participant'); return }
  setStatus('Placing participants...')
  const count = await fullRePlaceShapes()
  if (count > 0) { client.notify(`${count} participants placed`, 'success'); setStatus(`Placed ${count} participants — drag sliders to reposition`) }
}

async function updateParticipantPositions() {
  if (!selectedPathId || selectedPathPoints.length < 2) { setStatus('Select a path first'); return }
  if (footprints.length === 0) { setStatus('Add at least one participant'); return }
  setStatus('Updating positions...')
  const count = await fullRePlaceShapes()
  if (count > 0) { client.notify(`${count} positions updated`, 'success'); setStatus(`Updated ${count} participants — drag sliders to reposition`) }
}

async function clearFootprints() {
  if (!selectedPathId) { setStatus('Select a path first'); return }
  try {
    await clearPlacedShapes()
    footprints = []; placedShapeIds = []; isPlaced = false; needsUpdate = false
    renderFootprintList(); updateUIState(); saveCurrentPathState()
    client.notify('All participants cleared', 'info'); setStatus('Cleared')
  } catch (e) { setStatus(`Error: ${e}`) }
}

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
// VIDEO GENERATION ENGINE
// =============================================================================
// Renders path + moving vehicle on a <canvas>, uses MediaRecorder for WebM.
// Variable frame timing: each frame is held on canvas for its real-time
// duration / playback_speed, so MediaRecorder naturally captures correct timing.
// =============================================================================

interface FrameSpec {
  index: number
  tValue: number            // position on path [0, 1]
  realTimeSec: number       // absolute real-world timestamp
  displayDurationSec: number // how long to hold this frame in video
  segmentIndex: number      // which speed segment (-1 for manual mode)
  speedMs: number           // speed during this frame (0 for manual)
}

interface VideoSettings {
  targetDurationSec: number
  showTrail: boolean
  showHUD: boolean
  showDirection: boolean
}

let videoSettings: VideoSettings = {
  targetDurationSec: 10,
  showTrail: true,
  showHUD: true,
  showDirection: true,
}

let videoBlob: Blob | null = null
let videoRecording = false
let videoCancelled = false

// --- Frame spec computation ---

function computeFrameSpecs(targetDurationSec: number): FrameSpec[] | { error: string } {
  if (footprints.length === 0) return { error: 'No participants to animate' }
  if (targetDurationSec <= 0) return { error: 'Duration must be positive' }

  const sorted = [...footprints].map((f, i) => ({ t: f.t, origIdx: i })).sort((a, b) => a.t - b.t)

  // If segments exist, use real timing from segment pipeline
  if (segments.length > 0) {
    const result = runSegmentPipeline(segments)
    if ('error' in result) return result

    const { segmentsComputed, totalDurationSec: realDurationSec } = result
    const playbackSpeed = realDurationSec / targetDurationSec

    // Build absolute real-time timestamps per sample
    const realTimestamps: number[] = []
    const segIndices: number[] = []
    const speeds: number[] = []

    for (let si = 0; si < segmentsComputed.length; si++) {
      const seg = segmentsComputed[si]
      for (let j = 1; j <= seg.numSamples; j++) {
        realTimestamps.push(seg.timeStartSec + j * seg.intervalSec)
        segIndices.push(si)
        speeds.push(seg.speedMs)
      }
    }

    // The pipeline may have produced different count than current footprints
    // (user may have manually added/removed after generation)
    // Use min of both to stay safe
    const frameCount = Math.min(sorted.length, realTimestamps.length)
    const frames: FrameSpec[] = []

    for (let i = 0; i < frameCount; i++) {
      const prevTime = i === 0 ? 0 : realTimestamps[i - 1]
      const realInterval = realTimestamps[i] - prevTime
      frames.push({
        index: i,
        tValue: sorted[i].t,
        realTimeSec: realTimestamps[i],
        displayDurationSec: realInterval / playbackSpeed,
        segmentIndex: segIndices[i],
        speedMs: speeds[i],
      })
    }

    return frames
  }

  // Manual mode: equal timing
  const frameDuration = targetDurationSec / sorted.length
  return sorted.map((fp, i) => ({
    index: i,
    tValue: fp.t,
    realTimeSec: (i + 1) * frameDuration * (1), // synthetic
    displayDurationSec: frameDuration,
    segmentIndex: -1,
    speedMs: 0,
  }))
}

// --- Canvas rendering ---

interface CanvasTransform {
  offsetX: number
  offsetY: number
  scale: number
  canvasW: number
  canvasH: number
}

function computeCanvasTransform(points: Point2D[], canvasW: number, canvasH: number, padding: number = 0.12): CanvasTransform {
  if (points.length === 0) return { offsetX: 0, offsetY: 0, scale: 1, canvasW, canvasH }

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const p of points) {
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
  }

  const pathW = maxX - minX || 1
  const pathH = maxY - minY || 1
  const padW = canvasW * padding
  const padH = canvasH * padding
  const usableW = canvasW - 2 * padW
  const usableH = canvasH - 2 * padH
  const scale = Math.min(usableW / pathW, usableH / pathH)
  const offsetX = padW + (usableW - pathW * scale) / 2 - minX * scale
  const offsetY = padH + (usableH - pathH * scale) / 2 - minY * scale

  return { offsetX, offsetY, scale, canvasW, canvasH }
}

function toCanvas(p: Point2D, tf: CanvasTransform): { x: number; y: number } {
  return { x: p.x * tf.scale + tf.offsetX, y: p.y * tf.scale + tf.offsetY }
}

function renderFrame(
  ctx: CanvasRenderingContext2D,
  frame: FrameSpec,
  allFrames: FrameSpec[],
  points: Point2D[],
  tf: CanvasTransform,
  settings: VideoSettings,
  totalFrames: number,
  totalRealDuration: number,
  playbackSpeed: number,
) {
  const W = tf.canvasW
  const H = tf.canvasH

  // --- Background ---
  ctx.fillStyle = '#1a1a2e'
  ctx.fillRect(0, 0, W, H)

  // --- Grid (subtle) ---
  ctx.strokeStyle = 'rgba(255,255,255,0.04)'
  ctx.lineWidth = 1
  const gridStep = 40
  for (let x = 0; x < W; x += gridStep) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke() }
  for (let y = 0; y < H; y += gridStep) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke() }

  // --- Path polyline ---
  if (points.length >= 2) {
    ctx.beginPath()
    const p0 = toCanvas(points[0], tf)
    ctx.moveTo(p0.x, p0.y)
    for (let i = 1; i < points.length; i++) {
      const pi = toCanvas(points[i], tf)
      ctx.lineTo(pi.x, pi.y)
    }
    ctx.strokeStyle = 'rgba(165, 180, 252, 0.5)'
    ctx.lineWidth = 2.5
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.stroke()

    // Direction arrows along path
    if (settings.showDirection) {
      const arrowInterval = Math.max(1, Math.floor(points.length / 8))
      for (let i = arrowInterval; i < points.length - 1; i += arrowInterval) {
        const cp = toCanvas(points[i], tf)
        const np = toCanvas(points[i + 1], tf)
        const dx = np.x - cp.x, dy = np.y - cp.y
        const len = Math.sqrt(dx * dx + dy * dy)
        if (len < 2) continue
        const ux = dx / len, uy = dy / len
        const sz = 5
        ctx.beginPath()
        ctx.moveTo(cp.x + ux * sz, cp.y + uy * sz)
        ctx.lineTo(cp.x - ux * sz * 0.5 - uy * sz * 0.6, cp.y - uy * sz * 0.5 + ux * sz * 0.6)
        ctx.lineTo(cp.x - ux * sz * 0.5 + uy * sz * 0.6, cp.y - uy * sz * 0.5 - ux * sz * 0.6)
        ctx.closePath()
        ctx.fillStyle = 'rgba(165, 180, 252, 0.3)'
        ctx.fill()
      }
    }
  }

  // --- Trail (previous positions) ---
  if (settings.showTrail && frame.index > 0) {
    for (let i = 0; i < frame.index; i++) {
      const prevFrame = allFrames[i]
      const ev = evaluatePathAt(points, prevFrame.tValue)
      const cp = toCanvas(ev.position, tf)
      const age = (frame.index - i) / Math.max(1, frame.index)
      const alpha = Math.max(0.08, 0.5 * (1 - age))
      ctx.beginPath()
      ctx.arc(cp.x, cp.y, 3, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(165, 180, 252, ${alpha})`
      ctx.fill()
    }
  }

  // --- Vehicle at current position ---
  const evResult = evaluatePathAt(points, frame.tValue)
  const vp = toCanvas(evResult.position, tf)
  const vehW = selectedTemplate.w * tf.scale * 0.6
  const vehH = selectedTemplate.h * tf.scale * 0.6
  const rotRad = (evResult.tangentAngleDeg * Math.PI) / 180

  ctx.save()
  ctx.translate(vp.x, vp.y)
  ctx.rotate(rotRad)

  // Vehicle body
  ctx.fillStyle = '#6366f1'
  ctx.strokeStyle = '#a5b4fc'
  ctx.lineWidth = 1.5
  const hw = vehW / 2, hh = vehH / 2
  const cornerR = Math.min(hw, hh) * 0.2
  ctx.beginPath()
  ctx.roundRect(-hw, -hh, vehW, vehH, cornerR)
  ctx.fill()
  ctx.stroke()

  // Windshield indicator (front of vehicle)
  ctx.fillStyle = 'rgba(255,255,255,0.4)'
  ctx.fillRect(-hw * 0.6, -hh, vehW * 0.6, vehH * 0.15)

  ctx.restore()

  // --- Glow around vehicle ---
  const gradient = ctx.createRadialGradient(vp.x, vp.y, 0, vp.x, vp.y, vehH * 1.5)
  gradient.addColorStop(0, 'rgba(99, 102, 241, 0.15)')
  gradient.addColorStop(1, 'rgba(99, 102, 241, 0)')
  ctx.fillStyle = gradient
  ctx.fillRect(vp.x - vehH * 2, vp.y - vehH * 2, vehH * 4, vehH * 4)

  // --- HUD overlay ---
  if (settings.showHUD) {
    ctx.font = '600 11px -apple-system, BlinkMacSystemFont, sans-serif'
    ctx.textBaseline = 'top'

    // Top-left: frame counter
    ctx.fillStyle = 'rgba(0,0,0,0.5)'
    ctx.fillRect(8, 8, 140, 50)
    ctx.fillStyle = '#e0e7ff'
    ctx.fillText(`Frame ${frame.index + 1} / ${totalFrames}`, 14, 14)

    ctx.font = '500 10px -apple-system, BlinkMacSystemFont, sans-serif'
    ctx.fillStyle = '#a5b4fc'
    const tPct = (frame.tValue * 100).toFixed(1)
    ctx.fillText(`Path: ${tPct}%`, 14, 30)

    if (frame.speedMs > 0) {
      ctx.fillText(`Speed: ${formatSpeed(frame.speedMs)}`, 14, 43)
    }

    // Top-right: time
    ctx.fillStyle = 'rgba(0,0,0,0.5)'
    ctx.fillRect(W - 128, 8, 120, 36)
    ctx.fillStyle = '#e0e7ff'
    ctx.font = '600 11px -apple-system, BlinkMacSystemFont, sans-serif'
    ctx.textAlign = 'right'
    ctx.fillText(`t = ${formatDuration(frame.realTimeSec)}`, W - 14, 14)
    ctx.font = '500 10px -apple-system, BlinkMacSystemFont, sans-serif'
    ctx.fillStyle = '#a5b4fc'
    ctx.fillText(`${playbackSpeed.toFixed(0)}× speed`, W - 14, 30)
    ctx.textAlign = 'left'

    // Bottom: progress bar
    const barY = H - 14, barH = 4, barPad = 12
    const barW = W - barPad * 2
    ctx.fillStyle = 'rgba(255,255,255,0.1)'
    ctx.fillRect(barPad, barY, barW, barH)
    ctx.fillStyle = '#6366f1'
    ctx.fillRect(barPad, barY, barW * frame.tValue, barH)

    // Segment color bands on progress bar
    if (segments.length > 1) {
      const result = runSegmentPipeline(segments)
      if (!('error' in result)) {
        let cumDist = 0
        const totalDist = result.totalDistanceM
        const segColors = ['#6366f1', '#8b5cf6', '#a78bfa', '#c4b5fd', '#7c3aed']
        for (let si = 0; si < result.segmentsComputed.length; si++) {
          const seg = result.segmentsComputed[si]
          const startFrac = cumDist / totalDist
          const endFrac = (cumDist + seg.distanceM) / totalDist
          cumDist += seg.distanceM
          ctx.fillStyle = segColors[si % segColors.length]
          ctx.globalAlpha = 0.3
          ctx.fillRect(barPad + barW * startFrac, barY - 2, barW * (endFrac - startFrac), barH + 4)
          ctx.globalAlpha = 1
        }
      }
    }
  }
}

// --- Video UI state ---

function updateVideoUI() {
  const needsEl = document.getElementById('video-needs-footprints')!
  const controlsEl = document.getElementById('video-controls')!

  if (footprints.length === 0) {
    needsEl.style.display = 'block'
    controlsEl.style.display = 'none'
  } else {
    needsEl.style.display = 'none'
    controlsEl.style.display = 'block'
    onVideoSettingsChange()
  }
}

function onVideoSettingsChange() {
  const dur = parseFloat((document.getElementById('vid-duration') as HTMLInputElement).value) || 10
  videoSettings.targetDurationSec = dur
  videoSettings.showTrail = (document.getElementById('vid-trail') as HTMLInputElement).checked
  videoSettings.showHUD = (document.getElementById('vid-overlay') as HTMLInputElement).checked
  videoSettings.showDirection = (document.getElementById('vid-direction') as HTMLInputElement).checked

  const specs = computeFrameSpecs(dur)
  const countEl = document.getElementById('vid-frame-count')!
  const speedEl = document.getElementById('vid-playback-speed')!
  const fpsEl = document.getElementById('vid-fps-range')!

  if ('error' in specs) {
    countEl.textContent = '—'
    speedEl.textContent = specs.error
    fpsEl.textContent = '—'
    return
  }

  countEl.textContent = `${specs.length}`

  // Compute playback speed
  if (segments.length > 0) {
    const result = runSegmentPipeline(segments)
    if (!('error' in result)) {
      const ps = result.totalDurationSec / dur
      speedEl.textContent = `${ps.toFixed(1)}×`

      // FPS range from variable frame durations
      const durations = specs.map(f => f.displayDurationSec).filter(d => d > 0)
      const minDur = Math.min(...durations)
      const maxDur = Math.max(...durations)
      const maxFps = (1 / minDur).toFixed(1)
      const minFps = (1 / maxDur).toFixed(1)
      fpsEl.textContent = minFps === maxFps ? `${maxFps} fps` : `${minFps}–${maxFps} fps`
    }
  } else {
    const ps = dur > 0 ? `${(1).toFixed(1)}×` : '—'
    speedEl.textContent = ps
    const fps = specs.length > 0 ? (specs.length / dur).toFixed(1) : '—'
    fpsEl.textContent = `${fps} fps (uniform)`
  }
}

// --- Recording ---

async function recordVideo() {
  if (footprints.length === 0) { setStatus('No participants to animate'); return }
  if (selectedPathPoints.length < 2) { setStatus('Select a path first'); return }

  // Read latest settings from DOM
  onVideoSettingsChange()

  const specs = computeFrameSpecs(videoSettings.targetDurationSec)
  if ('error' in specs) { setStatus(`Error: ${specs.error}`); return }
  if (specs.length === 0) { setStatus('No frames to record'); return }

  videoRecording = true
  videoCancelled = false
  videoBlob = null

  // UI state
  const canvas = document.getElementById('vid-canvas') as HTMLCanvasElement
  const recordBtn = document.getElementById('vid-record-btn')!
  const cancelBtn = document.getElementById('vid-cancel-btn')!
  const downloadBtn = document.getElementById('vid-download-btn')!
  const progressWrap = document.getElementById('vid-progress-wrap')!
  const progressBar = document.getElementById('vid-progress-bar')!
  const progressText = document.getElementById('vid-progress-text')!
  const progressPct = document.getElementById('vid-progress-pct')!

  canvas.style.display = 'block'
  recordBtn.style.display = 'none'
  cancelBtn.style.display = 'inline-block'
  downloadBtn.style.display = 'none'
  progressWrap.style.display = 'block'
  progressBar.style.width = '0%'
  progressText.textContent = 'Preparing...'
  progressPct.textContent = '0%'

  const ctx = canvas.getContext('2d')!
  const tf = computeCanvasTransform(selectedPathPoints, canvas.width, canvas.height)

  // Compute playback speed for HUD
  let playbackSpeed = 1
  const totalRealDuration = specs[specs.length - 1].realTimeSec
  if (segments.length > 0) {
    const result = runSegmentPipeline(segments)
    if (!('error' in result)) {
      playbackSpeed = result.totalDurationSec / videoSettings.targetDurationSec
    }
  }

  // Start MediaRecorder on canvas stream
  const stream = canvas.captureStream(0) // 0 = manual frame capture
  const mediaRecorder = new MediaRecorder(stream, {
    mimeType: 'video/webm;codecs=vp9',
    videoBitsPerSecond: 2_500_000,
  })

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

  // Render frames with correct timing
  try {
    for (let i = 0; i < specs.length; i++) {
      if (videoCancelled) break

      const frame = specs[i]
      const pct = ((i + 1) / specs.length * 100).toFixed(0)
      progressBar.style.width = `${pct}%`
      progressPct.textContent = `${pct}%`
      progressText.textContent = `Frame ${i + 1}/${specs.length}`

      // Render this frame
      renderFrame(ctx, frame, specs, selectedPathPoints, tf, videoSettings, specs.length, totalRealDuration, playbackSpeed)

      // Capture the frame to the stream
      const track = stream.getVideoTracks()[0] as any
      if (track.requestFrame) {
        track.requestFrame()
      }

      // Hold for the correct duration (this is what gives variable timing)
      const holdMs = Math.max(33, frame.displayDurationSec * 1000) // min 33ms (~30fps cap)
      await new Promise(r => setTimeout(r, holdMs))
    }

    // Hold last frame briefly
    if (!videoCancelled) {
      await new Promise(r => setTimeout(r, 500))
    }
  } finally {
    mediaRecorder.stop()
  }
}

function cancelRecording() {
  videoCancelled = true
}

function downloadVideo() {
  if (!videoBlob) return
  const url = URL.createObjectURL(videoBlob)
  const a = document.createElement('a')
  a.href = url
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  a.download = `path-animation-${timestamp}.webm`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}


// =============================================================================
// EXPOSE TO WINDOW
// =============================================================================

;(window as any).refreshSelection = refreshSelection
;(window as any).addFootprint = addFootprint
;(window as any).removeLastFootprint = removeLastFootprint
;(window as any).placeParticipants = placeParticipants
;(window as any).updateParticipantPositions = updateParticipantPositions
;(window as any).clearFootprints = clearFootprints
;(window as any).exportScene = exportScene
;(window as any).renderFootprintList = renderFootprintList
;(window as any).switchMode = switchMode
;(window as any).addSegment = addSegment
;(window as any).generateFromSimulation = generateFromSimulation
;(window as any).onVideoSettingsChange = onVideoSettingsChange
;(window as any).recordVideo = recordVideo
;(window as any).cancelRecording = cancelRecording
;(window as any).downloadVideo = downloadVideo

Object.defineProperty(window, 'selectedPathPoints', { get: () => selectedPathPoints })
Object.defineProperty(window, 'selectedPathId', { get: () => selectedPathId })
Object.defineProperty(window, 'footprints', { get: () => footprints, set: (v) => { footprints.length = 0; footprints.push(...v) } })
Object.defineProperty(window, 'pathStateMap', { get: () => pathStateMap })
Object.defineProperty(window, 'placedShapeIds', { get: () => placedShapeIds })
Object.defineProperty(window, 'segments', { get: () => segments })


// =============================================================================
// AUTO-DETECT SELECTION
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
        if (path) { if (path.id !== selectedPathId) await refreshSelection() }
      } else {
        if (!deselectionGraceTimer && selectedPathId) {
          deselectionGraceTimer = setTimeout(() => {
            deselectionGraceTimer = null
            if (lastSelectionId === null) { saveCurrentPathState(); selectedPathId = null; selectedPathPoints = []; showPanel(false) }
          }, 600)
        }
      }
    }
  } catch { /* ignore */ }
}


// =============================================================================
// INIT
// =============================================================================

async function main() {
  client = new ExtensionClient('path-footprint-lab')
  const init = await client.waitForInit()
  console.log('Path Footprint Lab connected:', init.grantedCapabilities)
  showPanel(false)
  renderTemplateGrid()
  renderFootprintList()
  initFormatButtons()
  setInterval(pollSelection, 500)
}

main()