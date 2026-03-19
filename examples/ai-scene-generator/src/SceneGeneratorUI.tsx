import { useState, useEffect, useRef } from 'react'
import { ExtensionClient } from './ExtensionClient'
import {
  generateScene,
  ANTHROPIC_MODELS,
  OPENAI_MODELS,
  GEMINI_MODELS,
  EXAMPLE_PROMPTS,
} from './sceneGenerator'
import type { ApiProvider, AnthropicModelId } from './sceneGenerator'
import type { InitPayload } from './types'

// drawtonomy design tokens (matches PANEL_COLORS / PANEL_TYPOGRAPHY)
const COLORS = {
  bgDefault: '#f4f4f5',
  bgActive: '#e0e7ff',
  bgValue: '#f9fafb',
  textActive: '#4f46e5',
  textSecondary: '#6b7280',
  textLabel: '#374151',
  textMuted: '#71717a',
  borderDefault: '#e4e4e7',
  danger: '#dc2626',
  separator: '#e4e4e7',
  success: '#16a34a',
} as const

const sectionTitleStyle: React.CSSProperties = {
  fontSize: '0.5625rem',
  fontWeight: 600,
  color: COLORS.textSecondary,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  marginBottom: 4,
}

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: '0.625rem',
  fontWeight: 400,
  color: COLORS.textLabel,
  marginBottom: 4,
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '4px 6px',
  border: `1px solid ${COLORS.borderDefault}`,
  borderRadius: 4,
  fontSize: '0.625rem',
  fontFamily: 'inherit',
  boxSizing: 'border-box',
  outline: 'none',
  backgroundColor: COLORS.bgValue,
  color: COLORS.textLabel,
}

const separatorStyle: React.CSSProperties = {
  height: 1,
  backgroundColor: COLORS.separator,
  margin: '8px 0',
}

const providerBtnStyle = (active: boolean): React.CSSProperties => ({
  flex: 1,
  padding: 4,
  fontSize: '0.5625rem',
  fontWeight: 500,
  backgroundColor: active ? COLORS.bgActive : COLORS.bgDefault,
  color: active ? COLORS.textActive : COLORS.textMuted,
  border: 'none',
  borderRadius: 4,
  cursor: 'pointer',
  transition: 'all 0.15s',
  outline: 'none',
})

const modelBtnStyle = (active: boolean): React.CSSProperties => ({
  padding: '3px 6px',
  fontSize: '0.5625rem',
  fontWeight: 500,
  backgroundColor: active ? COLORS.bgActive : COLORS.bgDefault,
  color: active ? COLORS.textActive : COLORS.textMuted,
  border: 'none',
  borderRadius: 4,
  cursor: 'pointer',
  transition: 'all 0.15s',
  outline: 'none',
})

// Default models per provider
const DEFAULT_MODELS: Record<ApiProvider, string> = {
  anthropic: ANTHROPIC_MODELS[1].id, // Sonnet 4
  openai: OPENAI_MODELS[1].id, // GPT-4o
  gemini: GEMINI_MODELS[1].id, // Gemini 2.5 Flash
}

function getModelsForProvider(provider: ApiProvider) {
  if (provider === 'anthropic') return ANTHROPIC_MODELS
  if (provider === 'openai') return OPENAI_MODELS
  return GEMINI_MODELS
}

// ─── Main Component ──────────────────────────────────────────

