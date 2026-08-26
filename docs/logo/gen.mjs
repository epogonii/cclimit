#!/usr/bin/env node
// Renders the cclimit wordmark. Everything is on an 8px grid with no
// antialiasing, same as ccfind: the mark is a three-bar gauge whose last bar
// has gone orange, and the letters are a bitmap font defined below.
//
//   node docs/logo/gen.mjs        writes docs/logo-{light,dark,pixel}.svg
//
// The PNG fallbacks are made from these with ImageMagick; see docs/logo/README.md.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CELL = 8;
const INK_LIGHT = '#18181b';
const INK_DARK = '#f2f2f0';
const ACCENT = '#ff7a3c';
const PIXEL_BG = '#0a0a0c';

// Seven rows tall. Rows 0-1 are the ascender band, 2-6 the x-height band, so a
// letter with no ascender simply starts at row 2. '#' is ink, 'o' is accent.
// Each glyph is trimmed to its own ink, so the single blank column between
// them is the whole of the spacing: a five-wide box around a two-wide 'l'
// would leave a hole in the middle of the word.
const FONT = {
  c: ['.....', '.....', '.###.', '#...#', '#....', '#...#', '.###.'],
  l: ['##', '.#', '.#', '.#', '.#', '.#', '.#'],
  i: ['#', '.', '#', '#', '#', '#', '#'],
  m: ['.....', '.....', '##.##', '#.#.#', '#.#.#', '#.#.#', '#.#.#'],
  t: ['.#..', '.#..', '####', '.#..', '.#..', '.#..', '..##'],
};

// The gauge: a battery outline with three bars inside. Two are ink, the third
// is orange — usage has reached the line, which is the whole point of the
// plugin. 13 columns by 11 rows.
const MARK = [
  '.............',
  '############.',
  '#..........#.',
  '#.##.##.oo.#.',
  '#.##.##.oo.##',
  '#.##.##.oo.##',
  '#.##.##.oo.##',
  '#.##.##.oo.#.',
  '#..........#.',
  '############.',
  '.............',
];

function rects(rows, x0, y0, ink) {
  const out = [];
  rows.forEach((row, r) => {
    [...row].forEach((cell, c) => {
      if (cell === '.') return;
      const fill = cell === 'o' ? ACCENT : ink;
      out.push(
        `<rect x="${x0 + c * CELL}" y="${y0 + r * CELL}" width="${CELL}" height="${CELL}" fill="${fill}"/>`
      );
    });
  });
  return out;
}

function build(ink, background) {
  const parts = [];

  // Mark on the left, vertically centred against the letters.
  const markX = 32;
  const markY = 32;
  parts.push(...rects(MARK, markX, markY, ink));

  // Wordmark, one empty column between glyphs.
  const textY = 56;
  let x = markX + (MARK[0].length + 2) * CELL;
  for (const ch of 'cclimit') {
    const glyph = FONT[ch];
    if (!glyph) throw new Error(`no glyph for ${ch}`);
    parts.push(...rects(glyph, x, textY, ink));
    x += (glyph[0].length + 1) * CELL;
  }

  const width = x - CELL + 24;
  const height = 176;
  const bg = background ? `<rect width="${width}" height="${height}" fill="${background}"/>` : '';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}" shape-rendering="crispEdges" role="img" aria-label="cclimit">` +
    `<title>cclimit</title>${bg}${parts.join('')}</svg>\n`
  );
}

// The square pixel version of the mark on its own, for anywhere the wordmark
// does not fit: 13x11 cells at 32px, centred on a 512 canvas.
function buildIcon() {
  const cell = 32;
  const x0 = (512 - MARK[0].length * cell) / 2;
  const y0 = (512 - MARK.length * cell) / 2;
  const parts = [];
  MARK.forEach((row, r) => {
    [...row].forEach((c, i) => {
      if (c === '.') return;
      parts.push(
        `<rect x="${x0 + i * cell}" y="${y0 + r * cell}" width="${cell}" height="${cell}" ` +
          `fill="${c === 'o' ? ACCENT : INK_DARK}"/>`
      );
    });
  });
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512" ` +
    `shape-rendering="crispEdges" role="img" aria-label="cclimit">` +
    `<title>cclimit</title><rect width="512" height="512" fill="${PIXEL_BG}"/>${parts.join('')}</svg>\n`
  );
}

const files = {
  'logo-light.svg': build(INK_LIGHT, null),
  'logo-dark.svg': build(INK_DARK, null),
  'logo-pixel.svg': build(INK_DARK, PIXEL_BG),
  'icon-pixel.svg': buildIcon(),
};

for (const [name, svg] of Object.entries(files)) {
  fs.writeFileSync(path.join(OUT, name), svg);
  process.stdout.write(`${name}  ${svg.length} bytes\n`);
}
