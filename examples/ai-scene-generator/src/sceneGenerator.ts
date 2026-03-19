// Scene Generator - AI API integration for generating traffic scenes
// Improvements: enriched system prompt, Gemini support, SDK-helper post-processing,
// robust error handling, ADAS-specific guidance

import {
  createPoint,
  createLinestring,
  createLane,
  createLaneWithBoundaries,
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
export type AnthropicModelId = (typeof ANTHROPIC_MODELS)[number]['id']
export type OpenAIModelId = (typeof OPENAI_MODELS)[number]['id']
export type GeminiModelId = (typeof GEMINI_MODELS)[number]['id']

// ─── Example prompts for ADAS scenarios ──────────────────────

export const EXAMPLE_PROMPTS = [
  {
    label: 'Highway Lane Change',
    prompt:
      'A 3-lane highway going left-to-right. An ego sedan (blue) in the center lane, a truck (grey) in the right lane slightly ahead. Show a dashed path for the ego vehicle changing to the left lane.',
  },
  {
    label: 'AEB Scenario',
    prompt:
      'A city road with 2 lanes going top-to-bottom. An ego sedan (blue) driving downward. A child pedestrian crossing from the right side. Place a red text annotation saying "Danger Zone" near the pedestrian.',
  },
  {
    label: 'T-Intersection',
    prompt:
      'A T-intersection: a horizontal 2-lane road and a vertical road joining from below. Place a red sedan approaching from the left, an ego blue sedan coming from the bottom road, and a pedestrian crossing at the junction.',
  },
  {
    label: 'Blind Spot Monitor',
    prompt:
      'A 3-lane highway going left-to-right. Ego sedan (blue) in the center lane. A motorcycle in the left lane positioned in the ego vehicle blind spot area. Another sedan ahead in the center lane. Add a text annotation "BSM Alert" near the motorcycle.',
  },
] as const

// ─── Generate Options ────────────────────────────────────────

interface GenerateOptions {
  prompt: string
  apiKey: string
  apiProvider: ApiProvider
  model: string
  existingShapes: unknown[]
  viewport: { x: number; y: number; zoom: number; width: number; height: number }
  onLog?: (msg: string) => void
}

// ─── System Prompt ───────────────────────────────────────────
// Two-stage approach: LLM returns a high-level scene spec,
// then we use SDK helpers to construct proper drawtonomy shapes.

const SYSTEM_PROMPT = `You are an expert traffic scene generator for drawtonomy, a whiteboard editor for driving scenario diagrams used in ADAS (Advanced Driver Assistance Systems) development.

TASK: Given a natural language description, generate a JSON scene specification. This specification will be processed by client-side code that creates the actual shapes using the drawtonomy SDK.

COORDINATE SYSTEM:
- Default canvas is ~1200 x 800 units
- Origin (0, 0) is top-left
- X increases rightward, Y increases downward
- Rotation is in DEGREES (0 = default/upward for vehicles, use rotation to orient)
- For horizontal roads: lanes run left-to-right with Y varying per lane
- For vertical roads: lanes run top-to-bottom with X varying per lane
- Typical lane width: 70–100 units
- Typical vehicle size: w=90, h=45

RESPOND WITH ONLY A VALID JSON OBJECT (no markdown, no backticks, no explanation) matching this schema:

{
  "lanes": [
    {
      "leftPoints": [{"x": number, "y": number}, ...],
      "rightPoints": [{"x": number, "y": number}, ...],
      "attributes": { "subtype": "road"|"sidewalk"|"crosswalk", "speed_limit": "30"|"50"|"80" }
    }
  ],
  "vehicles": [
    {
      "x": number, "y": number,
      "rotation": number,
      "templateId": "sedan"|"bus"|"truck"|"motorcycle"|"bicycle",
      "color": "string",
      "label": "string (optional, e.g. Ego, Target)"
    }
  ],
  "pedestrians": [
    {
      "x": number, "y": number,
      "rotation": number,
      "templateId": "filled"|"walking"|"simple",
      "color": "string",
      "label": "string (optional)"
    }
  ],
  "annotations": [
    {
      "x": number, "y": number,
      "text": "string",
      "color": "string",
      "fontSize": number
    }
  ],
  "paths": [
    {
      "points": [{"x": number, "y": number}, ...],
      "color": "string",
      "strokeWidth": number,
      "dashed": true|false,
      "arrowHead": true|false,
      "label": "string (optional)"
    }
  ]
}

COLOR CONVENTIONS FOR ADAS:
- Ego vehicle: "blue" or "#2563EB"
- Threat/danger: "red" or "#EF4444"
- Caution/alert: "#F59E0B" (amber)
- Neutral vehicles: "black" or "grey"
- Pedestrians: "black" or "#F59E0B"
- Paths/trajectories: "green" for planned, "red" for emergency

DESIGN GUIDELINES:
- Center the scene in the viewport (roughly around x:300-900, y:100-700)
- For lanes, provide leftPoints and rightPoints as arrays of {x,y} coordinates that define the lane boundaries
- Place vehicles ON the lane centerlines (between left and right boundary)
- Lanes need at least 2 points per boundary (start and end)
- Use rotation to orient vehicles: 0 = upward, 90 = rightward, 180 = downward, 270 = leftward
- Keep annotations near relevant objects but not overlapping
- For paths/trajectories, provide an array of {x,y} points along the desired route

EXAMPLE — A horizontal 2-lane road with an ego sedan:
{
  "lanes": [
    {
      "leftPoints": [{"x": 50, "y": 350}, {"x": 1150, "y": 350}],
      "rightPoints": [{"x": 50, "y": 420}, {"x": 1150, "y": 420}],
      "attributes": {"subtype": "road", "speed_limit": "50"}
    },
    {
      "leftPoints": [{"x": 50, "y": 420}, {"x": 1150, "y": 420}],
      "rightPoints": [{"x": 50, "y": 490}, {"x": 1150, "y": 490}],
      "attributes": {"subtype": "road", "speed_limit": "50"}
    }
  ],
  "vehicles": [
    {"x": 400, "y": 385, "rotation": 90, "templateId": "sedan", "color": "blue", "label": "Ego"}
  ],
  "pedestrians": [],
  "annotations": [],
  "paths": []
}`

// ─── Main Generate Function ──────────────────────────────────

export async function generateScene(options: GenerateOptions): Promise<BaseShape[]> {
  const { prompt, apiKey, apiProvider, existingShapes, viewport, onLog } = options
  const log = onLog ?? (() => {})

  // Build context about existing shapes
  let contextInfo = ''
  if (existingShapes.length > 0) {
    const summary = summarizeShapes(existingShapes)
    contextInfo = `\n\nExisting shapes on canvas for reference (place new shapes relative to these):\n${summary}`
  }

  const userMessage = `${prompt}${contextInfo}\n\nViewport: ${viewport.width}x${viewport.height}, zoom: ${viewport.zoom.toFixed(2)}`
  log(`Sending prompt to ${apiProvider} (${options.model})...`)

  let responseText: string

  if (apiProvider === 'anthropic') {
    responseText = await callAnthropic(apiKey, userMessage, options.model, log)
  } else if (apiProvider === 'openai') {
    responseText = await callOpenAI(apiKey, userMessage, options.model, log)
  } else {
    responseText = await callGemini(apiKey, userMessage, options.model, log)
  }

  log(`Got response (${responseText.length} chars), parsing...`)

  // Parse high-level scene spec
  const sceneSpec = parseSceneSpec(responseText, log)

  // Convert to drawtonomy shapes using SDK helpers
  resetIdCounter()
  const shapes = buildShapesFromSpec(sceneSpec, log)

  log(`Built ${shapes.length} drawtonomy shapes`)
  return shapes
}

// ─── Summarize existing shapes for context ───────────────────

function summarizeShapes(shapes: unknown[]): string {
  const typed = shapes as Array<{ type: string; x: number; y: number; props?: Record<string, unknown> }>
  const counts: Record<string, number> = {}
  const positions: string[] = []

  for (const s of typed) {
    counts[s.type] = (counts[s.type] || 0) + 1
    if (['vehicle', 'pedestrian', 'lane'].includes(s.type)) {
      positions.push(`${s.type} at (${Math.round(s.x)}, ${Math.round(s.y)})`)
    }
  }

  const countStr = Object.entries(counts)
    .map(([type, n]) => `${n} ${type}(s)`)
    .join(', ')

  return `${countStr}. Key positions: ${positions.slice(0, 10).join('; ')}`
}

// ─── API Callers (robust: text-first parsing) ────────────────

async function callAnthropic(
  apiKey: string,
  userMessage: string,
  model: string,
  log: (msg: string) => void
): Promise<string> {
  log('Calling Anthropic API...')

  let response: Response
  try {
    response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMessage }],
      }),
    })
  } catch (fetchErr) {
    throw new Error(`Network error calling Anthropic: ${(fetchErr as Error).message}`)
  }

  const bodyText = await response.text()
  log(`Response: ${response.status} (${bodyText.length} chars)`)

  if (!response.ok) {
    throw new Error(`Anthropic API error ${response.status}: ${bodyText.substring(0, 300)}`)
  }

  let data: any
  try {
    data = JSON.parse(bodyText)
  } catch {
    throw new Error(`Anthropic returned invalid JSON: ${bodyText.substring(0, 200)}`)
  }

  if (data.error) {
    throw new Error(`Anthropic error: ${data.error.message || JSON.stringify(data.error)}`)
  }

  return data.content?.[0]?.text ?? ''
}

