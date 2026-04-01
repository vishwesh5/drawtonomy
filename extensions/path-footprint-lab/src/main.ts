// Path Footprint Lab - Development extension for variable footprint positioning
// Modified: Live slider updates, per-path state persistence, stateful UI, simulation mode

// --- Inline ExtensionClient (avoid npm dependency on unpublished SDK) ---

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
    const response = await this.waitForResponse(requestId) as { shapes: BaseShape[] }
    return response.shapes
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
      const pending = this.pendingRequests.get(data.payload.requestId)
      if (pending) { clearTimeout(pending.timeout); this.pendingRequests.delete(data.payload.requestId); pending.reject(new Error(data.payload.message)) }
      return
    }
    const requestId = data.payload?.requestId
    if (requestId) {
      const pending = this.pendingRequests.get(requestId)
      if (pending) { clearTimeout(pending.timeout); this.pendingRequests.delete(requestId); pending.resolve(data.payload) }
    }
  }

  private nextRequestId(): string { return `${this.manifestId}_${++this.requestIdCounter}_${Date.now().toString(36)}` }

  private waitForResponse(requestId: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { this.pendingRequests.delete(requestId); reject(new Error(`Request ${requestId} timed out`)) }, this.requestTimeout)
      this.pendingRequests.set(requestId, { resolve, reject, timeout })
    })
  }
}

// --- Inline geometry functions (avoid npm dependency on unpublished SDK) ---

interface Point2D { x: number; y: number }

interface PathEvalResult {
  position: Point2D
  tangentAngleDeg: number
  tangentVec: Point2D
}

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
// SIMULATION ENGINE
// =============================================================================
// 3-stage pipeline designed for future non-uniform speed profiles:
//   Stage 1: computeTimeSamples()     — generate sample timestamps
//   Stage 2: computeDistancesAtTimes() — integrate speed over time → cumulative distances
//   Stage 3: computePathTValues()      — normalize distances → t ∈ [0, 1]
//
// For uniform speed, Stage 2 simplifies to d = v*t (and t-values become t_i/T).
// For future variable speed segments, Stage 2 becomes piecewise integration:
//   distance(t) = Σ speed_k × duration_k  (for each segment up to time t)
// The pipeline structure doesn't change — only the internals of Stage 2.
// =============================================================================

type SpeedUnit = 'km/h' | 'm/s' | 'mph'
type TimeUnit = 's' | 'min' | 'hr'
type SamplingRateUnit = 'total' | '/s' | '/min' | '/hr'

interface SimulationConfig {
  speed: number
  speedUnit: SpeedUnit
  totalTime: number
  timeUnit: TimeUnit
  samplingRate: number
  samplingRateUnit: SamplingRateUnit
  // Future: variable speed segments
  // segments?: Array<{ startTimeSec: number; endTimeSec: number; speedMs: number }>
}

// --- Unit conversions (all to SI: m/s and seconds) ---

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

function resolveParticipantCount(rate: number, rateUnit: SamplingRateUnit, totalTimeSec: number): number {
  // 'total' means the rate value IS the total count directly
  switch (rateUnit) {
    case 'total': return Math.max(1, Math.round(rate))
    case '/s':    return Math.max(1, Math.round(rate * totalTimeSec))
    case '/min':  return Math.max(1, Math.round(rate * (totalTimeSec / 60)))
    case '/hr':   return Math.max(1, Math.round(rate * (totalTimeSec / 3600)))
  }
}

// --- Stage 1: Generate time samples ---
function computeTimeSamples(totalTimeSec: number, numSamples: number): number[] {
  // Evenly-spaced samples: t_1, t_2, ..., t_N  (excludes t=0, includes t=T)
  // This means participant 1 is at the first interval mark, last is at end of path.
  if (numSamples <= 0) return []
  const interval = totalTimeSec / numSamples
  const samples: number[] = []
  for (let i = 1; i <= numSamples; i++) {
    samples.push(i * interval)
  }
  return samples
}

