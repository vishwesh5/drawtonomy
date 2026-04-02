# Template Preview

Development extension for previewing and testing custom SVG templates on the canvas.

## Quick Start

```bash
# Terminal 1: Start dev server
drawtonomy-dev-server

# Terminal 2: Start this extension
cd extensions/template-preview
pnpm install
pnpm dev

# Browser
open "http://localhost:3000/?ext=http://localhost:3002/manifest.json"
```

## Usage

1. Drop an SVG file into the panel (or click to select)
2. Choose category: Vehicle or Pedestrian
3. Adjust size with Width/Height sliders (aspect ratio lock available)
4. Select color mode:
   - **Full** — entire SVG changes color (CSS mask)
   - **Partial** — only paths matching `replaceColor` change
5. Click **Register on Canvas**
6. Select the registered template in the attribute panel and place shapes

## manifest.json Entry

The panel auto-generates a `manifest.json` entry based on your settings. Click **Copy to Clipboard** and paste it into [`templates/manifest.json`](../../templates/manifest.json) when submitting a PR.

## Contributing a New Template

1. Preview your SVG with this extension
2. Adjust size and color mode until it looks right
3. Copy the generated manifest.json entry
4. Add your SVG to `templates/vehicle/` or `templates/pedestrian/`
5. Add the entry to `templates/manifest.json`
6. Submit a PR

See [`templates/TEMPLATE_GUIDE.md`](../../templates/TEMPLATE_GUIDE.md) for detailed guidelines.
