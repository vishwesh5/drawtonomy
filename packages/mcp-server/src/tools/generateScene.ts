// generate_scene MCP tool handler

import { buildShapesFromSpec } from '../scene/sceneBuilder.js'
import type { SceneSpec } from '../scene/sceneSpec.js'
import { renderShapesToSvg } from '../renderer/svgRenderer.js'
import { svgToPng } from '../renderer/pngRenderer.js'

export function handleGenerateScene(args: { scene: SceneSpec; outputFormat?: 'svg' | 'png' }) {
  const { scene, outputFormat = 'png' } = args
  const shapes = buildShapesFromSpec(scene)
  const svg = renderShapesToSvg(shapes)

  if (outputFormat === 'svg') {
    return {
      content: [{ type: 'text' as const, text: svg }],
    }
  }

  const pngBuffer = svgToPng(svg)
  return {
    content: [{
      type: 'image' as const,
      data: pngBuffer.toString('base64'),
      mimeType: 'image/png',
    }],
  }
}
