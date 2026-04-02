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
// Host-based scene capture: for each frame, places a single vehicle on the path,
// captures the full host-rendered scene (all lanes, objects, styles) as PNG via
// the ext:export-request protocol, draws it to a <canvas>, and uses MediaRecorder
// for WebM output. Variable frame timing preserved via per-frame hold durations.
// =============================================================================

interface FrameSpec {
  index: number
  tValue: number            // position on path [0, 1]
  realTimeSec: number       // absolute real-world timestamp
  displayDurationSec: number // how long to hold this frame in video
}

interface VideoSettings {
  targetDurationSec: number
}

let videoSettings: VideoSettings = {
  targetDurationSec: 10,
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

    const realTimestamps: number[] = []
    for (let si = 0; si < segmentsComputed.length; si++) {
      const seg = segmentsComputed[si]
      for (let j = 1; j <= seg.numSamples; j++) {
        realTimestamps.push(seg.timeStartSec + j * seg.intervalSec)
      }
    }

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
      })
    }

    return frames
  }

  // Manual mode: equal timing
  const frameDuration = targetDurationSec / sorted.length
  return sorted.map((fp, i) => ({
    index: i,
    tValue: fp.t,
    realTimeSec: (i + 1) * frameDuration,
    displayDurationSec: frameDuration,
  }))
}


// =============================================================================
// HOST SCENE CAPTURE
// =============================================================================

/**
 * Captures the current host-rendered scene as a PNG data URL.
 * Uses the ext:export-request postMessage protocol with returnData: true.
 */
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
        if (data.payload.data) {
          resolve(data.payload.data as string)
        } else {
          reject(new Error('No data in export response'))
        }
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

/**
 * Load a data URL into an HTMLImageElement.
 */
function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Failed to load image'))
    img.src = dataUrl
  })
}

/**
 * Build a single vehicle/pedestrian shape at the given path evaluation result.
 */
function buildFrameShape(ev: PathEvalResult, pathId: string): BaseShape {
  const shapeType = selectedTemplate.type === 'pedestrian' ? 'pedestrian' : 'vehicle'
  const attrType = selectedTemplate.type === 'pedestrian' ? 'pedestrian' : 'vehicle'
  const attrSubtype = selectedTemplate.type === 'pedestrian' ? 'person' : 'car'
  return {
    id: nextId('vfr'), type: shapeType,
    x: ev.position.x, y: ev.position.y, rotation: ev.tangentAngleDeg,
    zIndex: shapeType === 'pedestrian' ? 3000 : 4000,
    props: {
      w: selectedTemplate.w, h: selectedTemplate.h,
      color: 'black', size: 'm', opacity: 1,
      attributes: { type: attrType, subtype: attrSubtype },
      osmId: '', templateId: selectedTemplate.id, parentPathId: pathId,
    },
  }
}

/**
 * Clear all placed participant shapes, place a single shape at the given t-value,
 * wait for host to render, capture the scene as PNG. Then clean up the temp shape.
 * Returns the captured data URL.
 */
async function captureFrameAtPosition(tValue: number): Promise<string> {
  if (!selectedPathId || selectedPathPoints.length < 2) throw new Error('No path selected')

  // 1. Clear existing placed shapes
  await clearPlacedShapes()
  await new Promise(r => setTimeout(r, 100))

  // 1b. Re-fetch path coordinates (guards against canvas pan/zoom since last call)
  try {
    const freshShapes = await client.requestShapes({ ids: [selectedPathId] })
    const freshPath = freshShapes.find(s => s.id === selectedPathId)
    if (freshPath) {
      const dp = freshPath.props._displayPoints as Point2D[] | undefined
      if (dp && dp.length >= 2) selectedPathPoints = dp
    }
  } catch (e) {
    console.warn('[FootprintLab] Preview path refresh failed, using cached:', e)
  }

  // 2. Place single shape at this t-value
  const ev = evaluatePathAt(selectedPathPoints, tValue)
  const shape = buildFrameShape(ev, selectedPathId)
  client.addShapes([shape])

  // 3. Wait for host to render the new shape
  await new Promise(r => setTimeout(r, 350))

  // 4. Capture the full scene from host
  const dataUrl = await captureHostFrame()

  // 5. Clean up the temp shape
  client.deleteShapes([shape.id])
  await new Promise(r => setTimeout(r, 100))

  return dataUrl
}


// =============================================================================
// PREVIEW (debounced host capture on scrub)
// =============================================================================

let previewDebounceTimer: ReturnType<typeof setTimeout> | null = null
let previewBusy = false

function showCaptureSpinner(show: boolean) {
  const spinner = document.getElementById('vid-capture-spinner')
  if (spinner) spinner.style.display = show ? 'flex' : 'none'
}

async function renderPreview(frameIndex?: number) {
  if (footprints.length === 0 || selectedPathPoints.length < 2) return
  if (!isPlaced) return // need shapes placed first for meaningful preview
  if (videoRecording) return // don't interfere with active recording

  const specs = computeFrameSpecs(videoSettings.targetDurationSec)
  if ('error' in specs || specs.length === 0) return

  const idx = frameIndex ?? Math.min(Math.floor(specs.length / 3), specs.length - 1)
  const frame = specs[Math.min(idx, specs.length - 1)]

  if (previewBusy) return
  previewBusy = true
  showCaptureSpinner(true)

  try {
    // Capture host scene with single vehicle at frame position
    const dataUrl = await captureFrameAtPosition(frame.tValue)

    // Draw captured image to preview canvas
    const canvas = document.getElementById('vid-canvas') as HTMLCanvasElement
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const img = await loadImage(dataUrl)
    // Scale to fit canvas while preserving aspect ratio
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

    // Restore all footprints after preview capture
    await fullRePlaceShapes()
  } catch (e) {
    console.warn('[FootprintLab] Preview capture error:', e)
    // Restore footprints even on error
    try { await fullRePlaceShapes() } catch {}
  } finally {
    previewBusy = false
    showCaptureSpinner(false)
  }
}

