// Scene Generator - AI API integration for generating traffic scenes
// Supports three input modes:
//   1. Natural language → scene spec
//   2. OpenSCENARIO XML/DSL → scene spec (LLM extracts spatial layout)
//   3. Natural language → OpenSCENARIO DSL (editable) → scene spec

import {
  createPoint,
  createLinestring,
  createLane,
  createVehicle,
  createPedestrian,
  createText,
  createRectangle,
  createEllipse,
  resetIdCounter,
} from '@drawtonomy/sdk'
import type { BaseShape } from './types'

// ─── Model Definitions ───────────────────────────────────────

export const ANTHROPIC_MODELS = [
  { id: 'claude-opus-4-20250514', label: 'Claude Opus 4' },
  { id: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4' },
  { id: 'claude-haiku-4-20250506', label: 'Claude Haiku 4' },
] as const

export const OPENAI_MODELS = [
  { id: 'o3-mini', label: 'o3-mini' },
  { id: 'gpt-4o', label: 'GPT-4o' },
  { id: 'gpt-4o-mini', label: 'GPT-4o mini' },
] as const

export const GEMINI_MODELS = [
  { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
  { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash' },
] as const

export type ApiProvider = 'anthropic' | 'openai' | 'gemini'
export type InputMode = 'natural_language' | 'openscenario' | 'text_to_openscenario'

// ─── Example prompts and OpenSCENARIO samples ────────────────

export const EXAMPLE_PROMPTS = [
  { label: 'Highway Lane Change', prompt: 'A 3-lane highway going left-to-right. An ego sedan (blue) in the center lane, a truck (grey) in the right lane slightly ahead. Show a dashed path for the ego vehicle changing to the left lane.' },
  { label: 'AEB Scenario', prompt: 'A city road with 2 lanes going top-to-bottom. An ego sedan (blue) driving downward. A child pedestrian crossing from the right side. Place a red text annotation saying "Danger Zone" near the pedestrian.' },
  { label: 'T-Intersection', prompt: 'A T-intersection: a horizontal 2-lane road and a vertical road joining from below. Place a red sedan approaching from the left, an ego blue sedan coming from the bottom road, and a pedestrian crossing at the junction.' },
  { label: 'Blind Spot Monitor', prompt: 'A 3-lane highway going left-to-right. Ego sedan (blue) in the center lane. A motorcycle in the left lane positioned in the ego vehicle blind spot area. Another sedan ahead in the center lane. Add a text annotation "BSM Alert" near the motorcycle.' },
] as const

export const EXAMPLE_OPENSCENARIO_XML = `<?xml version="1.0" encoding="utf-8"?>
<OpenSCENARIO>
  <FileHeader revMajor="1" revMinor="1" date="2024-01-01" description="Cut-in scenario" author="Example"/>
  <RoadNetwork>
    <LogicFile filepath="highway_3lane.xodr"/>
  </RoadNetwork>
  <Entities>
    <ScenarioObject name="Ego">
      <Vehicle name="ego_sedan" vehicleCategory="car">
        <BoundingBox><Dimensions width="2" length="5" height="1.8"/></BoundingBox>
      </Vehicle>
    </ScenarioObject>
    <ScenarioObject name="TargetVehicle">
      <Vehicle name="target_sedan" vehicleCategory="car">
        <BoundingBox><Dimensions width="2" length="5" height="1.8"/></BoundingBox>
      </Vehicle>
    </ScenarioObject>
  </Entities>
  <Storyboard>
    <Init>
      <Actions>
        <Private entityRef="Ego">
          <PrivateAction>
            <TeleportAction><Position><LanePosition roadId="1" laneId="-2" s="50"/></Position></TeleportAction>
          </PrivateAction>
          <PrivateAction>
            <LongitudinalAction><SpeedAction><SpeedActionDynamics dynamicsShape="step"/><SpeedActionTarget><AbsoluteTargetSpeed value="30"/></SpeedActionTarget></SpeedAction></LongitudinalAction>
          </PrivateAction>
        </Private>
        <Private entityRef="TargetVehicle">
          <PrivateAction>
            <TeleportAction><Position><LanePosition roadId="1" laneId="-3" s="80"/></Position></TeleportAction>
          </PrivateAction>
          <PrivateAction>
            <LongitudinalAction><SpeedAction><SpeedActionDynamics dynamicsShape="step"/><SpeedActionTarget><AbsoluteTargetSpeed value="40"/></SpeedActionTarget></SpeedAction></LongitudinalAction>
          </PrivateAction>
        </Private>
      </Actions>
    </Init>
    <Story name="CutInStory">
      <Act name="CutInAct">
        <ManeuverGroup name="CutInGroup" maximumExecutionCount="1">
          <Actors><EntityRef entityRef="TargetVehicle"/></Actors>
          <Maneuver name="CutInManeuver">
            <Event name="CutInEvent" priority="overwrite">
              <Action name="LaneChange">
                <PrivateAction>
                  <LateralAction>
                    <LaneChangeAction>
                      <LaneChangeActionDynamics dynamicsShape="sinusoidal" value="3" dynamicsDimension="time"/>
                      <LaneChangeTarget><RelativeTargetLane entityRef="Ego" value="0"/></LaneChangeTarget>
                    </LaneChangeAction>
                  </LateralAction>
                </PrivateAction>
              </Action>
            </Event>
          </Maneuver>
        </ManeuverGroup>
      </Act>
    </Story>
  </Storyboard>
</OpenSCENARIO>`

export const EXAMPLE_OPENSCENARIO_DSL = `import osc.standard

# Cut-in scenario: target vehicle changes into ego's lane
scenario cut_in:
    ego: vehicle with:
        keep(it.category == vehicle_category!car)
    target: vehicle with:
        keep(it.category == vehicle_category!car)

    do parallel:
        ego.drive() with:
            speed(speed: 30kph)
            lane(lane: 2, at: start)

        serial:
            target.drive() with:
                speed(speed: 40kph)
                lane(lane: 3, at: start)
                position(distance: 30m, ahead_of: ego, at: start)

            target.drive() with:
                lane(same_as: ego, at: end)
                speed(speed: 40kph)`

// ─── Generate Options ────────────────────────────────────────

interface GenerateOptions {
  prompt: string
  apiKey: string
  apiProvider: ApiProvider
  model: string
  inputMode: InputMode
  existingShapes: unknown[]
  viewport: { x: number; y: number; zoom: number; width: number; height: number }
  onLog?: (msg: string) => void
}

// ─── System Prompts ──────────────────────────────────────────

const SCENE_SPEC_SCHEMA = `
RESPOND WITH ONLY A VALID JSON OBJECT (no markdown, no backticks, no explanation):
{
  "lanes": [{"leftPoints": [{"x":N,"y":N},...], "rightPoints": [{"x":N,"y":N},...], "attributes": {"subtype":"road"|"sidewalk","speed_limit":"30"|"50"|"80"}}],
  "vehicles": [{"x":N,"y":N,"rotation":N,"templateId":"sedan"|"bus"|"truck"|"motorcycle"|"bicycle","color":"string","label":"string"}],
  "pedestrians": [{"x":N,"y":N,"rotation":N,"templateId":"filled","color":"string","label":"string"}],
  "annotations": [{"x":N,"y":N,"text":"string","color":"string","fontSize":N}],
  "paths": [{"points":[{"x":N,"y":N},...],"color":"string","strokeWidth":N,"dashed":bool,"arrowHead":bool,"label":"string"}]
}
CANVAS: 1200x800, origin top-left, X→right, Y→down. Rotation in DEGREES (0=up,90=right,180=down,270=left). Lane width ~80 units. Center scene around x:300-900, y:100-700.
COLORS: ego="blue"/#2563EB, threat="red"/#EF4444, caution="#F59E0B", neutral="black"/"grey", planned paths="green", emergency="red".
PATHS: Always use the "paths" array for trajectories, planned routes, and lane change curves. Do NOT represent them as lanes or linestrings. Use at least 5-8 points per path to create smooth curves. For lane changes, use a gradual S-curve with intermediate points (not just start and end). Example lane change path: start in source lane center, ease out, cross lane boundary at midpoint, ease in, end in target lane center.`

const SYSTEM_PROMPT_NATURAL = `You are an expert traffic scene generator for drawtonomy (ADAS whiteboard editor). Given a natural language description, generate a JSON scene specification.
${SCENE_SPEC_SCHEMA}
EXAMPLE:
{"lanes":[{"leftPoints":[{"x":50,"y":350},{"x":1150,"y":350}],"rightPoints":[{"x":50,"y":420},{"x":1150,"y":420}],"attributes":{"subtype":"road","speed_limit":"50"}},{"leftPoints":[{"x":50,"y":420},{"x":1150,"y":420}],"rightPoints":[{"x":50,"y":490},{"x":1150,"y":490}],"attributes":{"subtype":"road","speed_limit":"50"}}],"vehicles":[{"x":400,"y":385,"rotation":90,"templateId":"sedan","color":"blue","label":"Ego"}],"pedestrians":[],"annotations":[],"paths":[]}`

const SYSTEM_PROMPT_OPENSCENARIO = `You are an expert at interpreting ASAM OpenSCENARIO files (both XML .xosc and DSL .osc formats) and converting them into visual 2D diagram specifications for drawtonomy.

TASK: Extract all entities, initial positions, lane info, maneuvers/trajectories from the OpenSCENARIO input and produce a JSON scene specification for top-down visualization.

MAPPING RULES:
- LanePosition(roadId, laneId, s, offset) → 2D: s maps to X proportionally (s=0→X~100, s=100→X~700), laneId to Y (lane -1→Y~350, lane -2→Y~430, lane -3→Y~510, spacing ~80 units)
- WorldPosition(x,y) → scale to fit 1200x800 canvas
- SpeedAction → add speed annotation label
- LaneChangeAction → draw a dashed path with arrow from start lane to target lane
- RelativeDistanceCondition → annotate trigger distance
- For DSL: drive() with speed(), lane(), position() modifiers → extract positions, speeds, lane assignments
- Color Ego blue, targets grey/red. Label all entities by name.
- Add annotations for speeds, distances, trigger conditions mentioned in the scenario.
${SCENE_SPEC_SCHEMA}`

const SYSTEM_PROMPT_TEXT_TO_OSC = `You are an expert at writing ASAM OpenSCENARIO DSL (v2.x .osc format) for ADAS testing.
Given a natural language description, generate a valid OpenSCENARIO DSL scenario.
RESPOND WITH ONLY the DSL code (no markdown backticks, no explanation).

RULES:
- Start with "import osc.standard"
- Define scenario with actors (vehicle, pedestrian)
- Use "do parallel:" / "do serial:" for behaviors
- Modifiers: speed(), lane(), position(), lateral(), along()
- Constraints: "with:" + keep(it.category == ...)
- Position: ahead_of, behind, left_of, right_of
- Lane: lane(lane: N), lane(same_as: entity), lane(side_of: entity, side: left|right)
- Units: kph, mph, mps, m, km, s, ms

EXAMPLE:
import osc.standard

scenario cut_in:
    ego: vehicle with:
        keep(it.category == vehicle_category!car)
    target: vehicle with:
        keep(it.category == vehicle_category!car)
    do parallel:
        ego.drive() with:
            speed(speed: 30kph)
            lane(lane: 2, at: start)
        serial:
            target.drive() with:
                speed(speed: 40kph)
                lane(lane: 3, at: start)
                position(distance: 30m, ahead_of: ego, at: start)
            target.drive() with:
                lane(same_as: ego, at: end)
                speed(speed: 40kph)

Use descriptive names and add comments.`

// ─── Main Generate Functions ─────────────────────────────────

export async function generateScene(options: GenerateOptions): Promise<BaseShape[]> {
  const { prompt, apiKey, apiProvider, inputMode, existingShapes, viewport, onLog } = options
  const log = onLog ?? (() => {})
  let contextInfo = existingShapes.length > 0 ? `\n\nExisting shapes: ${summarizeShapes(existingShapes)}` : ''
  const vpInfo = `\nViewport: ${viewport.width}x${viewport.height}, zoom: ${viewport.zoom.toFixed(2)}`

  let sys: string, usr: string
  if (inputMode === 'openscenario') {
    sys = SYSTEM_PROMPT_OPENSCENARIO
    usr = `Convert this OpenSCENARIO to a drawtonomy scene specification:\n\n${prompt}${contextInfo}${vpInfo}`
    log('Mode: OpenSCENARIO → Scene Spec')
  } else {
    sys = SYSTEM_PROMPT_NATURAL
    usr = `${prompt}${contextInfo}${vpInfo}`
    log('Mode: Natural Language → Scene Spec')
  }
  log(`Sending to ${apiProvider} (${options.model})...`)
  const resp = await callLLM(apiKey, apiProvider, options.model, sys, usr, log)
  log(`Got response (${resp.length} chars), parsing...`)
  const spec = parseSceneSpec(resp, log)
  resetIdCounter()
  const shapes = buildShapesFromSpec(spec, log)
  log(`Built ${shapes.length} shapes`)
  return shapes
}

export async function generateOpenScenarioDSL(options: GenerateOptions): Promise<string> {
  const { prompt, apiKey, apiProvider, onLog } = options
  const log = onLog ?? (() => {})
  log('Mode: Natural Language → OpenSCENARIO DSL')
  log(`Sending to ${apiProvider} (${options.model})...`)
  const resp = await callLLM(apiKey, apiProvider, options.model, SYSTEM_PROMPT_TEXT_TO_OSC, prompt, log)
  let cleaned = resp.trim()
  const fm = cleaned.match(/```(?:osc|openscenario|python)?\s*([\s\S]*?)```/)
  if (fm) { cleaned = fm[1].trim(); log('Stripped markdown fences') }
  log(`Generated DSL (${cleaned.length} chars)`)
  return cleaned
}

// ─── Unified LLM Caller ─────────────────────────────────────

async function callLLM(apiKey: string, provider: ApiProvider, model: string, sys: string, usr: string, log: (m: string) => void): Promise<string> {
  if (provider === 'anthropic') return callAnthropic(apiKey, sys, usr, model, log)
  if (provider === 'openai') return callOpenAI(apiKey, sys, usr, model, log)
  return callGemini(apiKey, sys, usr, model, log)
}

function summarizeShapes(shapes: unknown[]): string {
  const t = shapes as Array<{ type: string; x: number; y: number }>
  const c: Record<string, number> = {}; const p: string[] = []
  for (const s of t) { c[s.type] = (c[s.type] || 0) + 1; if (['vehicle', 'pedestrian', 'lane'].includes(s.type)) p.push(`${s.type}@(${Math.round(s.x)},${Math.round(s.y)})`) }
  return `${Object.entries(c).map(([t, n]) => `${n} ${t}`).join(', ')}. ${p.slice(0, 8).join('; ')}`
}

// ─── API Callers ─────────────────────────────────────────────

async function callAnthropic(apiKey: string, sys: string, usr: string, model: string, log: (m: string) => void): Promise<string> {
  log('Calling Anthropic...'); let r: Response
  try { r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }, body: JSON.stringify({ model, max_tokens: 4096, system: sys, messages: [{ role: 'user', content: usr }] }) }) } catch (e) { throw new Error(`Network: ${(e as Error).message}`) }
  const b = await r.text(); log(`${r.status} (${b.length}c)`); if (!r.ok) throw new Error(`Anthropic ${r.status}: ${b.substring(0, 300)}`)
  let d: any; try { d = JSON.parse(b) } catch { throw new Error('Invalid JSON from Anthropic') }; if (d.error) throw new Error(`Anthropic: ${d.error.message || JSON.stringify(d.error)}`); return d.content?.[0]?.text ?? ''
}

