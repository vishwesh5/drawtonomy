#!/usr/bin/env node

// drawtonomy MCP Server
// Renders traffic scene diagrams as SVG/PNG images via Model Context Protocol

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { SCENE_SPEC_DESCRIPTION } from './scene/sceneSpec.js'
import { handleGenerateScene } from './tools/generateScene.js'
import { handleOpenInEditor } from './tools/openInEditor.js'

const server = new McpServer({
  name: 'drawtonomy',
  version: '0.1.0',
})

// Shared sub-schemas
const pointSchema = z.object({ x: z.number(), y: z.number() })

const sceneSchema = z.object({
  lanes: z.array(z.object({
    leftPoints: z.array(pointSchema),
    rightPoints: z.array(pointSchema),
    attributes: z.object({
      subtype: z.string().optional(),
      speed_limit: z.string().optional(),
    }).optional(),
  })).optional(),
  vehicles: z.array(z.object({
    x: z.number(),
    y: z.number(),
    rotation: z.number().optional(),
    templateId: z.enum(['sedan', 'bus', 'truck', 'motorcycle', 'bicycle']).optional(),
    color: z.string().optional(),
    label: z.string().optional(),
  })).optional(),
  pedestrians: z.array(z.object({
    x: z.number(),
    y: z.number(),
    rotation: z.number().optional(),
    templateId: z.enum(['filled']).optional(),
    color: z.string().optional(),
    label: z.string().optional(),
  })).optional(),
  annotations: z.array(z.object({
    x: z.number(),
    y: z.number(),
    text: z.string(),
    color: z.string().optional(),
    fontSize: z.number().optional(),
  })).optional(),
  paths: z.array(z.object({
    points: z.array(pointSchema),
    color: z.string().optional(),
    strokeWidth: z.number().optional(),
    dashed: z.boolean().optional(),
    arrowHead: z.boolean().optional(),
    label: z.string().optional(),
  })).optional(),
}).describe('Scene specification JSON')

const outputFormatSchema = z.enum(['svg', 'png']).optional().describe('Output format (default: png)')

// Tool 1: generate_scene
server.tool(
  'generate_scene',
  SCENE_SPEC_DESCRIPTION,
  { scene: sceneSchema, outputFormat: outputFormatSchema },
  async (args) => {
    try {
      return handleGenerateScene(args)
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${(error as Error).message}` }],
        isError: true,
      }
    }
  },
)

// Tool 2: open_in_editor
server.tool(
  'open_in_editor',
  'Generate a URL to open a traffic scene in the drawtonomy web editor for manual editing.',
  {
    scene: sceneSchema,
  },
  async (args) => {
    try {
      return handleOpenInEditor(args)
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${(error as Error).message}` }],
        isError: true,
      }
    }
  },
)

// Start server
async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((error) => {
  console.error('Fatal error:', error)
  process.exit(1)
})