export function SceneGeneratorUI() {
  const [client] = useState(() => new ExtensionClient('ai-scene-generator'))
  const [initPayload, setInitPayload] = useState<InitPayload | null>(null)
  const [prompt, setPrompt] = useState('')
  const [apiKey, setApiKey] = useState(() => {
    try {
      return localStorage.getItem('ai-scene-gen-api-key') ?? ''
    } catch {
      return ''
    }
  })
  const [apiProvider, setApiProvider] = useState<ApiProvider>(() => {
    try {
      return (localStorage.getItem('ai-scene-gen-provider') as ApiProvider) ?? 'anthropic'
    } catch {
      return 'anthropic'
    }
  })
  const [model, setModel] = useState(() => {
    try {
      return localStorage.getItem('ai-scene-gen-model') ?? ANTHROPIC_MODELS[1].id
    } catch {
      return ANTHROPIC_MODELS[1].id
    }
  })
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [log, setLog] = useState<string[]>([])
  const [logExpanded, setLogExpanded] = useState(false)
  const [showExamples, setShowExamples] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const logEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    client.waitForInit().then(payload => {
      setInitPayload(payload)
      addLog('Connected to drawtonomy host')
    })
  }, [client])

  // Auto-scroll log
  useEffect(() => {
    if (logExpanded && logEndRef.current) {
      logEndRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [log, logExpanded])

  const addLog = (msg: string) => {
    setLog(prev => [...prev.slice(-30), `${new Date().toLocaleTimeString()} ${msg}`])
  }

  const handleProviderChange = (provider: ApiProvider) => {
    setApiProvider(provider)
    setModel(DEFAULT_MODELS[provider])
  }

  const handleGenerate = async () => {
    if (!prompt.trim()) return
    if (!apiKey.trim()) {
      setError('Please enter your API key')
      return
    }

    setGenerating(true)
    setError(null)
    setLogExpanded(true)
    addLog(`Generating: "${prompt.slice(0, 60)}..."`)

    try {
      // Persist settings
      try {
        localStorage.setItem('ai-scene-gen-api-key', apiKey)
        localStorage.setItem('ai-scene-gen-provider', apiProvider)
        localStorage.setItem('ai-scene-gen-model', model)
      } catch {
        /* sandboxed iframe */
      }

      // Get existing shapes for context
      let existingShapes: unknown[] = []
      try {
        existingShapes = await client.requestShapes({
          types: ['lane', 'vehicle', 'pedestrian', 'text'],
        })
        addLog(`Read ${existingShapes.length} existing shapes`)
      } catch {
        addLog('Could not read existing shapes (continuing without context)')
      }

      // Get viewport
      let viewport = { x: 0, y: 0, zoom: 1, width: 1200, height: 800 }
      try {
        viewport = await client.requestViewport()
        addLog(`Viewport: ${viewport.width}x${viewport.height} @ zoom ${viewport.zoom.toFixed(2)}`)
      } catch {
        addLog('Could not read viewport (using defaults)')
      }

      // Generate scene
      const shapes = await generateScene({
        prompt,
        apiKey,
        apiProvider,
        model,
        existingShapes,
        viewport,
        onLog: addLog,
      })

      addLog(`Generated ${shapes.length} shapes`)

      // Send shapes to host
      client.addShapes(shapes)
      client.notify(`Generated ${shapes.length} shapes`, 'success')
      addLog('Shapes sent to canvas ✓')
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error'
      setError(msg)
      addLog(`ERROR: ${msg}`)
      client.notify(`Generation failed: ${msg}`, 'error')
    } finally {
      setGenerating(false)
    }
  }

  const canGenerate = prompt.trim() && apiKey.trim() && !generating
  const models = getModelsForProvider(apiProvider)

  return (
    <div style={{ padding: 8, fontFamily: 'system-ui, -apple-system, sans-serif' }}>
      {/* Connection Status */}
      {!initPayload && (
        <div
          style={{
            fontSize: '0.5625rem',
            color: '#f59e0b',
            backgroundColor: '#fffbeb',
            padding: '4px 6px',
            borderRadius: 4,
            marginBottom: 8,
          }}
        >
          Connecting to host...
        </div>
      )}

      {/* Provider Selection */}
      <div style={{ marginBottom: 8 }}>
        <div style={sectionTitleStyle}>PROVIDER</div>
        <div style={{ display: 'flex', gap: 4 }}>
          {(['anthropic', 'openai', 'gemini'] as const).map(p => (
            <button
              key={p}
              onClick={() => handleProviderChange(p)}
              style={providerBtnStyle(apiProvider === p)}
            >
              {p === 'anthropic' ? 'Claude' : p === 'openai' ? 'GPT' : 'Gemini'}
            </button>
          ))}
        </div>
      </div>

      {/* API Key */}
      <div style={{ marginBottom: 8 }}>
        <label style={labelStyle}>
          API Key
          <span style={{ fontSize: '0.5rem', color: COLORS.textMuted, marginLeft: 4 }}>
            ({apiProvider === 'anthropic'
              ? 'console.anthropic.com'
              : apiProvider === 'openai'
                ? 'platform.openai.com'
                : 'aistudio.google.com'})
          </span>
        </label>
        <input
          type="password"
          value={apiKey}
          onChange={e => setApiKey(e.target.value)}
          placeholder={
            apiProvider === 'anthropic'
              ? 'sk-ant-...'
              : apiProvider === 'openai'
                ? 'sk-...'
                : 'AIza...'
          }
          style={inputStyle}
        />
      </div>

      {/* Model Selection */}
      <div style={{ marginBottom: 8 }}>
        <div style={sectionTitleStyle}>MODEL</div>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {models.map(m => (
            <button
              key={m.id}
              onClick={() => setModel(m.id)}
              style={modelBtnStyle(model === m.id)}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      <div style={separatorStyle} />

      {/* Scene Description */}
      <div style={{ marginBottom: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={sectionTitleStyle}>SCENE DESCRIPTION</div>
          <button
            onClick={() => setShowExamples(!showExamples)}
            style={{
              fontSize: '0.5rem',
              color: COLORS.textActive,
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: 0,
              marginBottom: 4,
            }}
          >
            {showExamples ? 'Hide examples' : 'Show examples'}
          </button>
        </div>

        {/* Example Prompts */}
        {showExamples && (
          <div style={{ marginBottom: 6 }}>
            {EXAMPLE_PROMPTS.map((ex, i) => (
              <button
                key={i}
                onClick={() => {
                  setPrompt(ex.prompt)
                  setShowExamples(false)
                  textareaRef.current?.focus()
                }}
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  padding: '4px 6px',
                  marginBottom: 3,
                  fontSize: '0.5625rem',
                  backgroundColor: COLORS.bgValue,
                  color: COLORS.textLabel,
                  border: `1px solid ${COLORS.borderDefault}`,
                  borderRadius: 4,
                  cursor: 'pointer',
                  lineHeight: 1.3,
                  transition: 'border-color 0.15s',
                }}
                onMouseEnter={e =>
                  ((e.target as HTMLElement).style.borderColor = COLORS.textActive)
                }
                onMouseLeave={e =>
                  ((e.target as HTMLElement).style.borderColor = COLORS.borderDefault)
                }
              >
                <strong>{ex.label}:</strong> {ex.prompt.slice(0, 80)}...
              </button>
            ))}
          </div>
        )}

        <textarea
          ref={textareaRef}
          value={prompt}
          onChange={e => setPrompt(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canGenerate) {
              handleGenerate()
            }
          }}
          placeholder={
            'Describe the traffic scene...\n\nExample: A two-lane road with two cars and a pedestrian'
          }
          rows={4}
          style={{
            ...inputStyle,
            resize: 'vertical',
            lineHeight: 1.4,
          }}
        />
        <div
          style={{
            fontSize: '0.5rem',
            color: COLORS.textMuted,
            marginTop: 2,
            textAlign: 'right',
          }}
        >
          {navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}+Enter to generate
        </div>
      </div>

      {/* Generate Button */}
      <button
        onClick={handleGenerate}
        disabled={!canGenerate}
        style={{
          width: '100%',
          padding: '6px 8px',
          fontSize: '0.5625rem',
          fontWeight: 600,
          backgroundColor: canGenerate ? COLORS.bgActive : COLORS.bgDefault,
          color: canGenerate ? COLORS.textActive : COLORS.textMuted,
          border: 'none',
          borderRadius: 4,
          cursor: canGenerate ? 'pointer' : 'not-allowed',
          transition: 'all 0.15s',
          outline: 'none',
          letterSpacing: '0.02em',
        }}
      >
        {generating ? '⟳ Generating...' : 'Generate Scene'}
      </button>

      {/* Error */}
      {error && (
        <div
          style={{
            marginTop: 8,
            padding: '4px 6px',
            backgroundColor: '#fef2f2',
            color: COLORS.danger,
            borderRadius: 4,
            fontSize: '0.5625rem',
            lineHeight: 1.4,
            wordBreak: 'break-word',
          }}
        >
          {error}
        </div>
      )}

      {/* Log */}
      {log.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div
            style={{
              ...sectionTitleStyle,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              userSelect: 'none',
            }}
            onClick={() => setLogExpanded(!logExpanded)}
          >
            <span
              style={{
                display: 'inline-block',
                fontSize: '0.5rem',
                transition: 'transform 0.15s',
                transform: logExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
              }}
            >
              ▶
            </span>
            LOG ({log.length})
            {log.some(l => l.includes('ERROR')) && (
              <span style={{ color: COLORS.danger, fontSize: '0.5rem' }}>⚠</span>
            )}
          </div>
          {logExpanded && (
            <div
              style={{
                fontSize: '0.5625rem',
                color: COLORS.textMuted,
                maxHeight: 120,
                overflow: 'auto',
                backgroundColor: COLORS.bgValue,
                padding: '4px 6px',
                borderRadius: 4,
                lineHeight: 1.5,
                fontFamily: 'ui-monospace, monospace',
              }}
            >
              {log.map((entry, i) => (
                <div
                  key={i}
                  style={{
                    color: entry.includes('ERROR')
                      ? COLORS.danger
                      : entry.includes('✓')
                        ? COLORS.success
                        : entry.includes('Warning')
                          ? '#f59e0b'
                          : COLORS.textMuted,
                  }}
                >
                  {entry}
                </div>
              ))}
              <div ref={logEndRef} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
