# Logo

`gen.mjs` is the source of truth. It writes `docs/logo-light.svg`,
`docs/logo-dark.svg`, `docs/logo-pixel.svg` and `docs/icon-pixel.svg` from an
8px grid: a three-bar gauge whose last bar has gone orange, and a bitmap font
defined at the top of the file.

`docs/icon.svg` is drawn by hand — it is the rounded-card app icon, the one
shape here that is not pixel art. Its body is two filled rects rather than a
stroked one, because thin SVG rasterisers drop strokes and the PNG fallback is
generated from that file.

Regenerate:

```sh
node docs/logo/gen.mjs
for v in light dark pixel; do
  magick -density 144 -background none docs/logo-$v.svg docs/logo-$v.png
done
magick -density 300 -background none docs/icon.svg -resize 512x512 docs/icon.png
magick -density 144 docs/icon-pixel.svg -resize 512x512 docs/icon-pixel.png
```

Colours: ink `#18181b` on light, `#f2f2f0` on dark, accent `#ff7a3c`, pixel
background `#0a0a0c`. The app icon uses `#1C1B22` and `#CC785C`.
