// Path Footprint Lab - Development extension for variable footprint positioning

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

// --- State ---

let idCounter = 0
function nextId(prefix = 'fplab'): string { return `${prefix}_${++idCounter}_${Date.now().toString(36)}` }

let client: ExtensionClient
let selectedPathId: string | null = null
let selectedPathPoints: Point2D[] = []
let footprints: Array<{ t: number }> = [{ t: 0.2 }, { t: 0.5 }, { t: 0.8 }]

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

// --- UI ---

// Resolve asset URL relative to host (parent window origin)
function hostUrl(path: string): string {
  // In dev: Extension is on localhost:3001, host is on localhost:3000
  // Use referrer or hardcode relative to parent
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

    // Calculate icon size based on viewBox aspect ratio (max 24x24)
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
    })
    const removeBtn = row.querySelector('button')!
    removeBtn.addEventListener('click', (e) => {
      const idx = parseInt((e.target as HTMLButtonElement).dataset.index!)
      footprints.splice(idx, 1)
      renderFootprintList()
    })
    container.appendChild(row)
  })
}

function setStatus(msg: string) {
  document.getElementById('status')!.textContent = msg
}

// --- Actions ---

async function refreshSelection() {
  try {
    const selection = await client.requestSelection()
    if (selection.ids.length === 0) {
      document.getElementById('path-info')!.textContent = 'No shape selected'
      selectedPathId = null
      selectedPathPoints = []
      return
    }

    const shapes = await client.requestShapes({ ids: selection.ids })
    const path = shapes.find(s => s.type === 'linestring' && s.props.isPath)

    if (!path) {
      document.getElementById('path-info')!.textContent = 'Selected shape is not a path'
      selectedPathId = null
      selectedPathPoints = []
      return
    }

    selectedPathId = path.id
    // Use smoothed display points if available, otherwise fall back to raw points
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

    const smoothed = displayPoints ? ' (smoothed)' : ' (raw)'
    document.getElementById('path-info')!.textContent = `Path: ${path.id.slice(0, 16)}... (${selectedPathPoints.length} pts${smoothed})`
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
}

async function applyFootprints() {
  if (!selectedPathId || selectedPathPoints.length < 2) {
    setStatus('Select a path first')
    return
  }

  if (footprints.length === 0) {
    setStatus('Add at least one footprint')
    return
  }

  try {
    // Refresh displayPoints to get latest path coordinates
    const freshShapes = await client.requestShapes({ ids: [selectedPathId] })
    const freshPath = freshShapes.find(s => s.id === selectedPathId)
    if (freshPath) {
      const dp = freshPath.props._displayPoints as Point2D[] | undefined
      if (dp && dp.length >= 2) {
        selectedPathPoints = dp
      }
    }

    // Remove existing footprints on this path
    const existingShapes = await client.requestShapes({ types: ['vehicle'] })
    const existingFpIds = existingShapes
      .filter(s => s.props.parentPathId === selectedPathId)
      .map(s => s.id)
    if (existingFpIds.length > 0) {
      client.deleteShapes(existingFpIds)
      // Wait for deletion to complete
      await new Promise(resolve => setTimeout(resolve, 200))
    }

    // Also clear footprint config on path first
    client.updateShapes([{
      id: selectedPathId,
      props: { footprintIds: [] },
    }])
    await new Promise(resolve => setTimeout(resolve, 100))

    // Create new footprints
    const sorted = [...footprints].sort((a, b) => a.t - b.t)

    // Compute interval for footprint config
    const arcLengths = computeArcLengths(selectedPathPoints)
    const totalLen = arcLengths[arcLengths.length - 1]
    const interval = sorted.length > 1
      ? Math.round(totalLen / (sorted.length - 1))
      : Math.round(totalLen)

    // Build vehicle shapes
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

    // Add footprints via addShapes (IDs will be remapped by validator)
    client.addShapes(shapes)

    // Wait for shapes to be created, then find the remapped IDs
    await new Promise(resolve => setTimeout(resolve, 500))

    // Query vehicles with parentPathId matching our path to get remapped IDs
    const allVehicles = await client.requestShapes({ types: ['vehicle'] })
    const newFpIds = allVehicles
      .filter(s => s.props.parentPathId === selectedPathId)
      .map(s => s.id)

    // Update path with footprint config using remapped IDs
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

    client.notify(`${sorted.length} footprints applied`, 'success')
    setStatus(`Applied ${sorted.length} footprints at t=${sorted.map(f => f.t.toFixed(2)).join(', ')}`)
  } catch (e) {
    setStatus(`Error: ${e}`)
  }
}

async function clearFootprints() {
  if (!selectedPathId) {
    setStatus('Select a path first')
    return
  }

  try {
    const existingShapes = await client.requestShapes({ types: ['vehicle'] })
    const existingFpIds = existingShapes
      .filter(s => s.props.parentPathId === selectedPathId)
      .map(s => s.id)
    if (existingFpIds.length > 0) {
      client.deleteShapes(existingFpIds)
    }
    client.updateShapes([{
      id: selectedPathId,
      props: { footprintIds: [] },
    }])
    client.notify('Footprints cleared', 'info')
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

// --- Expose to window for inline onclick handlers and debugging ---
;(window as any).refreshSelection = refreshSelection
;(window as any).addFootprint = addFootprint
;(window as any).applyFootprints = applyFootprints
;(window as any).clearFootprints = clearFootprints
;(window as any).exportScene = exportScene
;(window as any).renderFootprintList = renderFootprintList
// Expose state for debugging
Object.defineProperty(window, 'selectedPathPoints', { get: () => selectedPathPoints })
Object.defineProperty(window, 'selectedPathId', { get: () => selectedPathId })
Object.defineProperty(window, 'footprints', { get: () => footprints, set: (v) => { footprints.length = 0; footprints.push(...v) } })

// --- Auto-detect selection ---

let lastSelectionId: string | null = null

async function pollSelection() {
  try {
    const selection = await client.requestSelection()
    const currentId = selection.ids.length > 0 ? selection.ids[0] : null

    if (currentId !== lastSelectionId) {
      lastSelectionId = currentId
      if (currentId) {
        const shapes = await client.requestShapes({ ids: [currentId] })
        const path = shapes.find(s => s.type === 'linestring' && s.props.isPath)
        if (path) {
          // Auto-refresh when a path is selected
          await refreshSelection()
        } else if (selectedPathId) {
          // Selected something that's not a path
          document.getElementById('path-info')!.textContent = 'Selected shape is not a path'
        }
      }
    }
  } catch {
    // Ignore polling errors
  }
}

// --- Init ---

async function main() {
  client = new ExtensionClient('path-footprint-lab')
  const init = await client.waitForInit()
  console.log('Path Footprint Lab connected:', init.grantedCapabilities)
  renderTemplateGrid()
  renderFootprintList()
  initFormatButtons()
  setStatus('Ready. Draw a path and select it.')

  // Poll for selection changes every 500ms
  setInterval(pollSelection, 500)
}

main()