// --- Stage 2: Compute cumulative distances at each time sample ---
// Currently: uniform speed → distance = speed * time
// Future: this function will accept a SpeedProfile and do piecewise integration
function computeDistancesAtTimes(
  timeSamples: number[],
  speedMs: number,
  _totalTimeSec: number,
  // Future signature extension:
  // segments?: Array<{ startTimeSec: number; endTimeSec: number; speedMs: number }>
): number[] {
  // Uniform speed: d(t) = v * t
  return timeSamples.map(t => speedMs * t)
}

// --- Stage 3: Normalize distances to path t-values [0, 1] ---
function computePathTValues(distances: number[], totalDistance: number): number[] {
  if (totalDistance <= 0) return distances.map(() => 0)
  return distances.map(d => Math.min(1, d / totalDistance))
}

// --- Orchestrator: full pipeline ---
interface SimulationResult {
  tValues: number[]
  numParticipants: number
  intervalSec: number
  totalDistanceM: number
  speedMs: number
  totalTimeSec: number
}

function runSimulationPipeline(config: SimulationConfig): SimulationResult | { error: string } {
  const speedMs = speedToMs(config.speed, config.speedUnit)
  const totalTimeSec = timeToSeconds(config.totalTime, config.timeUnit)
  const numParticipants = resolveParticipantCount(config.samplingRate, config.samplingRateUnit, totalTimeSec)

  if (speedMs <= 0) return { error: 'Speed must be positive' }
  if (totalTimeSec <= 0) return { error: 'Duration must be positive' }
  if (numParticipants <= 0) return { error: 'At least 1 participant needed' }
  if (numParticipants > 200) return { error: 'Max 200 participants' }

  const totalDistanceM = speedMs * totalTimeSec
  const intervalSec = totalTimeSec / numParticipants

  // Stage 1
  const timeSamples = computeTimeSamples(totalTimeSec, numParticipants)
  // Stage 2
  const distances = computeDistancesAtTimes(timeSamples, speedMs, totalTimeSec)
  // Stage 3
  const tValues = computePathTValues(distances, totalDistanceM)

  return { tValues, numParticipants, intervalSec, totalDistanceM, speedMs, totalTimeSec }
}

// --- Display formatting helpers ---

function formatDuration(seconds: number): string {
  if (seconds < 1) return `${(seconds * 1000).toFixed(0)} ms`
  if (seconds < 60) return `${seconds.toFixed(1)} sec`
  if (seconds < 3600) return `${(seconds / 60).toFixed(1)} min`
  return `${(seconds / 3600).toFixed(2)} hr`
}

function formatDistance(meters: number): string {
  if (meters < 1) return `${(meters * 100).toFixed(1)} cm`
  if (meters < 1000) return `${meters.toFixed(1)} m`
  return `${(meters / 1000).toFixed(2)} km`
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

// Current positioning mode
let activeMode: 'manual' | 'simulation' = 'manual'

// Current simulation config (UI state)
let simConfig: SimulationConfig = {
  speed: 30,
  speedUnit: 'km/h',
  totalTime: 60,
  timeUnit: 'min',
  samplingRate: 10,
  samplingRateUnit: 'total',
}

// Per-path state persistence
interface PathState {
  footprints: Array<{ t: number }>
  templateId: string
  placedShapeIds: string[]
  isPlaced: boolean
  needsUpdate: boolean
  activeMode: 'manual' | 'simulation'
  simConfig: SimulationConfig
}
const pathStateMap = new Map<string, PathState>()

// UI state tracking
let isPlaced = false
let needsUpdate = false
let placedShapeIds: string[] = []

// Template definitions (matching host app)
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
  const noPathState = document.getElementById('no-path-state')!
  const pathPanel = document.getElementById('path-panel')!
  noPathState.style.display = hasPath ? 'none' : 'flex'
  pathPanel.style.display = hasPath ? 'block' : 'none'
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
}


// =============================================================================
// MODE SWITCHING
// =============================================================================

