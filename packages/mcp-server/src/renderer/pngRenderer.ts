// SVG → PNG conversion using @resvg/resvg-js

import { Resvg } from '@resvg/resvg-js'

export function svgToPng(svgString: string): Buffer {
  const resvg = new Resvg(svgString, {
    fitTo: { mode: 'original' },
  })
  const rendered = resvg.render()
  return Buffer.from(rendered.asPng())
}
