import { useState, useEffect, useRef } from 'react'
import { ExtensionClient } from './ExtensionClient'
import {
  generateScene,
  generateOpenScenarioDSL,
  ANTHROPIC_MODELS,
  OPENAI_MODELS,
  GEMINI_MODELS,
  EXAMPLE_PROMPTS,
  EXAMPLE_OPENSCENARIO_XML,
  EXAMPLE_OPENSCENARIO_DSL,
} from './sceneGenerator'
import type { ApiProvider, InputMode } from './sceneGenerator'
import type { InitPayload } from './types'

// drawtonomy design tokens
const C = {
  bgDef: '#f4f4f5', bgAct: '#e0e7ff', bgVal: '#f9fafb',
  txAct: '#4f46e5', txSec: '#6b7280', txLbl: '#374151', txMut: '#71717a',
  bdr: '#e4e4e7', danger: '#dc2626', sep: '#e4e4e7', success: '#16a34a',
} as const

const secTitle: React.CSSProperties = { fontSize: '0.5625rem', fontWeight: 600, color: C.txSec, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }
const lbl: React.CSSProperties = { display: 'block', fontSize: '0.625rem', fontWeight: 400, color: C.txLbl, marginBottom: 4 }
const inp: React.CSSProperties = { width: '100%', padding: '4px 6px', border: `1px solid ${C.bdr}`, borderRadius: 4, fontSize: '0.625rem', fontFamily: 'inherit', boxSizing: 'border-box', outline: 'none', backgroundColor: C.bgVal, color: C.txLbl }
const sel: React.CSSProperties = { ...inp, cursor: 'pointer', appearance: 'auto' as any }
const sep: React.CSSProperties = { height: 1, backgroundColor: C.sep, margin: '8px 0' }
const provBtn = (on: boolean): React.CSSProperties => ({ flex: 1, padding: 4, fontSize: '0.5625rem', fontWeight: 500, backgroundColor: on ? C.bgAct : C.bgDef, color: on ? C.txAct : C.txMut, border: 'none', borderRadius: 4, cursor: 'pointer', outline: 'none' })
const modeBtn = (on: boolean): React.CSSProperties => ({ flex: 1, padding: '4px 2px', fontSize: '0.5rem', fontWeight: on ? 600 : 400, backgroundColor: on ? C.bgAct : C.bgDef, color: on ? C.txAct : C.txMut, border: on ? `1px solid ${C.txAct}33` : '1px solid transparent', borderRadius: 4, cursor: 'pointer', outline: 'none', lineHeight: 1.3, textAlign: 'center' as const })

const DEFAULTS: Record<ApiProvider, string> = {
  anthropic: ANTHROPIC_MODELS[1].id,
  openai: OPENAI_MODELS[1].id,
  gemini: GEMINI_MODELS[1].id,
}

function modelsFor(p: ApiProvider) {
  return p === 'anthropic' ? ANTHROPIC_MODELS : p === 'openai' ? OPENAI_MODELS : GEMINI_MODELS
}

// ─── Main Component ──────────────────────────────────────────

