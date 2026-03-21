// open_in_editor MCP tool handler

import { buildShapesFromSpec } from '../scene/sceneBuilder.js'
import { EDITOR_BASE_URL } from '../scene/sceneSpec.js'
import type { SceneSpec } from '../scene/sceneSpec.js'

export function handleOpenInEditor(args: { scene: SceneSpec }) {
  const shapes = buildShapesFromSpec(args.scene)

  const snapshot = {
    version: '1.1',
    timestamp: new Date().toISOString(),
    shapes,
  }

  const json = JSON.stringify(snapshot)
  const encoded = Buffer.from(json).toString('base64')
  const url = `${EDITOR_BASE_URL}/?snapshot=${encoded}`

  return {
    content: [{
      type: 'text' as const,
      text: `Open in drawtonomy editor:\n${url}`,
    }],
  }
}
