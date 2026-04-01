// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ExtensionClient } from '../src/ExtensionClient'

// Simulate postMessage round-trip: capture messages sent to parent,
// then dispatch responses back via window 'message' event.
let posted: Array<{ type: string; payload: any }>

function mockPostMessage() {
  posted = []
  vi.stubGlobal('parent', {
    postMessage: (msg: any, _target: string) => {
      posted.push(msg)
    },
  })
}

function dispatchMessage(data: any) {
  window.dispatchEvent(new MessageEvent('message', { data }))
}

describe('ExtensionClient', () => {
  beforeEach(() => {
    mockPostMessage()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // --- Constructor & Init ---

  it('sends ext:ready on construction', () => {
    new ExtensionClient('test-ext')
    expect(posted.length).toBe(1)
    expect(posted[0]).toEqual({
      type: 'ext:ready',
      payload: { manifestId: 'test-ext' },
    })
  })

  it('waitForInit resolves when ext:init is received', async () => {
    const client = new ExtensionClient('test-ext')
    const initPayload = {
      hostVersion: '1.0.0',
      grantedCapabilities: ['shapes:write'],
      viewport: { width: 800, height: 600 },
    }

    const promise = client.waitForInit()
    dispatchMessage({ type: 'ext:init', payload: initPayload })

    const result = await promise
    expect(result).toEqual(initPayload)
  })

  // --- shapes:write ---

  it('addShapes sends ext:shapes-add', () => {
    const client = new ExtensionClient('test-ext')
    posted = [] // clear ready message
    const shapes = [{ id: 's1', type: 'vehicle', x: 0, y: 0, rotation: 0, zIndex: 0, props: {} }]
    client.addShapes(shapes)
    expect(posted[0].type).toBe('ext:shapes-add')
    expect(posted[0].payload.shapes).toEqual(shapes)
  })

  it('updateShapes sends ext:shapes-update', () => {
    const client = new ExtensionClient('test-ext')
    posted = []
    const updates = [{ id: 's1', props: { color: 'red' } }]
    client.updateShapes(updates)
    expect(posted[0].type).toBe('ext:shapes-update')
    expect(posted[0].payload.updates).toEqual(updates)
  })

  it('deleteShapes sends ext:shapes-delete', () => {
    const client = new ExtensionClient('test-ext')
    posted = []
    client.deleteShapes(['s1', 's2'])
    expect(posted[0].type).toBe('ext:shapes-delete')
    expect(posted[0].payload.ids).toEqual(['s1', 's2'])
  })

  // --- shapes:read ---

  it('requestShapes sends request and resolves with shapes', async () => {
    const client = new ExtensionClient('test-ext')
    posted = []

    const promise = client.requestShapes({ types: ['vehicle'] })
    const requestId = posted[0].payload.requestId

    expect(posted[0].type).toBe('ext:shapes-request')
    expect(posted[0].payload.filter).toEqual({ types: ['vehicle'] })

    const shapes = [{ id: 's1', type: 'vehicle', x: 0, y: 0, rotation: 0, zIndex: 0, props: {} }]
    dispatchMessage({ type: 'ext:shapes-response', payload: { requestId, shapes } })

    const result = await promise
    expect(result).toEqual(shapes)
  })

  // --- snapshot:read ---

  it('requestSnapshot sends request and resolves with snapshot', async () => {
    const client = new ExtensionClient('test-ext')
    posted = []

    const promise = client.requestSnapshot()
    const requestId = posted[0].payload.requestId

    expect(posted[0].type).toBe('ext:snapshot-request')

    const snapshot = { version: '1.1', timestamp: '2026-01-01', shapes: [], camera: { x: 0, y: 0, z: 1 } }
    dispatchMessage({ type: 'ext:snapshot-response', payload: { requestId, snapshot } })

    const result = await promise
    expect(result).toEqual(snapshot)
  })

  // --- snapshot:export ---

  it('requestExport sends request with returnData and resolves with data URI', async () => {
    const client = new ExtensionClient('test-ext')
    posted = []

    const promise = client.requestExport('png', { returnData: true })
    const requestId = posted[0].payload.requestId

    expect(posted[0].type).toBe('ext:export-request')
    expect(posted[0].payload.format).toBe('png')
    expect(posted[0].payload.returnData).toBe(true)

    const response = {
      requestId,
      data: 'data:image/png;base64,abc123',
      mimeType: 'image/png',
      filename: 'scene-2026-01-01.png',
    }
    dispatchMessage({ type: 'ext:export-response', payload: response })

    const result = await promise
    expect(result.data).toBe('data:image/png;base64,abc123')
    expect(result.mimeType).toBe('image/png')
    expect(result.filename).toBe('scene-2026-01-01.png')
  })

  it('requestExport without returnData sends undefined', async () => {
    const client = new ExtensionClient('test-ext')
    posted = []

    const promise = client.requestExport('svg')
    const requestId = posted[0].payload.requestId

    expect(posted[0].payload.returnData).toBeUndefined()

    dispatchMessage({
      type: 'ext:export-response',
      payload: { requestId, data: '', mimeType: 'image/svg+xml', filename: 'scene.svg' },
    })

    const result = await promise
    expect(result.data).toBe('')
  })

  // --- viewport:read ---

  it('requestViewport sends request and resolves with viewport data', async () => {
    const client = new ExtensionClient('test-ext')
    posted = []

    const promise = client.requestViewport()
    const requestId = posted[0].payload.requestId

    expect(posted[0].type).toBe('ext:viewport-request')

    const viewport = { requestId, x: 10, y: 20, zoom: 1.5, width: 800, height: 600 }
    dispatchMessage({ type: 'ext:viewport-response', payload: viewport })

    const result = await promise
    expect(result.x).toBe(10)
    expect(result.y).toBe(20)
    expect(result.zoom).toBe(1.5)
    expect(result.width).toBe(800)
    expect(result.height).toBe(600)
  })

  // --- selection:read ---

  it('requestSelection sends request and resolves with selection', async () => {
    const client = new ExtensionClient('test-ext')
    posted = []

    const promise = client.requestSelection()
    const requestId = posted[0].payload.requestId

    expect(posted[0].type).toBe('ext:selection-request')

    dispatchMessage({ type: 'ext:selection-response', payload: { requestId, ids: ['s1', 's2'] } })

    const result = await promise
    expect(result.ids).toEqual(['s1', 's2'])
  })

  // --- ui:notify ---

  it('notify sends ext:notify with default level', () => {
    const client = new ExtensionClient('test-ext')
    posted = []
    client.notify('Hello')
    expect(posted[0]).toEqual({
      type: 'ext:notify',
      payload: { message: 'Hello', level: 'info' },
    })
  })

  it('notify sends ext:notify with specified level', () => {
    const client = new ExtensionClient('test-ext')
    posted = []
    client.notify('Error!', 'error')
    expect(posted[0].payload.level).toBe('error')
  })

  // --- ui:panel ---

  it('resize sends ext:resize', () => {
    const client = new ExtensionClient('test-ext')
    posted = []
    client.resize(400, 300)
    expect(posted[0]).toEqual({
      type: 'ext:resize',
      payload: { height: 400, width: 300 },
    })
  })

  it('resize sends ext:resize without width', () => {
    const client = new ExtensionClient('test-ext')
    posted = []
    client.resize(500)
    expect(posted[0].payload.height).toBe(500)
    expect(posted[0].payload.width).toBeUndefined()
  })

  // --- Error handling ---

  it('rejects pending request on ext:error', async () => {
    const client = new ExtensionClient('test-ext')
    posted = []

    const promise = client.requestShapes()
    const requestId = posted[0].payload.requestId

    dispatchMessage({
      type: 'ext:error',
      payload: { requestId, message: 'Permission denied' },
    })

    await expect(promise).rejects.toThrow('Permission denied')
  })

  // --- Timeout ---

  it('rejects on timeout', async () => {
    const client = new ExtensionClient('test-ext', { requestTimeout: 50 })
    posted = []

    const promise = client.requestViewport()
    // No response dispatched — should timeout

    await expect(promise).rejects.toThrow(/timed out/)
  })

  // --- Message filtering ---

  it('ignores messages without ext: prefix', async () => {
    const client = new ExtensionClient('test-ext')
    posted = []

    const promise = client.requestViewport()
    const requestId = posted[0].payload.requestId

    // This should be ignored
    dispatchMessage({ type: 'other-message', payload: { requestId, x: 0, y: 0, zoom: 1, width: 100, height: 100 } })

    // Now send the real response
    dispatchMessage({ type: 'ext:viewport-response', payload: { requestId, x: 0, y: 0, zoom: 1, width: 100, height: 100 } })

    const result = await promise
    expect(result.width).toBe(100)
  })

  it('ignores malformed messages', () => {
    new ExtensionClient('test-ext')
    // Should not throw
    dispatchMessage(null)
    dispatchMessage(undefined)
    dispatchMessage('string')
    dispatchMessage({ noType: true })
    dispatchMessage({ type: 123 })
  })
})
