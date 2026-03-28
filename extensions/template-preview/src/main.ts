// Template Preview - Extension for previewing and testing custom SVG templates

// --- Inline ExtensionClient ---

interface InitPayload {
  hostVersion: string
  grantedCapabilities: string[]
  viewport: { width: number; height: number }
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

  registerTemplates(templates: TemplateInput[]): Promise<{ registered: string[]; errors: Array<{ id: string; message: string }> }> {
    const requestId = this.nextRequestId()
    this.send({ type: 'ext:templates-register', payload: { requestId, templates } })
    return this.waitForResponse(requestId) as Promise<{ registered: string[]; errors: Array<{ id: string; message: string }> }>
  }

  unregisterTemplates(templateIds: string[]): Promise<{ unregistered: string[] }> {
    const requestId = this.nextRequestId()
    this.send({ type: 'ext:templates-unregister', payload: { requestId, templateIds } })
    return this.waitForResponse(requestId) as Promise<{ unregistered: string[] }>
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

// --- Types ---

interface TemplateInput {
  id: string
  name: string
  category: string
  svgContent: string
  w: number
  h: number
  viewBox: { width: number; height: number }
  replaceColor?: string | null
  defaultColor?: string
}

// --- State ---

let svgContent: string | null = null
let svgFilename: string | null = null
let svgViewBox: { width: number; height: number } | null = null
let isRegistered = false

// --- DOM refs ---

const dropZone = document.getElementById('drop-zone')!
const fileInput = document.getElementById('file-input') as HTMLInputElement
const svgPreview = document.getElementById('svg-preview')!
const previewImg = document.getElementById('preview-img') as HTMLImageElement
const widthSlider = document.getElementById('width') as HTMLInputElement
const heightSlider = document.getElementById('height') as HTMLInputElement
const widthValue = document.getElementById('width-value')!
const heightValue = document.getElementById('height-value')!
const replaceColorRow = document.getElementById('replace-color-row')!
const replaceColorInput = document.getElementById('replace-color') as HTMLInputElement
const btnRegister = document.getElementById('btn-register') as HTMLButtonElement
const btnUnregister = document.getElementById('btn-unregister') as HTMLButtonElement
const btnCopy = document.getElementById('btn-copy') as HTMLButtonElement
const manifestOutput = document.getElementById('manifest-output')!
const statusEl = document.getElementById('status')!

// --- Init ---

const client = new ExtensionClient('template-preview')

client.waitForInit().then(init => {
  setStatus(`Connected (v${init.hostVersion})`)
})

// --- File handling ---

dropZone.addEventListener('click', () => fileInput.click())
dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('dragover') })
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'))
dropZone.addEventListener('drop', (e) => {
  e.preventDefault()
  dropZone.classList.remove('dragover')
  const file = e.dataTransfer?.files[0]
  if (file && file.name.endsWith('.svg')) loadFile(file)
})
fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0]
  if (file) loadFile(file)
})

