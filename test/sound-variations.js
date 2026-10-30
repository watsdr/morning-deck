// Sound pack v3 variations: 18 extra takes load (200, Ogg) from the isolated server, are precached by the SW, and the
// no-repeat picker never plays the same take twice in a row. Run: node test/isolated.js test/sound-variations.js --empty --port N
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const B = process.env.MD_BASE, D = process.env.MD_DATA_DIR;
if (!B || !D || !D.startsWith(os.tmpdir())) { console.error('run via node test/isolated.js'); process.exit(2); }
const ROOT = path.join(__dirname, '..');
const tok = (fs.readFileSync(path.join(ROOT, '.env'), 'utf8').match(/^MD_TOKEN=(.*)$/m) || [])[1];
assert(tok, 'no MD_TOKEN'); const H = { headers: { Authorization: `Bearer ${tok}` } }; // never printed
const NAMES = ['swish_right', 'swish_left', 'swish_up', 'swish_down', 'arm_tick', 'card_reveal'].flatMap((n) => [1, 2, 3].map((i) => `${n}_0${i}`));
(async () => {
  const app = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
  const line = app.split('\n').find((l) => l.includes('const pickTake ='));
  assert(line, 'pickTake not found in app.js');
  const pickTake = new Function(`${line.trim()} return pickTake;`)();
  for (const n of [2, 3, 4]) {
    let last = null; const seen = new Set();
    for (let k = 0; k < 5000; k++) { const i = pickTake(n, last); assert(i >= 0 && i < n, `out of range ${i}`); assert.notStrictEqual(i, last, 'repeat'); seen.add(i); last = i; }
    assert.strictEqual(seen.size, n, `pool ${n} not fully used`);
  }
  assert.strictEqual(pickTake(1, 0), 0);
  // edge rnd values
  assert.strictEqual(pickTake(4, 0, () => 0), 1); assert.strictEqual(pickTake(4, 3, () => 0.9999), 2);
  console.log('ok  no-repeat picker (5000 draws x pools 2/3/4)');
  const sw = await (await fetch(`${B}/sw.js`)).text();
  assert(sw.includes("'md-v27'"), 'SW version not md-v27');
  let bytes = 0;
  for (const n of NAMES) {
    const u = `/assets/sfx/${n}.ogg`;
    assert(sw.includes(`'${u}'`), `${u} not precached`);
    const r = await fetch(B + u, H); assert.strictEqual(r.status, 200, `${u} -> ${r.status}`);
    const b = Buffer.from(await r.arrayBuffer()); assert.strictEqual(b.subarray(0, 4).toString(), 'OggS', `${u} not Ogg`);
    assert(b.includes(Buffer.from('OpusHead')), `${u} not Opus`); bytes += b.length;
  }
  console.log(`ok  ${NAMES.length} variation files 200 + Ogg Opus + precached (${(bytes / 1024).toFixed(1)} KB)`);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