async function callOpenAI(apiKey: string, sys: string, usr: string, model: string, log: (m: string) => void): Promise<string> {
  log('Calling OpenAI...'); const tp = model.startsWith('o3') ? { max_completion_tokens: 4096 } : { max_tokens: 4096 }; let r: Response
  try { r = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }, body: JSON.stringify({ model, ...tp, messages: [{ role: 'system', content: sys }, { role: 'user', content: usr }] }) }) } catch (e) { throw new Error(`Network: ${(e as Error).message}`) }
  const b = await r.text(); log(`${r.status} (${b.length}c)`); if (!r.ok) throw new Error(`OpenAI ${r.status}: ${b.substring(0, 300)}`)
  let d: any; try { d = JSON.parse(b) } catch { throw new Error('Invalid JSON from OpenAI') }; if (d.error) throw new Error(`OpenAI: ${d.error.message}`); return d.choices?.[0]?.message?.content ?? ''
}

async function callGemini(apiKey: string, sys: string, usr: string, model: string, log: (m: string) => void): Promise<string> {
  log('Calling Gemini...'); let r: Response
  try { r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ systemInstruction: { parts: [{ text: sys }] }, contents: [{ parts: [{ text: usr }] }], generationConfig: { temperature: 0.3 } }) }) } catch (e) { throw new Error(`Network: ${(e as Error).message}`) }
  const b = await r.text(); log(`${r.status} (${b.length}c)`); if (!r.ok) throw new Error(`Gemini ${r.status}: ${b.substring(0, 300)}`)
  let d: any; try { d = JSON.parse(b) } catch { throw new Error('Invalid JSON from Gemini') }; if (d.error) throw new Error(`Gemini: ${d.error.message}`); return d.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
}