export function SceneGeneratorUI() {
  const [client] = useState(() => new ExtensionClient('ai-scene-generator'))
  const [initPayload, setInitPayload] = useState<InitPayload | null>(null)

  // Settings
  const [apiProvider, setApiProvider] = useState<ApiProvider>(() => { try { return (localStorage.getItem('ai-sg-prov') as ApiProvider) ?? 'anthropic' } catch { return 'anthropic' } })
  const [model, setModel] = useState(() => { try { return localStorage.getItem('ai-sg-model') ?? ANTHROPIC_MODELS[1].id } catch { return ANTHROPIC_MODELS[1].id } })
  const [customModel, setCustomModel] = useState('')
  const [apiKey, setApiKey] = useState(() => { try { return localStorage.getItem('ai-sg-key') ?? '' } catch { return '' } })

  // Input mode and content
  const [inputMode, setInputMode] = useState<InputMode>('natural_language')
  const [prompt, setPrompt] = useState('')
  const [oscEditor, setOscEditor] = useState('')  // OpenSCENARIO editor content (for mode 2 and 3)
  const [oscStep, setOscStep] = useState<'prompt' | 'edit'>('prompt')  // Step for mode 3

  // State
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [log, setLog] = useState<string[]>([])
  const [logExpanded, setLogExpanded] = useState(false)
  const [showExamples, setShowExamples] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const logEndRef = useRef<HTMLDivElement>(null)

  const resolvedModel = model === '__custom__' ? customModel.trim() : model

  // Detect saved custom model
  useEffect(() => {
    const known = modelsFor(apiProvider)
    if (model && model !== '__custom__' && !known.some(m => m.id === model)) {
      setCustomModel(model); setModel('__custom__')
    }
  }, [])

  useEffect(() => { client.waitForInit().then(p => { setInitPayload(p); addLog('Connected to drawtonomy') }) }, [client])
  useEffect(() => { if (logExpanded && logEndRef.current) logEndRef.current.scrollIntoView({ behavior: 'smooth' }) }, [log, logExpanded])

  const addLog = (msg: string) => setLog(prev => [...prev.slice(-30), `${new Date().toLocaleTimeString()} ${msg}`])

  const handleProviderChange = (p: ApiProvider) => { setApiProvider(p); setModel(DEFAULTS[p]); setCustomModel('') }

  const handleModeChange = (m: InputMode) => {
    setInputMode(m)
    setError(null)
    if (m === 'text_to_openscenario') setOscStep('prompt')
  }

  const persist = () => { try { localStorage.setItem('ai-sg-key', apiKey); localStorage.setItem('ai-sg-prov', apiProvider); localStorage.setItem('ai-sg-model', resolvedModel) } catch {} }

  // ── Step 1 of mode 3: Generate OpenSCENARIO DSL from text
  const handleGenerateOSC = async () => {
    if (!prompt.trim() || !apiKey.trim()) return
    setGenerating(true); setError(null); setLogExpanded(true)
    addLog(`Generating OpenSCENARIO DSL from: "${prompt.slice(0, 50)}..."`)
    persist()
    try {
      const dsl = await generateOpenScenarioDSL({
        prompt, apiKey, apiProvider, model: resolvedModel,
        inputMode: 'text_to_openscenario', existingShapes: [], viewport: { x: 0, y: 0, zoom: 1, width: 1200, height: 800 },
        onLog: addLog,
      })
      setOscEditor(dsl)
      setOscStep('edit')
      addLog('DSL generated — edit and click "Render Diagram" to visualize')
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error'
      setError(msg); addLog(`ERROR: ${msg}`)
    } finally { setGenerating(false) }
  }

  // ── Main generate: render diagram from current input
  const handleGenerate = async () => {
    if (!apiKey.trim()) { setError('Please enter your API key'); return }
    setGenerating(true); setError(null); setLogExpanded(true)
    persist()

    // Determine what to send
    let inputText: string
    let mode: InputMode

    if (inputMode === 'openscenario') {
      inputText = oscEditor
      mode = 'openscenario'
      if (!inputText.trim()) { setError('Please enter OpenSCENARIO content'); setGenerating(false); return }
    } else if (inputMode === 'text_to_openscenario' && oscStep === 'edit') {
      inputText = oscEditor
      mode = 'openscenario'  // In step 2, we're converting OSC → diagram
      if (!inputText.trim()) { setError('OpenSCENARIO editor is empty'); setGenerating(false); return }
    } else {
      inputText = prompt
      mode = 'natural_language'
      if (!inputText.trim()) { setError('Please enter a scene description'); setGenerating(false); return }
    }

    addLog(`Rendering diagram...`)

    try {
      let existingShapes: unknown[] = []
      try { existingShapes = await client.requestShapes({ types: ['lane', 'vehicle', 'pedestrian', 'text'] }); addLog(`Read ${existingShapes.length} existing shapes`) } catch { addLog('Could not read existing shapes') }
      let vp = { x: 0, y: 0, zoom: 1, width: 1200, height: 800 }
      try { vp = await client.requestViewport() } catch { addLog('Using default viewport') }

      const shapes = await generateScene({
        prompt: inputText, apiKey, apiProvider, model: resolvedModel,
        inputMode: mode, existingShapes, viewport: vp, onLog: addLog,
      })
      addLog(`Generated ${shapes.length} shapes`)
      client.addShapes(shapes)
      client.notify(`Generated ${shapes.length} shapes`, 'success')
      addLog('Shapes sent to canvas ✓')
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error'
      setError(msg); addLog(`ERROR: ${msg}`)
      client.notify(`Failed: ${msg}`, 'error')
    } finally { setGenerating(false) }
  }

  const canGenerate = apiKey.trim() && resolvedModel && !generating

  return (
    <div style={{ padding: 8, fontFamily: 'system-ui, -apple-system, sans-serif' }}>
      {/* Connection */}
      {!initPayload && <div style={{ fontSize: '0.5625rem', color: '#f59e0b', backgroundColor: '#fffbeb', padding: '4px 6px', borderRadius: 4, marginBottom: 8 }}>Connecting to host...</div>}

      {/* Provider */}
      <div style={{ marginBottom: 8 }}>
        <div style={secTitle}>PROVIDER</div>
        <div style={{ display: 'flex', gap: 4 }}>
          {(['anthropic', 'openai', 'gemini'] as const).map(p => (
            <button key={p} onClick={() => handleProviderChange(p)} style={provBtn(apiProvider === p)}>
              {p === 'anthropic' ? 'Claude' : p === 'openai' ? 'GPT' : 'Gemini'}
            </button>
          ))}
        </div>
      </div>

      {/* API Key */}
      <div style={{ marginBottom: 8 }}>
        <label style={lbl}>API Key <span style={{ fontSize: '0.5rem', color: C.txMut }}>({apiProvider === 'anthropic' ? 'console.anthropic.com' : apiProvider === 'openai' ? 'platform.openai.com' : 'aistudio.google.com'})</span></label>
        <input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder={apiProvider === 'anthropic' ? 'sk-ant-...' : apiProvider === 'openai' ? 'sk-...' : 'AIza...'} style={inp} />
      </div>

      {/* Model */}
      <div style={{ marginBottom: 8 }}>
        <div style={secTitle}>MODEL</div>
        <select value={model} onChange={e => { setModel(e.target.value); if (e.target.value !== '__custom__') setCustomModel('') }} style={sel}>
          {modelsFor(apiProvider).map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
          <option value="__custom__">Other (custom model ID)</option>
        </select>
        {model === '__custom__' && <input type="text" value={customModel} onChange={e => setCustomModel(e.target.value)} placeholder="e.g. claude-sonnet-4-20250514" style={{ ...inp, marginTop: 4 }} />}
      </div>

      <div style={sep} />

      {/* ─── INPUT MODE SELECTOR ─── */}
      <div style={{ marginBottom: 8 }}>
        <div style={secTitle}>INPUT MODE</div>
        <div style={{ display: 'flex', gap: 3 }}>
          <button onClick={() => handleModeChange('natural_language')} style={modeBtn(inputMode === 'natural_language')}>Natural Language</button>
          <button onClick={() => handleModeChange('openscenario')} style={modeBtn(inputMode === 'openscenario')}>OpenSCENARIO</button>
          <button onClick={() => handleModeChange('text_to_openscenario')} style={modeBtn(inputMode === 'text_to_openscenario')}>Text → OSC</button>
        </div>
      </div>

      {/* ─── MODE 1: NATURAL LANGUAGE ─── */}
      {inputMode === 'natural_language' && (
        <div style={{ marginBottom: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={secTitle}>SCENE DESCRIPTION</div>
            <button onClick={() => setShowExamples(!showExamples)} style={{ fontSize: '0.5rem', color: C.txAct, background: 'none', border: 'none', cursor: 'pointer', padding: 0, marginBottom: 4 }}>
              {showExamples ? 'Hide examples' : 'Show examples'}
            </button>
          </div>
          {showExamples && <div style={{ marginBottom: 6 }}>
            {EXAMPLE_PROMPTS.map((ex, i) => (
              <button key={i} onClick={() => { setPrompt(ex.prompt); setShowExamples(false) }}
                style={{ display: 'block', width: '100%', textAlign: 'left', padding: '4px 6px', marginBottom: 3, fontSize: '0.5625rem', backgroundColor: C.bgVal, color: C.txLbl, border: `1px solid ${C.bdr}`, borderRadius: 4, cursor: 'pointer', lineHeight: 1.3 }}
                onMouseEnter={e => (e.target as HTMLElement).style.borderColor = C.txAct} onMouseLeave={e => (e.target as HTMLElement).style.borderColor = C.bdr}>
                <strong>{ex.label}:</strong> {ex.prompt.slice(0, 80)}...
              </button>
            ))}
          </div>}
          <textarea ref={textareaRef} value={prompt} onChange={e => setPrompt(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canGenerate && prompt.trim()) handleGenerate() }}
            placeholder="Describe the traffic scene..." rows={4} style={{ ...inp, resize: 'vertical', lineHeight: 1.4 }} />
          <button onClick={handleGenerate} disabled={!canGenerate || !prompt.trim()} style={{ width: '100%', marginTop: 6, padding: '6px 8px', fontSize: '0.5625rem', fontWeight: 600, backgroundColor: canGenerate && prompt.trim() ? C.bgAct : C.bgDef, color: canGenerate && prompt.trim() ? C.txAct : C.txMut, border: 'none', borderRadius: 4, cursor: canGenerate && prompt.trim() ? 'pointer' : 'not-allowed', outline: 'none' }}>
            {generating ? '⟳ Generating...' : 'Generate Scene'}
          </button>
        </div>
      )}

      {/* ─── MODE 2: OPENSCENARIO DIRECT ─── */}
      {inputMode === 'openscenario' && (
        <div style={{ marginBottom: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={secTitle}>OPENSCENARIO INPUT</div>
            <div style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
              <button onClick={() => setOscEditor(EXAMPLE_OPENSCENARIO_XML)} style={{ fontSize: '0.5rem', color: C.txAct, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>XML example</button>
              <button onClick={() => setOscEditor(EXAMPLE_OPENSCENARIO_DSL)} style={{ fontSize: '0.5rem', color: C.txAct, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>DSL example</button>
            </div>
          </div>
          <div style={{ fontSize: '0.5rem', color: C.txMut, marginBottom: 4 }}>Paste OpenSCENARIO XML (.xosc) or DSL (.osc) content. The LLM will interpret it and render a diagram.</div>
          <textarea value={oscEditor} onChange={e => setOscEditor(e.target.value)}
            placeholder={'Paste OpenSCENARIO XML or DSL here...\n\n<?xml version="1.0"?>\n<OpenSCENARIO>...\n\nor\n\nimport osc.standard\nscenario my_scenario:...'}
            rows={10} style={{ ...inp, resize: 'vertical', lineHeight: 1.4, fontFamily: 'ui-monospace, monospace', fontSize: '0.5625rem' }} />
          <button onClick={handleGenerate} disabled={!canGenerate || !oscEditor.trim()} style={{ width: '100%', marginTop: 6, padding: '6px 8px', fontSize: '0.5625rem', fontWeight: 600, backgroundColor: canGenerate && oscEditor.trim() ? C.bgAct : C.bgDef, color: canGenerate && oscEditor.trim() ? C.txAct : C.txMut, border: 'none', borderRadius: 4, cursor: canGenerate && oscEditor.trim() ? 'pointer' : 'not-allowed', outline: 'none' }}>
            {generating ? '⟳ Rendering...' : 'Render Diagram'}
          </button>
        </div>
      )}

      {/* ─── MODE 3: TEXT → OPENSCENARIO → DIAGRAM (2-step) ─── */}
      {inputMode === 'text_to_openscenario' && (
        <div style={{ marginBottom: 8 }}>
          {/* Step indicator */}
          <div style={{ display: 'flex', gap: 4, marginBottom: 6, alignItems: 'center' }}>
            <div style={{ padding: '2px 6px', borderRadius: 10, fontSize: '0.5rem', fontWeight: 600, backgroundColor: oscStep === 'prompt' ? C.txAct : C.bgDef, color: oscStep === 'prompt' ? '#fff' : C.txMut }}>1. Describe</div>
            <span style={{ fontSize: '0.5rem', color: C.txMut }}>→</span>
            <div style={{ padding: '2px 6px', borderRadius: 10, fontSize: '0.5rem', fontWeight: 600, backgroundColor: oscStep === 'edit' ? C.txAct : C.bgDef, color: oscStep === 'edit' ? '#fff' : C.txMut }}>2. Edit & Render</div>
          </div>

          {oscStep === 'prompt' && (
            <>
              <div style={secTitle}>DESCRIBE YOUR SCENARIO</div>
              <div style={{ fontSize: '0.5rem', color: C.txMut, marginBottom: 4 }}>Describe the scenario in natural language. The LLM will generate OpenSCENARIO DSL that you can then edit before rendering.</div>
              <textarea value={prompt} onChange={e => setPrompt(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canGenerate && prompt.trim()) handleGenerateOSC() }}
                placeholder={'Example: A highway cut-in scenario where a target vehicle in the adjacent lane cuts into the ego vehicle\'s lane when the distance is less than 20m'}
                rows={4} style={{ ...inp, resize: 'vertical', lineHeight: 1.4 }} />
              <button onClick={handleGenerateOSC} disabled={!canGenerate || !prompt.trim()} style={{ width: '100%', marginTop: 6, padding: '6px 8px', fontSize: '0.5625rem', fontWeight: 600, backgroundColor: canGenerate && prompt.trim() ? C.bgAct : C.bgDef, color: canGenerate && prompt.trim() ? C.txAct : C.txMut, border: 'none', borderRadius: 4, cursor: canGenerate && prompt.trim() ? 'pointer' : 'not-allowed', outline: 'none' }}>
                {generating ? '⟳ Generating DSL...' : 'Generate OpenSCENARIO DSL'}
              </button>
            </>
          )}

          {oscStep === 'edit' && (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={secTitle}>EDIT OPENSCENARIO DSL</div>
                <button onClick={() => setOscStep('prompt')} style={{ fontSize: '0.5rem', color: C.txAct, background: 'none', border: 'none', cursor: 'pointer', padding: 0, marginBottom: 4 }}>← Back to prompt</button>
              </div>
              <div style={{ fontSize: '0.5rem', color: C.txMut, marginBottom: 4 }}>Review and edit the generated OpenSCENARIO DSL, then click "Render Diagram" to visualize it.</div>
              <textarea value={oscEditor} onChange={e => setOscEditor(e.target.value)}
                rows={12} style={{ ...inp, resize: 'vertical', lineHeight: 1.4, fontFamily: 'ui-monospace, monospace', fontSize: '0.5625rem' }} />
              <div style={{ display: 'flex', gap: 4, marginTop: 6 }}>
                <button onClick={() => { setOscStep('prompt') }} style={{ flex: 1, padding: '6px 8px', fontSize: '0.5625rem', fontWeight: 500, backgroundColor: C.bgDef, color: C.txMut, border: 'none', borderRadius: 4, cursor: 'pointer', outline: 'none' }}>
                  ← Regenerate
                </button>
                <button onClick={handleGenerate} disabled={!canGenerate || !oscEditor.trim()} style={{ flex: 2, padding: '6px 8px', fontSize: '0.5625rem', fontWeight: 600, backgroundColor: canGenerate && oscEditor.trim() ? C.bgAct : C.bgDef, color: canGenerate && oscEditor.trim() ? C.txAct : C.txMut, border: 'none', borderRadius: 4, cursor: canGenerate && oscEditor.trim() ? 'pointer' : 'not-allowed', outline: 'none' }}>
                  {generating ? '⟳ Rendering...' : 'Render Diagram'}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Error */}
      {error && <div style={{ marginTop: 4, padding: '4px 6px', backgroundColor: '#fef2f2', color: C.danger, borderRadius: 4, fontSize: '0.5625rem', lineHeight: 1.4, wordBreak: 'break-word' }}>{error}</div>}

      {/* Log */}
      {log.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div style={{ ...secTitle, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, userSelect: 'none' }} onClick={() => setLogExpanded(!logExpanded)}>
            <span style={{ fontSize: '0.5rem', transition: 'transform 0.15s', transform: logExpanded ? 'rotate(90deg)' : 'rotate(0deg)', display: 'inline-block' }}>▶</span>
            LOG ({log.length}) {log.some(l => l.includes('ERROR')) && <span style={{ color: C.danger, fontSize: '0.5rem' }}>⚠</span>}
          </div>
          {logExpanded && (
            <div style={{ fontSize: '0.5625rem', color: C.txMut, maxHeight: 120, overflow: 'auto', backgroundColor: C.bgVal, padding: '4px 6px', borderRadius: 4, lineHeight: 1.5, fontFamily: 'ui-monospace, monospace' }}>
              {log.map((e, i) => <div key={i} style={{ color: e.includes('ERROR') ? C.danger : e.includes('✓') ? C.success : e.includes('Warning') ? '#f59e0b' : C.txMut }}>{e}</div>)}
              <div ref={logEndRef} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
