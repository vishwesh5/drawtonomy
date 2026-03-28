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

### 2. Choose Color Mode

Templates support two color-change modes:

| Mode | `replaceColor` | How it works | Best for |
|------|:---:|------|------|
| **Full color** | omit or `null` | Entire SVG used as CSS mask, filled with user's chosen color | Single-color silhouettes |
| **Partial color** | `"#hexcolor"` | Only paths matching this hex color are replaced | Multi-color SVGs where only part changes |

#### Full color mode (default)

Your SVG is used as a mask. All non-transparent areas will be filled with the user's color.

```xml
<!-- Good: solid black silhouette -->
<svg viewBox="0 0 100 200">
  <path d="M50 10 L90 190 L10 190 Z" fill="#000000"/>
</svg>
```

#### Partial color mode

Specify which color in your SVG should be replaced. Other colors remain unchanged.

```xml
<!-- The #b3b3b3 parts will change color, #000000 stays black -->
<svg viewBox="0 0 100 200">
  <path d="M30 50 L70 50 L70 150 L30 150 Z" fill="#b3b3b3"/>  <!-- This changes -->
  <circle cx="50" cy="30" r="15" fill="#000000"/>               <!-- This stays -->
</svg>
```

### 3. Add manifest.json Entry

Add your template to the appropriate category in `manifest.json`:

```json
{
  "vehicle": [
    {
      "id": "my-vehicle",
      "name": "My Vehicle",
      "svg": "vehicle/my-vehicle.svg",
      "w": 30,
      "h": 56,
      "viewBox": [100, 200]
    }
  ]
}
```

#### Fields

| Field | Type | Required | Description |
|-------|------|:---:|------|
| `id` | string | yes | Unique identifier (lowercase, hyphens allowed) |
| `name` | string | yes | Display name shown in the UI |
| `svg` | string | yes | Path relative to `templates/` directory |
| `w` | number | yes | Default width in pixels on canvas |
| `h` | number | yes | Default height in pixels on canvas |
| `viewBox` | [number, number] | yes | SVG viewBox [width, height] for aspect ratio |
| `replaceColor` | string or null | no | Hex color to replace (null = full color mode) |
| `defaultColor` | string | no | Default color key (default: "black") |

### 4. Preview with dev-server

Use `@drawtonomy/dev-server` to test your template locally:

```bash
npx @drawtonomy/dev-server
```

### 5. Submit a PR

1. Place your SVG file in `templates/vehicle/` or `templates/pedestrian/`
2. Add the entry to `manifest.json`
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