// ─── Parse / Build ───────────────────────────────────────────

interface SceneSpec {
  lanes?: Array<{ leftPoints: Array<{ x: number; y: number }>; rightPoints: Array<{ x: number; y: number }>; attributes?: { subtype?: string; speed_limit?: string } }>
  vehicles?: Array<{ x: number; y: number; rotation?: number; templateId?: string; color?: string; label?: string }>
  pedestrians?: Array<{ x: number; y: number; rotation?: number; templateId?: string; color?: string; label?: string }>
  annotations?: Array<{ x: number; y: number; text: string; color?: string; fontSize?: number }>
  paths?: Array<{ points: Array<{ x: number; y: number }>; color?: string; strokeWidth?: number; dashed?: boolean; arrowHead?: boolean; label?: string }>
}

function parseSceneSpec(text: string, log: (m: string) => void): SceneSpec {
  let j = text.trim()
  const fm = j.match(/```(?:json)?\s*([\s\S]*?)```/); if (fm) { j = fm[1].trim(); log('Stripped fences') }
  if (j.startsWith('[')) { log('Warning: array returned, converting'); try { return convertRaw(JSON.parse(j), log) } catch {} }
  const s = j.indexOf('{'), e = j.lastIndexOf('}'); if (s !== -1 && e > s) j = j.slice(s, e + 1)
  try { const p = JSON.parse(j); log(`Parsed: ${p.lanes?.length??0}L ${p.vehicles?.length??0}V ${p.pedestrians?.length??0}P ${p.annotations?.length??0}A ${p.paths?.length??0}paths`); return p as SceneSpec }
  catch (err) { log(`Parse error: ${(err as Error).message}`); throw new Error(`JSON parse failed: ${(err as Error).message}`) }
}