function switchMode(mode: 'manual' | 'simulation') {
  activeMode = mode

  // Update tab UI
  document.querySelectorAll('.mode-tab').forEach(tab => {
    tab.classList.toggle('active', (tab as HTMLElement).dataset.mode === mode)
  })

  // Update panel visibility
  document.getElementById('mode-manual')!.classList.toggle('active', mode === 'manual')
  document.getElementById('mode-simulation')!.classList.toggle('active', mode === 'simulation')

  // Update preview when switching to simulation
  if (mode === 'simulation') {
    updateSimPreview()
  }

  saveCurrentPathState()
}


// =============================================================================
// SIMULATION UI
// =============================================================================

function readSimConfigFromUI(): SimulationConfig {
  return {
    speed: parseFloat((document.getElementById('sim-speed') as HTMLInputElement).value) || 0,
    speedUnit: (document.getElementById('sim-speed-unit') as HTMLSelectElement).value as SpeedUnit,
    totalTime: parseFloat((document.getElementById('sim-time') as HTMLInputElement).value) || 0,
    timeUnit: (document.getElementById('sim-time-unit') as HTMLSelectElement).value as TimeUnit,
    samplingRate: parseFloat((document.getElementById('sim-rate') as HTMLInputElement).value) || 0,
    samplingRateUnit: (document.getElementById('sim-rate-unit') as HTMLSelectElement).value as SamplingRateUnit,
  }
}

function writeSimConfigToUI(config: SimulationConfig) {
  (document.getElementById('sim-speed') as HTMLInputElement).value = String(config.speed)
  ;(document.getElementById('sim-speed-unit') as HTMLSelectElement).value = config.speedUnit
  ;(document.getElementById('sim-time') as HTMLInputElement).value = String(config.totalTime)
  ;(document.getElementById('sim-time-unit') as HTMLSelectElement).value = config.timeUnit
  ;(document.getElementById('sim-rate') as HTMLInputElement).value = String(config.samplingRate)
  ;(document.getElementById('sim-rate-unit') as HTMLSelectElement).value = config.samplingRateUnit
}

function onSimInputChange() {
  simConfig = readSimConfigFromUI()
  updateSimPreview()
  saveCurrentPathState()
}

function updateSimPreview() {
  const previewEl = document.getElementById('sim-preview')!
  const countEl = document.getElementById('sim-preview-count')!
  const intervalEl = document.getElementById('sim-preview-interval')!
  const distanceEl = document.getElementById('sim-preview-distance')!

  const result = runSimulationPipeline(simConfig)

  if ('error' in result) {
    previewEl.classList.add('error')
    countEl.textContent = '—'
    intervalEl.textContent = result.error
    distanceEl.textContent = '—'
    return
  }

  previewEl.classList.remove('error')
  countEl.textContent = `${result.numParticipants}`
  intervalEl.textContent = formatDuration(result.intervalSec)
  distanceEl.textContent = formatDistance(result.totalDistanceM)
}

function generateFromSimulation() {
  simConfig = readSimConfigFromUI()
  const result = runSimulationPipeline(simConfig)

  if ('error' in result) {
    setStatus(`Simulation error: ${result.error}`)
    return
  }

  // Cancel any pending live update from previous state
  cancelLiveUpdate()

  // If shapes were previously placed, this is an update
  const wasPlaced = isPlaced

  // Replace footprints with simulation-generated t-values
  footprints = result.tValues.map(t => ({ t: parseFloat(t.toFixed(4)) }))

  // Switch to manual view to show generated sliders (user can fine-tune)
  switchMode('manual')
  renderFootprintList()

  if (wasPlaced) {
    needsUpdate = true
  }
  updateUIState()
  saveCurrentPathState()

  setStatus(`Generated ${result.numParticipants} positions (${formatDuration(result.intervalSec)} interval, ${formatDistance(result.totalDistanceM)} total)`)
  client.notify(`${result.numParticipants} positions generated from simulation`, 'success')
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
    simConfig: { ...simConfig },
  })
}