async function callOpenAI(
  apiKey: string,
  userMessage: string,
  model: string,
  log: (msg: string) => void
): Promise<string> {
  log('Calling OpenAI API...')

  const isO3 = model.startsWith('o3')
  const tokenParam = isO3 ? { max_completion_tokens: 4096 } : { max_tokens: 4096 }

  let response: Response
  try {
    response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        ...tokenParam,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userMessage },
        ],
      }),
    })
  } catch (fetchErr) {
    throw new Error(`Network error calling OpenAI: ${(fetchErr as Error).message}`)
  }

  const bodyText = await response.text()
  log(`Response: ${response.status} (${bodyText.length} chars)`)

  if (!response.ok) {
    throw new Error(`OpenAI API error ${response.status}: ${bodyText.substring(0, 300)}`)
  }

  let data: any
  try {
    data = JSON.parse(bodyText)
  } catch {
    throw new Error(`OpenAI returned invalid JSON: ${bodyText.substring(0, 200)}`)
  }

  if (data.error) {
    throw new Error(`OpenAI error: ${data.error.message}`)
  }

  return data.choices?.[0]?.message?.content ?? ''
}

async function callGemini(
  apiKey: string,
  userMessage: string,
  model: string,
  log: (msg: string) => void
): Promise<string> {
  log('Calling Gemini API...')

  let response: Response
  try {
    response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [{ parts: [{ text: userMessage }] }],
          generationConfig: { temperature: 0.3 },
        }),
      }
    )
  } catch (fetchErr) {
    throw new Error(`Network error calling Gemini: ${(fetchErr as Error).message}`)
  }

  const bodyText = await response.text()
  log(`Response: ${response.status} (${bodyText.length} chars)`)

  if (!response.ok) {
    throw new Error(`Gemini API error ${response.status}: ${bodyText.substring(0, 300)}`)
  }

  let data: any
  try {
    data = JSON.parse(bodyText)
  } catch {
    throw new Error(`Gemini returned invalid JSON: ${bodyText.substring(0, 200)}`)
  }

  if (data.error) {
    throw new Error(`Gemini error: ${data.error.message}`)
  }

  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
}