function debouncedPreview(frameIndex: number) {
  if (previewDebounceTimer) clearTimeout(previewDebounceTimer)
  previewDebounceTimer = setTimeout(() => { previewDebounceTimer = null; renderPreview(frameIndex) }, 500)
}


// =============================================================================
// VIDEO UI STATE
// =============================================================================

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

  // Update scrubber range
  const scrubEl = document.getElementById('vid-scrub') as HTMLInputElement
  const scrubMaxEl = document.getElementById('vid-scrub-max')!
  if (scrubEl && scrubMaxEl) {
    const maxIdx = Math.max(0, specs.length - 1)
    scrubEl.max = String(maxIdx)
    if (parseInt(scrubEl.value) > maxIdx) scrubEl.value = String(maxIdx)
    scrubMaxEl.textContent = String(specs.length)
  }
}

function onScrubChange() {
  const scrubEl = document.getElementById('vid-scrub') as HTMLInputElement
  if (!scrubEl) return
  const idx = parseInt(scrubEl.value) || 0
  debouncedPreview(idx)
}


// =============================================================================
// RECORDING — Host-based scene capture per frame
// =============================================================================
// FIX: Each frame now re-fetches _displayPoints from the host before computing
// the vehicle position. This makes each frame independently correct ("idempotent
// frame capture") even if the user pans, zooms, or moves the canvas mid-recording.
// =============================================================================

async function recordVideo() {
  if (footprints.length === 0) { setStatus('No participants to animate'); return }
  if (selectedPathPoints.length < 2) { setStatus('Select a path first'); return }
  if (!selectedPathId) { setStatus('Select a path first'); return }

  onVideoSettingsChange()

  const specs = computeFrameSpecs(videoSettings.targetDurationSec)
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

  // Start MediaRecorder on canvas stream
  const stream = canvas.captureStream(0) // 0 = manual frame capture

  let mimeType = 'video/webm;codecs=vp9'
  if (!MediaRecorder.isTypeSupported(mimeType)) {
    mimeType = 'video/webm;codecs=vp8'
    if (!MediaRecorder.isTypeSupported(mimeType)) {
      mimeType = 'video/webm'
    }
  }

  const mediaRecorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: 4_000_000, // higher bitrate for host-rendered PNGs
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

  const pathId = selectedPathId

  try {
    // Initial path fetch (seed value; each frame will re-fetch below)
    const freshShapes = await client.requestShapes({ ids: [pathId] })
    const freshPath = freshShapes.find(s => s.id === pathId)
    if (freshPath) {
      const dp = freshPath.props._displayPoints as Point2D[] | undefined
      if (dp && dp.length >= 2) selectedPathPoints = dp
    }

    for (let i = 0; i < specs.length; i++) {
      if (videoCancelled) break

      const frame = specs[i]
      const pct = ((i + 1) / specs.length * 100).toFixed(0)
      progressBar.style.width = `${pct}%`
      progressPct.textContent = `${pct}%`
      progressText.textContent = `Capturing frame ${i + 1}/${specs.length}…`

      // 1. Clear all placed footprints from canvas
      await clearPlacedShapes()
      if (videoCancelled) break
      await new Promise(r => setTimeout(r, 80))

      // 1b. Re-fetch path coordinates (guards against canvas pan/zoom mid-recording)
      //     Each frame is independently correct regardless of prior state.
      try {
        const framePathShapes = await client.requestShapes({ ids: [pathId] })
        const framePath = framePathShapes.find(s => s.id === pathId)
        if (framePath) {
          const dp = framePath.props._displayPoints as Point2D[] | undefined
          if (dp && dp.length >= 2) selectedPathPoints = dp
        }
      } catch (e) {
        console.warn(`[FootprintLab] Frame ${i + 1} path refresh failed, using cached:`, e)
      }
      if (videoCancelled) break

      // 2. Place single vehicle at this frame's position
      const ev = evaluatePathAt(selectedPathPoints, frame.tValue)
      const shape = buildFrameShape(ev, pathId)
      client.addShapes([shape])

      // 3. Wait for host to render the new shape
      await new Promise(r => setTimeout(r, 350))
      if (videoCancelled) { client.deleteShapes([shape.id]); break }

      // 4. Capture the full scene from host as PNG
      let dataUrl: string
      try {
        dataUrl = await captureHostFrame()
      } catch (e) {
        console.warn(`[FootprintLab] Frame ${i + 1} capture failed:`, e)
        client.deleteShapes([shape.id])
        continue
      }

      // 5. Remove temp shape
      client.deleteShapes([shape.id])

      // 6. Draw captured image to canvas
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

      // 7. Capture the canvas frame to the MediaRecorder stream
      const track = stream.getVideoTracks()[0] as any
      if (track.requestFrame) track.requestFrame()

      // 8. Hold for the correct duration (variable timing)
      const holdMs = Math.max(33, frame.displayDurationSec * 1000)
      await new Promise(r => setTimeout(r, holdMs))
    }

    // Hold last frame briefly
    if (!videoCancelled) {
      await new Promise(r => setTimeout(r, 500))
    }
  } finally {
    mediaRecorder.stop()
    // Restore all footprints after recording
    progressText.textContent = 'Restoring scene…'
    try { await fullRePlaceShapes() } catch {}
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
;(window as any).onScrubChange = onScrubChange
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