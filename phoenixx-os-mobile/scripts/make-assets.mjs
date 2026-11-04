/**
 * Renders the source icon and splash images that @capacitor/assets expands into
 * every size Android and iOS ask for.
 *
 * The mark is the same one the web app uses as its favicon, drawn as SVG here
 * so the app icon and the browser tab cannot drift apart. Regenerate with
 * `npm run assets` after changing it.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ASSETS = resolve(dirname(fileURLToPath(import.meta.url)), '../assets');
mkdirSync(ASSETS, { recursive: true });

const BRAND = '#1e40af';
const BRAND_DARK = '#0f172a';
const AMBER = '#f59e0b';

/**
 * The glyph on a transparent ground, in a 32x32 box.
 * Android masks adaptive icons to a circle and crops ~25% off each edge, so the
 * caller scales this down inside the canvas rather than letting it reach the
 * corners.
 */
const glyph = `
  <path d="M10 23V9h6.2a4.4 4.4 0 0 1 0 8.8H13V23h-3Zm3-7.9h3a1.7 1.7 0 0 0 0-3.4h-3v3.4Z" fill="#ffffff"/>
  <circle cx="22" cy="21" r="2.6" fill="${AMBER}"/>
`;

/** A square canvas with the glyph centred at `scale` of the full width. */
function canvas(size, background, scale) {
  const g = size * scale;
  const offset = (size - g) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" fill="${background}"/>
  <g transform="translate(${offset} ${offset}) scale(${g / 32})">${glyph}</g>
</svg>`;
}

const jobs = [
  // Full-bleed: the launcher applies its own rounding and mask.
  ['icon.png', canvas(1024, BRAND, 0.62)],
  // Splash art is centred in a square that both platforms crop to the screen,
  // so the mark stays small enough to survive the narrowest crop.
  ['splash.png', canvas(2732, BRAND, 0.16)],
  ['splash-dark.png', canvas(2732, BRAND_DARK, 0.16)],
];

for (const [name, svg] of jobs) {
  const out = join(ASSETS, name);
  await sharp(Buffer.from(svg)).png().toFile(out);
  writeFileSync(join(ASSETS, name.replace('.png', '.svg')), svg);
  console.log(`  wrote ${out}`);
}