// ─── Parse Scene Specification ───────────────────────────────

interface SceneSpec {
  lanes?: Array<{
    leftPoints: Array<{ x: number; y: number }>
    rightPoints: Array<{ x: number; y: number }>
    attributes?: { subtype?: string; speed_limit?: string }
  }>
  vehicles?: Array<{
    x: number
    y: number
    rotation?: number
    templateId?: string
    color?: string
    label?: string
  }>
  pedestrians?: Array<{
    x: number
    y: number
    rotation?: number
    templateId?: string
    color?: string
    label?: string
  }>
  annotations?: Array<{
    x: number
    y: number
    text: string
    color?: string
    fontSize?: number
  }>
  paths?: Array<{
    points: Array<{ x: number; y: number }>
    color?: string
    strokeWidth?: number
    dashed?: boolean
    arrowHead?: boolean
    label?: string
  }>
}

function parseSceneSpec(text: string, log: (msg: string) => void): SceneSpec {
  let jsonStr = text.trim()

  // Strip markdown code fences
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim()
    log('Stripped markdown code fences')
  }

  // If it starts with '[', the LLM returned raw shapes array (old format) — wrap it
  if (jsonStr.startsWith('[')) {
    log('Warning: LLM returned array instead of scene spec, attempting direct shape parse')
    // Fall back to old-style direct shape parsing
    const shapes = JSON.parse(jsonStr)
    if (Array.isArray(shapes)) {
      return convertRawShapesToSpec(shapes, log)
    }
  }

  // Find JSON object
  const objStart = jsonStr.indexOf('{')
  const objEnd = jsonStr.lastIndexOf('}')
  if (objStart !== -1 && objEnd > objStart) {
    jsonStr = jsonStr.slice(objStart, objEnd + 1)
  }

  try {
    const parsed = JSON.parse(jsonStr)
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('Response is not a JSON object')
    }
    log(
      `Parsed scene: ${parsed.lanes?.length ?? 0} lanes, ${parsed.vehicles?.length ?? 0} vehicles, ` +
        `${parsed.pedestrians?.length ?? 0} peds, ${parsed.annotations?.length ?? 0} annotations, ` +
        `${parsed.paths?.length ?? 0} paths`
    )
    return parsed as SceneSpec
  } catch (e) {
    log(`Parse error: ${(e as Error).message}`)
    log(`Near: ${jsonStr.substring(0, 200)}...`)
    throw new Error(`Failed to parse scene JSON: ${(e as Error).message}`)
  }
}

