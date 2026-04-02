# @drawtonomy/mcp-server

MCP (Model Context Protocol) server for rendering drawtonomy traffic scene diagrams. Allows LLMs like Claude to generate traffic scene images directly in chat.

## What it does

- **Generate traffic scene images** from structured JSON scene specifications
- **Open scenes in the web editor** via URL generation

Works with any MCP-compatible client: Claude Desktop, Claude Code, Cursor, VS Code, etc.

## Available Tools

### `generate_scene`

Renders a traffic scene from a JSON specification. LLMs automatically generate the JSON from natural language — users just describe the scene in plain text.

**Input**: Scene specification JSON with lanes, vehicles, pedestrians, annotations, and paths
**Output**: SVG or PNG image

**Supported elements**:

| Element | Description |
|---------|-------------|
| Lane | Road lanes with left/right boundary lines. Subtypes: `road`, `sidewalk` |
| Vehicle | Cars, buses, trucks, etc. with SVG templates |
| Pedestrian | Pedestrian figures with SVG templates |
| Path | Polylines with optional dash pattern and arrow head |
| Annotation | Text labels with configurable color and font size |

**Vehicle templates**:

| Template | Size (w×h) |
|----------|-----------|
| sedan | 30×56 |
| bus | 37×92 |
| truck | 43×147 |
| motorcycle | 18×36 |
| bicycle | 18×36 |

**Pedestrian templates**:

| Template | Size (w×h) |
|----------|-----------|
| filled | 22×22 |

Unsupported vehicle templateIds fall back to sedan. Unsupported pedestrian templateIds fall back to filled.

**Color conventions**: ego = blue (#2563EB), threat = red (#EF4444), caution = #F59E0B, neutral = black/grey, planned paths = green

### `open_in_editor`

Generates a URL to open a scene in the [drawtonomy web editor](https://www.drawtonomy.com) for manual editing.

## Setup

### Install

```bash
pnpm add @drawtonomy/mcp-server
```

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "drawtonomy": {
      "command": "npx",
      "args": ["@drawtonomy/mcp-server"]
    }
  }
}
```

Restart Claude Desktop after editing.

### Claude Code

```bash
claude mcp add drawtonomy npx @drawtonomy/mcp-server
```

### Local development

```bash
git clone https://github.com/kosuke55/drawtonomy.git
cd drawtonomy/packages/mcp-server
pnpm install
pnpm build
```

Then configure with the local path:

```json
{
  "mcpServers": {
    "drawtonomy": {
      "command": "node",
      "args": ["/path/to/drawtonomy/packages/mcp-server/dist/index.js"]
    }
  }
}
```

## Usage Examples

Once configured, just talk naturally to Claude:

- "Draw a 2-lane highway with a blue sedan and a pedestrian crossing"
- "Create an AEB scenario with an ego vehicle and a child pedestrian"
- "Show a T-intersection with 3 vehicles"
- "Open this scene in the drawtonomy editor"

Claude will automatically call the `generate_scene` tool and display the rendered image in chat.

## Testing with MCP Inspector

For direct tool testing without an LLM:

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

Select `generate_scene`, input a scene JSON manually, and run.

## Scene JSON Format

```json
{
  "lanes": [
    {
      "leftPoints": [{"x": 50, "y": 350}, {"x": 1150, "y": 350}],
      "rightPoints": [{"x": 50, "y": 430}, {"x": 1150, "y": 430}],
      "attributes": {"subtype": "road", "speed_limit": "50"}
    }
  ],
  "vehicles": [
    {"x": 400, "y": 390, "rotation": 90, "templateId": "sedan", "color": "blue"}
  ],
  "pedestrians": [
    {"x": 900, "y": 350, "templateId": "filled", "color": "red"}
  ],
  "annotations": [
    {"x": 850, "y": 320, "text": "Danger Zone", "color": "red", "fontSize": 14}
  ],
  "paths": [
    {"points": [{"x": 400, "y": 390}, {"x": 600, "y": 350}], "color": "green", "dashed": true, "arrowHead": true}
  ]
}
```

**Canvas**: 1200x800, origin top-left, X→right, Y→down
**Rotation**: degrees (0=up, 90=right, 180=down, 270=left)
