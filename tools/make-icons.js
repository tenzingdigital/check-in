// tools/make-icons.js — the raster icons, drawn from the one mark.
/* ============================================================================

   public/icon.svg is the mark. Everything here is generated from it, so the
   tick is never redrawn by hand in six sizes and never drifts between the
   app and the brochure site.

   Run it when the mark changes, not on every build — the output is committed,
   because a browser asking for /favicon.ico must get one from a static host
   with no build step, and because a binary that regenerates identically is
   cheaper to review as a file than as a pipeline.

       npm install --no-save playwright     # same as test/e2e.sh
       node tools/make-icons.js

   Chromium does the rasterising. That is the same dependency the end-to-end
   suite already asks for, so this adds none: there is no image library in
   package.json and this file is not a reason to add one.

   What it writes, and who asks for it:

     favicon.ico            every browser, unprompted, at /favicon.ico — and
                            crawlers, link unfurlers and feed readers that
                            never look at a <link> tag. Its absence is the
                            404 in every access log and the blank square in
                            a Safari tab. 16, 32 and 48 in one file.
     icon.svg               the tab icon on a screen of any density. Copied
                            to the site so both are served the same file.
     apple-touch-icon.png   iOS home screen and bookmarks, 180×180. Without
                            it iOS screenshots the page and uses that.
     icon-192 / icon-512    Android install. Chrome has never been reliable
                            about SVG in a manifest, so the PNGs are what
                            actually get used.
     icon-maskable.png      Android again, which masks an icon to whatever
                            shape the launcher likes. A mark that fills its
                            frame loses its corners to that, so this one is
                            the tick on a full-bleed field, inside the 80%
                            safe zone the spec asks for.
   ========================================================================= */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const SITE = path.join(ROOT, 'site');
const MARK = fs.readFileSync(path.join(PUBLIC, 'icon.svg'), 'utf8').trim();

// The maskable variant: the same tick and the same blue, but square to the
// edges with the art pulled into the middle, so a circular mask takes only
// background. Kept beside the mark it is derived from rather than in a file
// of its own — two files would be two things to keep in step.
const MASKABLE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" fill="#1d4ed8"/>
  <path d="M21 33.5l8 8 14.5-16" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

// An ICO is a six-byte header, a sixteen-byte directory entry per image, and
// then the images. PNG payloads are legal in an ICO and are what every
// generator has emitted for years, so each entry is simply the PNG this
// script already rendered. A width byte of 0 would mean 256; nothing here is
// that big, so the sizes go in as themselves.
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);              // reserved
  header.writeUInt16LE(1, 2);              // 1 = icon
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + images.length * 16;
  const entries = images.map(({ size, png }) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(size, 0);                 // width
    e.writeUInt8(size, 1);                 // height
    e.writeUInt8(0, 2);                    // colours in palette: 0 = truecolour
    e.writeUInt8(0, 3);                    // reserved
    e.writeUInt16LE(1, 4);                 // colour planes
    e.writeUInt16LE(32, 6);                // bits per pixel
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += png.length;
    return e;
  });
  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
}

(async () => {
  let chromium;
  try { ({ chromium } = require('playwright')); } catch {
    console.error('playwright is not installed. Run:  npm install --no-save playwright');
    process.exit(1);
  }
  // Same fallback as test/offline.e2e.test.js: a sandbox that ships Chromium
  // at a fixed path rather than in Playwright's own cache still works.
  const browser = await chromium.launch()
    .catch(() => chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }));

  // One page per size rather than one page scaled: a 16px icon rasterised
  // from a 16px viewport keeps the tick's stroke on the pixel grid, where
  // downscaling a big one turns it to mush at exactly the size that matters
  // most — the tab.
  const render = async (svg, size) => {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(
      `<!doctype html><meta charset="utf-8">` +
      `<style>html,body{margin:0;padding:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>` +
      svg);
    const png = await page.screenshot({ omitBackground: true });
    await page.close();
    return png;
  };

  const write = (file, buf) => {
    fs.writeFileSync(file, buf);
    console.log(`  ${path.relative(ROOT, file)}  ${buf.length} bytes`);
  };

  console.log('icons from public/icon.svg:');
  const small = [];
  for (const size of [16, 32, 48]) small.push({ size, png: await render(MARK, size) });
  const favicon = ico(small);
  write(path.join(PUBLIC, 'favicon.ico'), favicon);
  write(path.join(SITE, 'favicon.ico'), favicon);

  const touch = await render(MARK, 180);
  write(path.join(PUBLIC, 'apple-touch-icon.png'), touch);
  write(path.join(SITE, 'apple-touch-icon.png'), touch);

  write(path.join(PUBLIC, 'icon-192.png'), await render(MARK, 192));
  write(path.join(PUBLIC, 'icon-512.png'), await render(MARK, 512));
  write(path.join(PUBLIC, 'icon-maskable.png'), await render(MASKABLE, 512));

  // The brochure site is served as static files by a different host, so it
  // gets its own copy of the mark rather than linking across.
  write(path.join(SITE, 'icon.svg'), Buffer.from(MARK + '\n'));

  await browser.close();
})().catch((err) => { console.error(err); process.exit(1); });
