# drawtonomy-frontend (separate repository starter)

This folder is a **standalone frontend codebase** intended to live in its own repository.

## What it does

- Provides a simple React + Vite shell around drawtonomy.
- Embeds drawtonomy in an iframe.
- Lets you configure:
  - drawtonomy host URL (e.g. local dev server or production)
  - extension manifest URL (`?ext=`) for drawtonomy extensions
  - workspace title shown in the shell app

## How to split into a separate repo

```bash
# from this repository root
cp -R separate-repos/drawtonomy-frontend ../drawtonomy-frontend
cd ../drawtonomy-frontend
git init
npm install
npm run dev
```

Then open <http://localhost:5173>.

## Recommended integration workflow

1. Start drawtonomy (or use https://drawtonomy.com).
2. Start this frontend app.
3. Use this app as the project-level portal for teams (branding, presets, extension URLs, links to docs, etc.).