function restorePathState(pathId: string) {
  const saved = pathStateMap.get(pathId)
  if (saved) {
    footprints = saved.footprints.map(f => ({ t: f.t }))
    const tmpl = TEMPLATES.find(t => t.id === saved.templateId)
    if (tmpl) { selectedTemplate = tmpl }
    placedShapeIds = [...saved.placedShapeIds]
    isPlaced = saved.isPlaced
    needsUpdate = saved.needsUpdate
    activeMode = saved.activeMode
    simConfig = { ...saved.simConfig }
  } else {
    // New path — start fresh
    footprints = []
    placedShapeIds = []
    isPlaced = false
    needsUpdate = false
    activeMode = 'manual'
    simConfig = {
      speed: 30, speedUnit: 'km/h',
      totalTime: 60, timeUnit: 'min',
      samplingRate: 10, samplingRateUnit: 'total',
    }
  }
}


// =============================================================================
// UI RENDERING
// =============================================================================

function hostUrl(path: string): string {
  try {
    const parentOrigin = document.referrer ? new URL(document.referrer).origin : window.location.origin
    return parentOrigin + path
  } catch {
    return path
  }
}

function renderTemplateGrid() {
  const container = document.getElementById('template-grid')!
  container.innerHTML = ''
  TEMPLATES.forEach(tmpl => {
    const btn = document.createElement('button')
    btn.className = `template-btn${tmpl.id === selectedTemplate.id ? ' active' : ''}`
    btn.title = tmpl.name

    const maxSize = 24
    const aspect = tmpl.vbW / tmpl.vbH
    let iconW = maxSize, iconH = maxSize
    if (aspect > 1) { iconH = Math.round(maxSize / aspect) }
    else { iconW = Math.round(maxSize * aspect) }

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
      selectedTemplate = tmpl
      renderTemplateGrid()
      saveCurrentPathState()
    })
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

      // Live update: reposition shapes on slider drag if placed and in sync
      if (isPlaced && !needsUpdate) {
        debouncedLiveUpdate()
      }

      // Persist state
      saveCurrentPathState()
    })

    const removeBtn = row.querySelector('button')!
    removeBtn.addEventListener('click', (e) => {
      const idx = parseInt((e.target as HTMLButtonElement).dataset.index!)
      footprints.splice(idx, 1)
      renderFootprintList()

      // Cancel any pending/in-flight live update
      cancelLiveUpdate()

      // If shapes are placed, count mismatch means we need update
      if (isPlaced) {
        needsUpdate = true
      }
      if (footprints.length === 0) {
        clearPlacedShapes()
        isPlaced = false
        needsUpdate = false
      }
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
  if (liveDebounceTimer) {
    clearTimeout(liveDebounceTimer)
    liveDebounceTimer = null
  }
  liveUpdateAborted = true
  liveUpdateDirty = false
}

function debouncedLiveUpdate() {
  if (liveDebounceTimer) clearTimeout(liveDebounceTimer)
  liveDebounceTimer = setTimeout(() => {
    liveDebounceTimer = null
    runLiveUpdate()
  }, 120)
}

async function runLiveUpdate() {
  if (!selectedPathId || selectedPathPoints.length < 2) return
  if (!isPlaced || needsUpdate) return
  if (footprints.length === 0) return

  if (liveUpdateBusy) {
    liveUpdateDirty = true
    return
  }

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
      if (dp && dp.length >= 2) {
        selectedPathPoints = dp
      }
    }

    if (liveUpdateAborted) return

    if (placedShapeIds.length > 0) {
      client.deleteShapes(placedShapeIds)
      await new Promise(resolve => setTimeout(resolve, 150))
    }

    if (liveUpdateAborted) return

    const sorted = [...footprints].sort((a, b) => a.t - b.t)
    const shapeType = selectedTemplate.type === 'pedestrian' ? 'pedestrian' : 'vehicle'
    const attrType = selectedTemplate.type === 'pedestrian' ? 'pedestrian' : 'vehicle'
    const attrSubtype = selectedTemplate.type === 'pedestrian' ? 'person' : 'car'

    const shapes: BaseShape[] = sorted.map(fp => {
      const evalResult = evaluatePathAt(selectedPathPoints, fp.t)
      return {
        id: nextId('fp'),
        type: shapeType,
        x: evalResult.position.x,
        y: evalResult.position.y,
        rotation: evalResult.tangentAngleDeg,
        zIndex: shapeType === 'pedestrian' ? 3000 : 4000,
        props: {
          w: selectedTemplate.w,
          h: selectedTemplate.h,
          color: 'black',
          size: 'm',
          opacity: 1,
          attributes: { type: attrType, subtype: attrSubtype },
          osmId: '',
          templateId: selectedTemplate.id,
          parentPathId: pathId,
        },
      }
    })

    client.addShapes(shapes)

    await new Promise(resolve => setTimeout(resolve, 350))
    if (liveUpdateAborted) return

    const queryTypes = ['vehicle', 'pedestrian']
    let allOfType: BaseShape[] = []
    for (const qt of queryTypes) {
      const found = await client.requestShapes({ types: [qt] })
      allOfType = allOfType.concat(found)
    }

    if (liveUpdateAborted) return

    const newFpIds = allOfType
      .filter(s => s.props.parentPathId === pathId)
      .map(s => s.id)

    placedShapeIds = newFpIds

    if (newFpIds.length > 0) {
      const arcLengths = computeArcLengths(selectedPathPoints)
      const totalLen = arcLengths[arcLengths.length - 1]
      const interval = sorted.length > 1
        ? Math.round(totalLen / (sorted.length - 1))
        : Math.round(totalLen)

      client.updateShapes([{
        id: pathId,
        props: {
          footprint: {
            interval,
            offset: 0,
            templateId: selectedTemplate.id,
            anchorOffset: 0,
            mode: 'variable',
            tValues: sorted.map(f => f.t),
          },
          footprintIds: newFpIds,
        },
      }])
    }

    saveCurrentPathState()
  } catch (e) {
    console.warn('[FootprintLab] Live update error:', e)
  } finally {
    liveUpdateBusy = false
    if (!liveUpdateAborted && liveUpdateDirty) {
      liveUpdateDirty = false
      runLiveUpdate()
    }
  }
}