// Fallback: if LLM returns raw drawtonomy shapes, extract what we can
function convertRawShapesToSpec(shapes: any[], log: (msg: string) => void): SceneSpec {
  log(`Converting ${shapes.length} raw shapes to scene spec`)
  const spec: SceneSpec = { lanes: [], vehicles: [], pedestrians: [], annotations: [], paths: [] }

  for (const s of shapes) {
    if (s.type === 'vehicle') {
      spec.vehicles!.push({
        x: s.x ?? 0,
        y: s.y ?? 0,
        rotation: s.rotation ?? 0,
        templateId: s.props?.templateId ?? 'sedan',
        color: s.props?.color ?? 'black',
      })
    } else if (s.type === 'pedestrian') {
      spec.pedestrians!.push({
        x: s.x ?? 0,
        y: s.y ?? 0,
        templateId: s.props?.templateId ?? 'filled',
        color: s.props?.color ?? 'black',
      })
    } else if (s.type === 'text') {
      spec.annotations!.push({
        x: s.x ?? 0,
        y: s.y ?? 0,
        text: s.props?.text ?? '',
        color: s.props?.color ?? 'black',
        fontSize: s.props?.fontSize ?? 16,
      })
    }
  }
  return spec
}

// ─── Build Shapes from Scene Spec ────────────────────────────
// Uses SDK helper functions to construct valid drawtonomy shapes

