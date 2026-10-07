// Renders the Morning Deck icon (stack of cards + sunrise) from SVG to PNGs using headless Chrome.
// Usage: node scripts/make-icons.js   (needs playwright-core + google-chrome; output: public/icons/)
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');
const OUT = path.join(__dirname, '..', 'public', 'icons');

function svg({ maskable = false, size = 512 }) {
  // Artwork drawn on a 512 canvas. Maskable: full-bleed bg, art scaled into the 80% safe zone.
  const s = maskable ? 0.72 : 0.9;
  const t = (512 - 512 * s) / 2;
  const bg = maskable
    ? `<rect width="512" height="512" fill="url(#bg)"/>`
    : `<rect x="0" y="0" width="512" height="512" rx="116" fill="url(#bg)"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0.35" y2="1">
      <stop offset="0" stop-color="#241552"/><stop offset="0.52" stop-color="#6b2f93"/><stop offset="1" stop-color="#ff8c5a"/>
    </linearGradient>
    <radialGradient id="sun" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#fff3c4"/><stop offset="0.55" stop-color="#ffc56b"/><stop offset="1" stop-color="#ff8c5a"/>
    </radialGradient>
    <radialGradient id="glow" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#ffd27a" stop-opacity="0.75"/><stop offset="1" stop-color="#ffd27a" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="c1" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#f3ecff"/></linearGradient>
    <linearGradient id="c2" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffd9c7"/><stop offset="1" stop-color="#ffb59a"/></linearGradient>
    <linearGradient id="c3" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#d9c8ff"/><stop offset="1" stop-color="#b79cff"/></linearGradient>
    <filter id="sh" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="14" stdDeviation="16" flood-color="#1a0b3a" flood-opacity="0.38"/></filter>
    <clipPath id="frontClip"><rect x="-92" y="-122" width="184" height="244" rx="30"/></clipPath>
  </defs>
  ${bg}
  <g transform="translate(${t} ${t}) scale(${s})">
    <circle cx="256" cy="188" r="190" fill="url(#glow)"/>
    <circle cx="256" cy="176" r="86" fill="url(#sun)"/>
    <g transform="translate(256 300)">
      <g transform="rotate(-14) translate(-40 6)" filter="url(#sh)"><rect x="-92" y="-122" width="184" height="244" rx="30" fill="url(#c3)"/></g>
      <g transform="rotate(12) translate(40 6)" filter="url(#sh)"><rect x="-92" y="-122" width="184" height="244" rx="30" fill="url(#c2)"/></g>
      <g filter="url(#sh)">
        <rect x="-92" y="-122" width="184" height="244" rx="30" fill="#fbf8ff"/>
        <g clip-path="url(#frontClip)">
          <circle cx="0" cy="34" r="46" fill="#ff9d5c"/>
          <rect x="-92" y="34" width="184" height="100" fill="#fbf8ff"/>
          <rect x="-56" y="34" width="112" height="7" rx="3.5" fill="#ff9d5c" opacity="0.9"/>
          <g stroke="#ffb35c" stroke-width="8" stroke-linecap="round">
            <line x1="0" y1="-38" x2="0" y2="-54"/><line x1="-44" y1="-22" x2="-54" y2="-34"/><line x1="44" y1="-22" x2="54" y2="-34"/>
          </g>
          <rect x="-50" y="66" width="100" height="10" rx="5" fill="#d9ccf5"/>
          <rect x="-34" y="88" width="68" height="10" rx="5" fill="#e8e0fa"/>
        </g>
      </g>
    </g>
  </g>
</svg>`;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'icon.svg'), svg({ size: 512 }));
  fs.writeFileSync(path.join(OUT, 'icon-maskable.svg'), svg({ maskable: true, size: 512 }));
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const jobs = [
    ['icon-192.png', 192, false], ['icon-512.png', 512, false],
    ['maskable-192.png', 192, true], ['maskable-512.png', 512, true],
    ['apple-touch-icon.png', 180, true], ['favicon-32.png', 32, false], ['favicon-64.png', 64, false],
  ];
  for (const [name, size, maskable] of jobs) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<html><body style="margin:0;background:transparent">${svg({ maskable, size })}</body></html>`);
    await page.screenshot({ path: path.join(OUT, name), omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
    console.log('wrote', name);
  }
  await browser.close();
})();