// =============================================================================
// FULL RE-PLACE SHAPES (used by Place/Update buttons)
// =============================================================================

async function fullRePlaceShapes() {
  if (!selectedPathId || selectedPathPoints.length < 2) return
  if (footprints.length === 0) return

  try {
    const freshShapes = await client.requestShapes({ ids: [selectedPathId] })
    const freshPath = freshShapes.find(s => s.id === selectedPathId)
    if (freshPath) {
      const dp = freshPath.props._displayPoints as Point2D[] | undefined
      if (dp && dp.length >= 2) {
        selectedPathPoints = dp
      }
    }

    await clearPlacedShapes()

    const sorted = [...footprints].sort((a, b) => a.t - b.t)
    const arcLengths = computeArcLengths(selectedPathPoints)
    const totalLen = arcLengths[arcLengths.length - 1]
    const interval = sorted.length > 1
      ? Math.round(totalLen / (sorted.length - 1))
      : Math.round(totalLen)

    const shapeType = selectedTemplate.type === 'pedestrian' ? 'pedestrian' : 'vehicle'
    const attrType = selectedTemplate.type === 'pedestrian' ? 'pedestrian' : 'vehicle'
    const attrSubtype = selectedTemplate.type === 'pedestrian' ? 'person' : 'car'

    const shapes: BaseShape[] = []
    for (const fp of sorted) {
      const evalResult = evaluatePathAt(selectedPathPoints, fp.t)
      const id = nextId('fp')
      shapes.push({
        id,
        type: shapeType,
        x: evalResult.position.x,
        y: evalResult.position.y,
        rotation: evalResult.tangentAngleDeg,
        zIndex: shapeType === 'pedestrian' ? 3000 : 4000,
        props: {
          w: selectedTemplate.w,
          h: selectedTemplate.h,
          color: 'black',
          size: 'm',
          opacity: 1,
          attributes: { type: attrType, subtype: attrSubtype },
          osmId: '',
          templateId: selectedTemplate.id,
          parentPathId: selectedPathId,
        },
      })
    }

    client.addShapes(shapes)

    await new Promise(resolve => setTimeout(resolve, 500))

    const queryTypes = ['vehicle', 'pedestrian']
    let allOfType: BaseShape[] = []
    for (const qt of queryTypes) {
      const found = await client.requestShapes({ types: [qt] })
      allOfType = allOfType.concat(found)
    }
    const newFpIds = allOfType
      .filter(s => s.props.parentPathId === selectedPathId)
      .map(s => s.id)

    placedShapeIds = newFpIds

    if (newFpIds.length > 0) {
      client.updateShapes([{
        id: selectedPathId,
        props: {
          footprint: {
            interval,
            offset: 0,
            templateId: selectedTemplate.id,
            anchorOffset: 0,
            mode: 'variable',
            tValues: sorted.map(f => f.t),
          },
          footprintIds: newFpIds,
        },
      }])
    }

    isPlaced = true
    needsUpdate = false
    updateUIState()
    saveCurrentPathState()

    return newFpIds.length
  } catch (e) {
    setStatus(`Error: ${e}`)
    return 0
  }
}