function buildShapesFromSpec(spec: SceneSpec, log: (msg: string) => void): BaseShape[] {
  const shapes: BaseShape[] = []

  // 1. Build lanes using createLaneWithBoundaries
  if (spec.lanes) {
    for (const lane of spec.lanes) {
      if (!lane.leftPoints || !lane.rightPoints) {
        log('Warning: lane missing leftPoints or rightPoints, skipping')
        continue
      }
      if (lane.leftPoints.length < 2 || lane.rightPoints.length < 2) {
        log('Warning: lane boundary needs at least 2 points, skipping')
        continue
      }

      try {
        const laneShapes = createLaneWithBoundaries(lane.leftPoints, lane.rightPoints, {
          laneOptions: {
            attributes: {
              type: 'lanelet',
              subtype: lane.attributes?.subtype ?? 'road',
              speed_limit: lane.attributes?.speed_limit ?? '30',
            },
          },
        })
        shapes.push(...laneShapes)
      } catch (e) {
        log(`Warning: failed to create lane: ${(e as Error).message}`)
      }
    }
  }

  // 2. Build vehicles
  if (spec.vehicles) {
    for (const v of spec.vehicles) {
      const veh = createVehicle(v.x, v.y, {
        templateId: v.templateId ?? 'sedan',
        color: v.color ?? 'black',
        attributes: { type: 'vehicle', subtype: mapTemplateToSubtype(v.templateId) },
      })
      veh.rotation = v.rotation ?? 0
      shapes.push(veh)

      // Add label as a text shape nearby
      if (v.label) {
        shapes.push(
          createText(v.x - 20, v.y - 40, v.label, {
            color: v.color ?? 'black',
            fontSize: 14,
          })
        )
      }
    }
  }

  // 3. Build pedestrians
  if (spec.pedestrians) {
    for (const p of spec.pedestrians) {
      const ped = createPedestrian(p.x, p.y, {
        templateId: p.templateId ?? 'filled',
        color: p.color ?? 'black',
      })
      ped.rotation = p.rotation ?? 0
      shapes.push(ped)

      if (p.label) {
        shapes.push(
          createText(p.x - 20, p.y - 30, p.label, {
            color: p.color ?? 'black',
            fontSize: 12,
          })
        )
      }
    }
  }

  // 4. Build annotations
  if (spec.annotations) {
    for (const a of spec.annotations) {
      shapes.push(
        createText(a.x, a.y, a.text, {
          color: a.color ?? 'black',
          fontSize: a.fontSize ?? 16,
        })
      )
    }
  }

  // 5. Build paths as linestrings with arrow heads
  if (spec.paths) {
    for (const path of spec.paths) {
      if (!path.points || path.points.length < 2) continue

      // Create points
      const pointShapes = path.points.map(p => createPoint(p.x, p.y, { visible: false }))
      shapes.push(...pointShapes)

      // Create linestring connecting them
      const ls = createLinestring(0, 0, pointShapes.map(p => p.id), {
        color: path.color ?? 'green',
        strokeWidth: path.strokeWidth ?? 3,
        attributes: {
          type: 'linestring',
          subtype: path.dashed ? 'dashed' : 'solid',
        },
      })

      // Add path-specific properties
      if (path.arrowHead !== false) {
        ;(ls.props as any).isPath = true
        ;(ls.props as any).arrowHead = 'end'
        ;(ls.props as any).arrowHeadSize = 15
      }
      if (path.dashed) {
        ;(ls.props as any).attributes = { type: 'linestring', subtype: 'dashed' }
      }
      ;(ls.props as any).opacity = 0.85

      shapes.push(ls)

      // Path label
      if (path.label && path.points.length >= 2) {
        const mid = Math.floor(path.points.length / 2)
        shapes.push(
          createText(path.points[mid].x, path.points[mid].y - 15, path.label, {
            color: path.color ?? 'green',
            fontSize: 12,
          })
        )
      }
    }
  }

  return shapes
}

function mapTemplateToSubtype(templateId?: string): string {
  const map: Record<string, string> = {
    sedan: 'car',
    bus: 'bus',
    truck: 'truck',
    motorcycle: 'motorcycle',
    bicycle: 'bicycle',
    default: 'car',
  }
  return map[templateId ?? 'default'] ?? 'car'
}
