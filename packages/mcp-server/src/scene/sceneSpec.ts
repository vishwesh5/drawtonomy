// SceneSpec type definitions and JSON schema description for MCP tool
// Ported from ai-scene-generator extension

export interface SceneSpec {
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

// JSON schema description embedded in MCP tool description
// so that LLMs know how to generate valid SceneSpec JSON
export const SCENE_SPEC_DESCRIPTION = `Render a drawtonomy traffic scene diagram as SVG or PNG image.

Provide a JSON scene specification with the following structure:
{
  "lanes": [{"leftPoints": [{"x":N,"y":N},...], "rightPoints": [{"x":N,"y":N},...], "attributes": {"subtype":"road"|"sidewalk","speed_limit":"30"|"50"|"80"}}],
  "vehicles": [{"x":N,"y":N,"rotation":N,"templateId":"sedan"|"bus"|"truck"|"motorcycle"|"bicycle","color":"string","label":"string"}],
  "pedestrians": [{"x":N,"y":N,"rotation":N,"templateId":"filled","color":"string","label":"string"}],
  "annotations": [{"x":N,"y":N,"text":"string","color":"string","fontSize":N}],
  "paths": [{"points":[{"x":N,"y":N},...],"color":"string","strokeWidth":N,"dashed":true/false,"arrowHead":true/false,"label":"string"}]
}

CANVAS: 1200x800, origin top-left, X→right, Y→down.
ROTATION: degrees (0=up, 90=right, 180=down, 270=left).
LANE WIDTH: ~80 units between left and right boundary points.
CENTER SCENE: x:300-900, y:100-700.
LANES: Each lane entry = one driving lane. The number of lane entries MUST match the number of lanes the user requested. Do NOT add extra lanes (e.g. sidewalks) unless explicitly requested. Adjacent lanes share boundary points.
LABELS: Do NOT add labels or annotations unless the user explicitly requests them. Vehicle/pedestrian "label" fields and "annotations" should be omitted by default. Only add text when the user asks for specific labels or annotations.
COLORS: ego="blue" or "#2563EB", threat="red" or "#EF4444", caution="#F59E0B", neutral="black"/"grey", planned paths="green".
VEHICLE TEMPLATES: sedan (default, 30x56), bus (37x92), truck (43x147), motorcycle (18x36), bicycle (18x36).
PEDESTRIAN TEMPLATES: filled (default, 22x22).`

export const EDITOR_BASE_URL = 'https://drawtonomy.vercel.app'