function cropSvgToContent(rawSvg: string): { svg: string; viewBox: { width: number; height: number } } {
  // Render SVG off-screen to get actual content bounding box
  const container = document.createElement('div')
  container.style.position = 'absolute'
  container.style.left = '-9999px'
  container.style.top = '-9999px'
  container.innerHTML = rawSvg
  document.body.appendChild(container)

  const svgEl = container.querySelector('svg')
  if (!svgEl) {
    document.body.removeChild(container)
    return { svg: rawSvg, viewBox: { width: 100, height: 100 } }
  }

  try {
    const bbox = svgEl.getBBox()
    if (bbox.width > 0 && bbox.height > 0) {
      // Add small padding around content
      const pad = Math.max(bbox.width, bbox.height) * 0.02
      const x = bbox.x - pad
      const y = bbox.y - pad
      const w = bbox.width + pad * 2
      const h = bbox.height + pad * 2

      // Crop viewBox to content bounds + set preserveAspectRatio="none" for full w/h stretch
      let cropped = rawSvg.replace(
        /viewBox\s*=\s*"[^"]*"/,
        `viewBox="${x} ${y} ${w} ${h}"`
      )
      if (/preserveAspectRatio\s*=/.test(cropped)) {
        cropped = cropped.replace(/preserveAspectRatio\s*=\s*"[^"]*"/, 'preserveAspectRatio="none"')
      } else {
        cropped = cropped.replace(/<svg/, '<svg preserveAspectRatio="none"')
      }
      document.body.removeChild(container)
      return { svg: cropped, viewBox: { width: w, height: h } }
    }
  } catch {
    // getBBox failure
  }

  document.body.removeChild(container)
  // Fallback: use original viewBox
  const match = rawSvg.match(/viewBox\s*=\s*"([^"]+)"/)
  if (match) {
    const parts = match[1].split(/[\s,]+/).map(Number)
    if (parts.length === 4) {
      return { svg: rawSvg, viewBox: { width: parts[2], height: parts[3] } }
    }
  }
  return { svg: rawSvg, viewBox: { width: 100, height: 100 } }
}

function loadFile(file: File) {
  const reader = new FileReader()
  reader.onload = () => {
    const rawSvg = reader.result as string
    svgFilename = file.name.replace('.svg', '')

    // Crop SVG to its actual content bounds
    const cropped = cropSvgToContent(rawSvg)
    svgContent = cropped.svg
    svgViewBox = cropped.viewBox

    // Calculate default w/h from viewBox aspect ratio (base height = 56)
    const baseH = 56
    aspectRatio = svgViewBox.width / svgViewBox.height
    const defaultW = Math.round(baseH * aspectRatio)
    const defaultH = baseH
    widthSlider.value = String(defaultW)
    widthValue.textContent = String(defaultW)
    heightSlider.value = String(defaultH)
    heightValue.textContent = String(defaultH)

    // Show preview
    const blob = new Blob([svgContent], { type: 'image/svg+xml' })
    previewImg.src = URL.createObjectURL(blob)
    svgPreview.style.display = 'flex'
    dropZone.innerHTML = `<div class="filename">${file.name}</div><div>Click or drop to replace</div>`
    dropZone.classList.add('has-file')

    btnRegister.disabled = false
    btnCopy.disabled = false
    updateManifestOutput()
    setStatus(`Loaded: ${file.name}`)
  }
  reader.readAsText(file)
}

// --- Sliders ---

const lockAspect = document.getElementById('lock-aspect') as HTMLInputElement
let aspectRatio = 1 // w / h, updated when SVG is loaded

widthSlider.addEventListener('input', () => {
  widthValue.textContent = widthSlider.value
  if (lockAspect.checked && aspectRatio > 0) {
    const newH = Math.round(parseInt(widthSlider.value) / aspectRatio)
    heightSlider.value = String(newH)
    heightValue.textContent = String(newH)
  }
  updateManifestOutput()
})
heightSlider.addEventListener('input', () => {
  heightValue.textContent = heightSlider.value
  if (lockAspect.checked && aspectRatio > 0) {
    const newW = Math.round(parseInt(heightSlider.value) * aspectRatio)
    widthSlider.value = String(newW)
    widthValue.textContent = String(newW)
  }
  updateManifestOutput()
})

// --- Color mode ---

document.querySelectorAll('input[name="colorMode"]').forEach(radio => {
  radio.addEventListener('change', () => {
    const mode = (document.querySelector('input[name="colorMode"]:checked') as HTMLInputElement).value
    replaceColorRow.style.display = mode === 'partial' ? 'flex' : 'none'
    updateManifestOutput()
  })
})

replaceColorInput.addEventListener('input', () => updateManifestOutput())

// --- Category ---

document.querySelectorAll('input[name="category"]').forEach(radio => {
  radio.addEventListener('change', () => updateManifestOutput())
})

// --- Helpers ---

function getCategory(): string {
  return (document.querySelector('input[name="category"]:checked') as HTMLInputElement).value
}

