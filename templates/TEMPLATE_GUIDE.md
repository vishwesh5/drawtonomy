# Template Guide

How to add a new template to drawtonomy.

## Overview

Templates are SVG files that define the visual appearance of vehicles and pedestrians on the canvas. Anyone can contribute new templates by submitting a PR with an SVG file and a manifest.json entry.

## Directory Structure

```
templates/
  vehicle/          # Vehicle templates (sedan, bus, truck, etc.)
  pedestrian/       # Pedestrian templates (walking, standing, etc.)
  manifest.json     # Template definitions
```

## Adding a New Template

### 1. Create an SVG File

Design your SVG with the following guidelines:

- **Single color fills recommended** for best color-change support
- Use a clean `viewBox` (e.g., `0 0 100 200`)
- No external references (fonts, images, links)
- Keep file size under 512KB

### 2. Preview with template-preview extension

Use the [template-preview extension](../extensions/template-preview/README.md) to preview your SVG on the canvas and configure all settings:

```bash
# Terminal 1: Start dev server
drawtonomy-dev-server

# Terminal 2: Start the extension
cd extensions/template-preview
pnpm install
pnpm dev

# Open in browser
open "http://localhost:3000/?ext=http://localhost:3002/manifest.json"
```

1. Drop your SVG file into the extension panel
2. Choose category (Vehicle / Pedestrian)
3. Adjust size with the Width/Height sliders
4. Select color mode (Full / Partial)
5. Click **Register on Canvas** to preview on the canvas
6. When satisfied, click **Copy to Clipboard** to copy the generated `manifest.json` entry

### 3. Submit a PR

1. Place your SVG file in `templates/vehicle/` or `templates/pedestrian/`
2. Paste the generated entry into `manifest.json`
3. Submit a pull request

## Size Guidelines

| Category | Typical width | Typical height |
|----------|:---:|:---:|
| Car (sedan) | 30 | 56 |
| Bus | 37 | 92 |
| Truck | 43 | 147 |
| Motorcycle | 18-22 | 36-43 |
| Bicycle | 17-18 | 36-42 |
| AMR / Robot | 11 | 11-16 |
| Pedestrian | 22 | 22 |

These are default sizes. Users can resize templates on the canvas.

## Examples

See existing templates in `vehicle/` and `pedestrian/` directories for reference.