function convertRaw(shapes: any[], log: (m: string) => void): SceneSpec {
  const spec: SceneSpec = { lanes: [], vehicles: [], pedestrians: [], annotations: [], paths: [] }
  for (const s of shapes) {
    if (s.type === 'vehicle') spec.vehicles!.push({ x: s.x??0, y: s.y??0, rotation: s.rotation??0, templateId: s.props?.templateId??'sedan', color: s.props?.color??'black' })
    else if (s.type === 'pedestrian') spec.pedestrians!.push({ x: s.x??0, y: s.y??0, templateId: s.props?.templateId??'filled', color: s.props?.color??'black' })
    else if (s.type === 'text') spec.annotations!.push({ x: s.x??0, y: s.y??0, text: s.props?.text??'', color: s.props?.color??'black' })
  }
  return spec
}

const VSZ: Record<string, { w: number; h: number }> = { sedan: { w: 30, h: 56 }, bus: { w: 37, h: 92 }, truck: { w: 43, h: 147 }, motorcycle: { w: 18, h: 36 }, bicycle: { w: 18, h: 36 } }

function buildShapesFromSpec(spec: SceneSpec, log: (m: string) => void): BaseShape[] {
  const S: BaseShape[] = []
  // Build lanes with shared boundaries for adjacent lanes
  const lanes = spec.lanes ?? []
  // Cache: coordinate key → { points, linestring } for boundary sharing
  const boundaryCache = new Map<string, { points: ReturnType<typeof createPoint>[]; linestring: ReturnType<typeof createLinestring> }>()
  function boundaryKey(pts: Array<{ x: number; y: number }>): string {
    return pts.map(p => `${p.x},${p.y}`).join('|')
  }
  function getOrCreateBoundary(pts: Array<{ x: number; y: number }>) {
    const key = boundaryKey(pts)
    const cached = boundaryCache.get(key)
    if (cached) return { ...cached, isNew: false }
    const points = pts.map(p => createPoint(p.x, p.y, { visible: true, osmId: 'n0' }))
    const linestring = createLinestring(0, 0, points.map(p => p.id))
    boundaryCache.set(key, { points, linestring })
    return { points, linestring, isNew: true }
  }
  for (const l of lanes) {
    if (!l.leftPoints?.length || l.leftPoints.length < 2 || !l.rightPoints?.length || l.rightPoints.length < 2) { log('Skip invalid lane'); continue }
    try {
      const left = getOrCreateBoundary(l.leftPoints)
      const right = getOrCreateBoundary(l.rightPoints)
      if (left.isNew) { S.push(...left.points, left.linestring) }
      if (right.isNew) { S.push(...right.points, right.linestring) }
      const ln = createLane(0, 0, left.linestring.id, right.linestring.id, { attributes: { type: 'lanelet', subtype: l.attributes?.subtype ?? 'road', speed_limit: l.attributes?.speed_limit ?? '30' } })
      S.push(ln)
    } catch (e) { log(`Lane error: ${(e as Error).message}`) }
  }
  for (const v of spec.vehicles ?? []) {
    const t = v.templateId ?? 'sedan'; const sz = VSZ[t] ?? VSZ.sedan
    const vh = createVehicle(v.x, v.y, { templateId: t, color: v.color ?? 'black', attributes: { type: 'vehicle', subtype: t === 'bus' ? 'bus' : t === 'truck' ? 'truck' : t === 'motorcycle' ? 'motorcycle' : 'car' }, ...sz })
    vh.rotation = v.rotation ?? 0; S.push(vh)
    if (v.label) S.push(createText(v.x - 20, v.y - 40, v.label, { color: v.color ?? 'black', fontSize: 14 }))
  }
  for (const p of spec.pedestrians ?? []) {
    const pd = createPedestrian(p.x, p.y, { templateId: p.templateId ?? 'filled', color: p.color ?? 'black' }); pd.rotation = p.rotation ?? 0; S.push(pd)
    if (p.label) S.push(createText(p.x - 20, p.y - 30, p.label, { color: p.color ?? 'black', fontSize: 12 }))
  }
  for (const a of spec.annotations ?? []) S.push(createText(a.x, a.y, a.text, { color: a.color ?? 'black', fontSize: a.fontSize ?? 16 }))
  for (const pt of spec.paths ?? []) {
    if (!pt.points || pt.points.length < 2) continue
    const ps = pt.points.map(p => createPoint(p.x, p.y, { visible: true, osmId: 'n0' })); S.push(...ps)
    const ls = createLinestring(0, 0, ps.map(p => p.id), { color: pt.color ?? 'green', strokeWidth: pt.strokeWidth ?? 3, attributes: { type: 'linestring', subtype: pt.dashed ? 'dashed' : 'solid' } })
    if (pt.arrowHead !== false) { (ls.props as any).isPath = true; (ls.props as any).arrowHead = 'end'; (ls.props as any).arrowHeadSize = 15 }
    ;(ls.props as any).opacity = 0.85; S.push(ls)
    if (pt.label) { const m = Math.floor(pt.points.length / 2); S.push(createText(pt.points[m].x, pt.points[m].y - 15, pt.label, { color: pt.color ?? 'green', fontSize: 12 })) }
  }
  return S
}