async function clearPlacedShapes() {
  if (!selectedPathId) return

  try {
    const existingVehicles = await client.requestShapes({ types: ['vehicle'] })
    const existingPeds = await client.requestShapes({ types: ['pedestrian'] })
    const allExisting = [...existingVehicles, ...existingPeds]
    const existingFpIds = allExisting
      .filter(s => s.props.parentPathId === selectedPathId)
      .map(s => s.id)

    if (existingFpIds.length > 0) {
      client.deleteShapes(existingFpIds)
      await new Promise(resolve => setTimeout(resolve, 200))
    }

    client.updateShapes([{
      id: selectedPathId,
      props: { footprintIds: [] },
    }])
    await new Promise(resolve => setTimeout(resolve, 100))

    placedShapeIds = []
  } catch (e) {
    console.warn('[FootprintLab] Error clearing shapes:', e)
  }
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
      selectedPathId = null
      selectedPathPoints = []
      showPanel(false)
      return
    }

    const shapes = await client.requestShapes({ ids: selection.ids })
    const path = shapes.find(s => s.type === 'linestring' && s.props.isPath)

    if (!path) {
      document.getElementById('path-info')!.textContent = 'Selected shape is not a path'
      selectedPathId = null
      selectedPathPoints = []
      showPanel(false)
      return
    }

    const previousPathId = selectedPathId
    if (previousPathId && previousPathId !== path.id) {
      saveCurrentPathState()
    }

    selectedPathId = path.id

    const displayPoints = path.props._displayPoints as Point2D[] | undefined
    console.log('[FootprintLab] _displayPoints:', displayPoints ? displayPoints.length + ' points' : 'undefined', 'props keys:', Object.keys(path.props))

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

    // Restore state for this path
    restorePathState(path.id)

    const smoothed = displayPoints ? ' (smoothed)' : ' (raw)'
    document.getElementById('path-info')!.textContent = `Path: ${path.id.slice(0, 16)}... (${selectedPathPoints.length} pts${smoothed})`

    showPanel(true)
    renderTemplateGrid()
    renderFootprintList()

    // Restore mode tab and simulation UI
    switchMode(activeMode)
    writeSimConfigToUI(simConfig)
    updateSimPreview()

    updateUIState()
    setStatus('Path selected')
  } catch (e) {
    setStatus(`Error: ${e}`)
  }
}

function addFootprint() {
  const maxT = footprints.length > 0 ? Math.max(...footprints.map(f => f.t)) : 0
  const newT = Math.min(1, maxT + 0.1)
  footprints.push({ t: parseFloat(newT.toFixed(2)) })
  renderFootprintList()

  cancelLiveUpdate()

  if (isPlaced) {
    needsUpdate = true
  }
  updateUIState()
  saveCurrentPathState()
}

