# AI Scene Generator

A drawtonomy extension that generates traffic scenes from natural language descriptions using AI (Anthropic Claude / OpenAI GPT).

[日本語版はこちら](README.ja.md)

---

## User Guide

### Setup

```bash
# Terminal 1: Start drawtonomy dev server
npm install -g @drawtonomy/dev-server
drawtonomy-dev-server

# Terminal 2: Start the sample extension
cd extensions/ai-scene-generator
npm install
npm run dev
```

Open in browser:
```
http://localhost:3000/?ext=http://localhost:3001/manifest.json
```

### Usage

1. **Select Provider** — Choose Claude (Anthropic) or GPT (OpenAI)
2. **Select Model** — Choose which model to use
   - Claude: Opus 4 (most capable) / Sonnet 4 (balanced) / Haiku 4 (fast & low cost)
   - GPT: o3-mini (most capable) / GPT-4o (balanced) / GPT-4o mini (fast & low cost)
3. **Enter API Key** — Enter the API key for the selected provider
4. **Scene Description** — Describe the scene you want to generate
5. **Generate Scene** — Click to generate. Shapes will be drawn on the canvas

### Prompt Examples

```
A two-lane road with two cars and a pedestrian crossing
```
```
An intersection with four lanes, traffic lights, and a bus turning right
```
```
A parking lot with 5 cars and a pedestrian walking
```

### Notes

- API keys are saved in browser localStorage (not available in sandboxed iframes)
- If shapes already exist on the canvas, they are passed to the AI as context
- Generated shapes can be undone with Ctrl+Z / Cmd+Z

---

## Developer Guide

### Architecture

```
┌─────────────────────────────────────────────────────┐
│ drawtonomy Host (drawtonomy.com)                    │
│                                                     │
│   ExtensionManager                                  │
│     ↕ postMessage                                   │
│   ┌───────────────────────────────────────────────┐ │
│   │ <iframe sandbox="allow-scripts">              │ │
│   │                                               │ │
│   │   AI Scene Generator Extension                │ │
│   │                                               │ │
│   │   ┌──────────────┐   ┌───────────────────┐   │ │
│   │   │ SceneGenerator│   │ ExtensionClient   │   │ │
│   │   │ UI (React)   │   │ (@drawtonomy/sdk) │   │ │
│   │   └──────┬───────┘   └────────┬──────────┘   │ │
│   │          │                     │              │ │
│   │          ▼                     │              │ │
│   │   ┌──────────────┐            │              │ │
│   │   │ sceneGenerator│            │              │ │
│   │   │  AI API Call  │            │              │ │
│   │   │  (fetch)      │            │              │ │
│   │   └──────┬───────┘            │              │ │
│   │          │ shapes[]            │              │ │
│   │          └─────────→ addShapes()              │ │
│   └───────────────────────────────────────────────┘ │
│                                                     │
│   → Render on canvas                                │
└─────────────────────────────────────────────────────┘
         │
         ▼
┌──────────────────┐
│ AI API            │
│ (Anthropic/OpenAI)│
└──────────────────┘
```

### Processing Flow

1. **Initialization**: `ExtensionClient` sends `ext:ready` → receives `ext:init` from host
2. **Context Collection**: `requestShapes()` fetches existing shapes, `requestViewport()` fetches viewport info
3. **AI Call**: Scene description + context + system prompt with shape specifications sent to AI API
4. **Response Parsing**: Parse the JSON array returned by AI into BaseShape[]
5. **Canvas Rendering**: `addShapes()` sends to host → rendered on canvas

### File Structure

| File | Role |
|------|------|
| `manifest.json` | Extension definition (ID, capabilities, etc.) |
| `package.json` | Dependencies (`@drawtonomy/sdk`, React, Vite) |
| `vite.config.ts` | Vite config (`server.cors: true` for sandboxed iframe) |
| `src/main.tsx` | React entry point |
| `src/SceneGeneratorUI.tsx` | UI component (Provider/Model/Key/Prompt/Generate) |
| `src/sceneGenerator.ts` | AI API calls, response parsing, system prompt |
| `src/ExtensionClient.ts` | Re-export from `@drawtonomy/sdk` |
| `src/types.ts` | Type re-exports from `@drawtonomy/sdk` |

### Interface with drawtonomy

#### Capabilities Used

| Capability | Purpose |
|-----------|---------|
| `shapes:write` | Add generated shapes to canvas |
| `shapes:read` | Read existing shapes as context for AI |
| `viewport:read` | Get viewport size for AI (placement reference) |
| `ui:panel` | Display UI in side panel |
| `ui:notify` | Toast notifications for completion/errors |

### Building a New Extension

Minimal steps to create a new extension based on this sample:

1. Create `manifest.json` and declare required capabilities
2. `npm install @drawtonomy/sdk`
3. Initialize `ExtensionClient` and wait for connection with `waitForInit()`
4. Communicate with drawtonomy using SDK APIs (`addShapes()`, `requestShapes()`, etc.)
5. Add `server: { cors: true }` to `vite.config.ts` (for sandboxed iframe)

```typescript
import { ExtensionClient, createVehicle } from '@drawtonomy/sdk'

const client = new ExtensionClient('my-extension')
await client.waitForInit()

// Add shapes
client.addShapes([createVehicle(200, 200, { templateId: 'sedan' })])

// Read existing shapes
const shapes = await client.requestShapes()

// Send notification
client.notify('Done!', 'success')
```