function getColorMode(): 'full' | 'partial' {
  return (document.querySelector('input[name="colorMode"]:checked') as HTMLInputElement).value as 'full' | 'partial'
}

function getReplaceColor(): string | null {
  return getColorMode() === 'partial' ? replaceColorInput.value : null
}

function getTemplateId(): string {
  return svgFilename?.replace(/[^a-z0-9_-]/gi, '-').toLowerCase() || 'custom'
}

function getTemplateName(): string {
  return svgFilename?.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) || 'Custom'
}

function buildTemplateInput(): TemplateInput | null {
  if (!svgContent || !svgViewBox) return null
  const input: TemplateInput = {
    id: getTemplateId(),
    name: getTemplateName(),
    category: getCategory(),
    svgContent,
    w: parseInt(widthSlider.value),
    h: parseInt(heightSlider.value),
    viewBox: svgViewBox,
  }
  const replaceColor = getReplaceColor()
  if (replaceColor !== null) {
    input.replaceColor = replaceColor
  }
  return input
}

function buildManifestEntry(): object | null {
  if (!svgViewBox) return null
  const category = getCategory()
  const entry: Record<string, unknown> = {
    id: getTemplateId(),
    name: getTemplateName(),
    svg: `${category}/${getTemplateId()}.svg`,
    w: parseInt(widthSlider.value),
    h: parseInt(heightSlider.value),
    viewBox: [svgViewBox.width, svgViewBox.height],
  }
  const replaceColor = getReplaceColor()
  if (replaceColor !== null) {
    entry.replaceColor = replaceColor
  }
  return entry
}

function updateManifestOutput() {
  const entry = buildManifestEntry()
  if (!entry) {
    manifestOutput.textContent = 'Load an SVG file to generate'
    return
  }
  manifestOutput.textContent = JSON.stringify(entry, null, 2)
}

function setStatus(msg: string) {
  statusEl.textContent = msg
}

// --- Register / Unregister ---

btnRegister.addEventListener('click', async () => {
  const input = buildTemplateInput()
  if (!input) return

  try {
    btnRegister.disabled = true
    setStatus('Registering...')
    const result = await client.registerTemplates([input])
    if (result.errors?.length > 0) {
      setStatus(`Error: ${result.errors[0].message}`)
      client.notify(`Template registration failed: ${result.errors[0].message}`, 'error')
      btnRegister.disabled = false
      return
    }
    isRegistered = true
    btnUnregister.disabled = false
    setStatus(`Registered: ${result.registered.join(', ')}`)
    client.notify(`Template "${input.name}" registered`, 'success')
  } catch (err) {
    setStatus(`Error: ${err}`)
    btnRegister.disabled = false
  }
})

btnUnregister.addEventListener('click', async () => {
  try {
    btnUnregister.disabled = true
    setStatus('Removing...')
    const result = await client.unregisterTemplates([getTemplateId()])
    isRegistered = false
    btnRegister.disabled = false
    setStatus(`Removed: ${result.unregistered.length} template(s)`)
    client.notify('Template removed', 'info')
  } catch (err) {
    setStatus(`Error: ${err}`)
    btnUnregister.disabled = false
  }
})

// --- Copy ---

btnCopy.addEventListener('click', async () => {
  const entry = buildManifestEntry()
  if (!entry) return
  try {
    await navigator.clipboard.writeText(JSON.stringify(entry, null, 2))
    btnCopy.textContent = 'Copied!'
    setTimeout(() => { btnCopy.textContent = 'Copy to Clipboard' }, 1500)
  } catch {
    // Fallback for iframe sandbox
    const text = JSON.stringify(entry, null, 2)
    const textarea = document.createElement('textarea')
    textarea.value = text
    document.body.appendChild(textarea)
    textarea.select()
    document.execCommand('copy')
    document.body.removeChild(textarea)
    btnCopy.textContent = 'Copied!'
    setTimeout(() => { btnCopy.textContent = 'Copy to Clipboard' }, 1500)
  }
})