function removeLastFootprint() {
  if (footprints.length === 0) return
  footprints.pop()
  renderFootprintList()

  cancelLiveUpdate()

  if (isPlaced) {
    if (footprints.length === 0) {
      clearPlacedShapes()
      isPlaced = false
      needsUpdate = false
    } else {
      needsUpdate = true
    }
  }
  updateUIState()
  saveCurrentPathState()
}

async function placeParticipants() {
  if (!selectedPathId || selectedPathPoints.length < 2) {
    setStatus('Select a path first')
    return
  }
  if (footprints.length === 0) {
    setStatus('Add at least one participant')
    return
  }

  setStatus('Placing participants...')
  const count = await fullRePlaceShapes()
  if (count && count > 0) {
    client.notify(`${count} participants placed`, 'success')
    setStatus(`Placed ${count} participants — drag sliders to reposition`)
  }
}

async function updateParticipantPositions() {
  if (!selectedPathId || selectedPathPoints.length < 2) {
    setStatus('Select a path first')
    return
  }
  if (footprints.length === 0) {
    setStatus('Add at least one participant')
    return
  }

  setStatus('Updating positions...')
  const count = await fullRePlaceShapes()
  if (count && count > 0) {
    client.notify(`${count} positions updated`, 'success')
    setStatus(`Updated ${count} participants — drag sliders to reposition`)
  }
}

async function clearFootprints() {
  if (!selectedPathId) {
    setStatus('Select a path first')
    return
  }

  try {
    await clearPlacedShapes()
    footprints = []
    placedShapeIds = []
    isPlaced = false
    needsUpdate = false

    renderFootprintList()
    updateUIState()
    saveCurrentPathState()

    client.notify('All participants cleared', 'info')
    setStatus('Cleared')
  } catch (e) {
    setStatus(`Error: ${e}`)
  }
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
        if (event.data?.type === 'ext:export-response' && event.data?.payload?.requestId === requestId) {
          window.removeEventListener('message', handler)
          resolve(event.data.payload)
        }
        if (event.data?.type === 'ext:error' && event.data?.payload?.requestId === requestId) {
          window.removeEventListener('message', handler)
          reject(new Error(event.data.payload.message))
        }
      }
      window.addEventListener('message', handler)
      window.parent.postMessage({ type: 'ext:export-request', payload: { requestId, format: selectedExportFormat } }, '*')
      setTimeout(() => reject(new Error('timeout')), 30000)
    })
    exportStatus.textContent = `Exported ${result.filename}`
  } catch (e) {
    exportStatus.textContent = `Error: ${e}`
  }
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
;(window as any).onSimInputChange = onSimInputChange
;(window as any).generateFromSimulation = generateFromSimulation

// Expose state for debugging
Object.defineProperty(window, 'selectedPathPoints', { get: () => selectedPathPoints })
Object.defineProperty(window, 'selectedPathId', { get: () => selectedPathId })
Object.defineProperty(window, 'footprints', { get: () => footprints, set: (v) => { footprints.length = 0; footprints.push(...v) } })
Object.defineProperty(window, 'pathStateMap', { get: () => pathStateMap })
Object.defineProperty(window, 'placedShapeIds', { get: () => placedShapeIds })
Object.defineProperty(window, 'simConfig', { get: () => simConfig })


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
        if (deselectionGraceTimer) {
          clearTimeout(deselectionGraceTimer)
          deselectionGraceTimer = null
        }
        const shapes = await client.requestShapes({ ids: [currentId] })
        const path = shapes.find(s => s.type === 'linestring' && s.props.isPath)
        if (path) {
          if (path.id !== selectedPathId) {
            await refreshSelection()
          }
        } else if (selectedPathId) {
          // Selected something that's not a path — keep current panel
        }
      } else {
        if (!deselectionGraceTimer && selectedPathId) {
          deselectionGraceTimer = setTimeout(() => {
            deselectionGraceTimer = null
            if (lastSelectionId === null) {
              saveCurrentPathState()
              selectedPathId = null
              selectedPathPoints = []
              showPanel(false)
            }
          }, 600)
        }
      }
    }
  } catch {
    // Ignore polling errors
  }
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
  updateSimPreview()

  setInterval(pollSelection, 500)
}

main()