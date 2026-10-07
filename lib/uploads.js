'use strict';
// Morning Deck uploads: image attachments for replies, stored as data/uploads/<id>.<ext> + <id>.json (metadata).
// SAFETY: local disk only. Type is decided by sniffing magic bytes (never trusts the client's Content-Type),
// so only real raster images are accepted (no SVG/HTML), and they're served back with nosniff + a sandbox CSP.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const core = require('./core');

const MAX_BYTES = 8 * 1024 * 1024; // per image
const MAX_PER_ANSWER = 6;
const ID_RE = /^upl_[a-f0-9]{20}$/;
const CLIENT_ID_RE = /^[A-Za-z0-9._:-]{8,100}$/;

const ascii = (b, s, e) => b.slice(s, e).toString('latin1');
const FTYP = (b, brands) => b.length > 12 && ascii(b, 4, 8) === 'ftyp' && brands.includes(ascii(b, 8, 12));
const TYPES = [
  { mime: 'image/jpeg', ext: 'jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/png', ext: 'png', test: (b) => b.length > 24 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a },
  { mime: 'image/webp', ext: 'webp', test: (b) => b.length > 16 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP' },
  { mime: 'image/gif', ext: 'gif', test: (b) => ascii(b, 0, 4) === 'GIF8' },
  { mime: 'image/avif', ext: 'avif', test: (b) => FTYP(b, ['avif', 'avis']) },
  { mime: 'image/heic', ext: 'heic', test: (b) => FTYP(b, ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1']) },
];
function sniff(buf) { return TYPES.find((t) => { try { return t.test(buf); } catch { return false; } }) || null; }

// Best-effort pixel size from the header (jpeg/png/gif/webp). Returns {} if unknown.
function dimensions(b, mime) {
  try {
    if (mime === 'image/png') return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
    if (mime === 'image/gif') return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
    if (mime === 'image/webp') {
      const kind = ascii(b, 12, 16);
      if (kind === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
      if (kind === 'VP8L') { const n = b.readUInt32LE(21); return { width: 1 + (n & 0x3fff), height: 1 + ((n >> 14) & 0x3fff) }; }
      if (kind === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    }
    if (mime === 'image/jpeg') {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) { i++; continue; }
        const m = b[i + 1];
        if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7) || m === 0xff) { i += m === 0xff ? 1 : 2; continue; }
        const len = b.readUInt16BE(i + 2);
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
        i += 2 + len;
      }
    }
  } catch (_) { /* truncated header */ }
  return {};
}

const metaFile = (id) => path.join(core.UPLOADS_DIR, `${id}.json`);
function get(id) {
  if (!ID_RE.test(String(id))) return null;
  try { return JSON.parse(fs.readFileSync(metaFile(id), 'utf8')); } catch { return null; }
}
const filePath = (meta) => path.join(core.UPLOADS_DIR, `${meta.id}.${meta.ext}`);
// Public shape (also what answers carry). `path` is absolute so bots on this box can open the file directly.
function describe(meta) {
  return { id: meta.id, url: `/api/uploads/${meta.id}`, mime: meta.mime, size: meta.size, width: meta.width ?? null, height: meta.height ?? null, path: filePath(meta) };
}
function writeAtomic(file, buf) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o644);
  try { fs.writeSync(fd, buf); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}

// Store image bytes. clientUploadId (optional) makes retries idempotent: same id -> same upload.
function save(buf, { clientUploadId, width, height } = {}) {
  const err = (status, msg) => Object.assign(new Error(msg), { status });
  if (!Buffer.isBuffer(buf) || !buf.length) throw err(400, 'empty upload: send image bytes (Content-Type: image/*) or JSON {data: base64}');
  if (buf.length > MAX_BYTES) throw err(413, `image too large (max ${MAX_BYTES / 1048576} MB)`);
  const t = sniff(buf);
  if (!t) throw err(415, 'not a supported image (jpeg, png, webp, gif, avif, heic)');
  if (clientUploadId !== undefined && clientUploadId !== null && !CLIENT_ID_RE.test(String(clientUploadId))) throw err(400, 'clientUploadId must be 8-100 chars [A-Za-z0-9._:-]');
  const id = 'upl_' + (clientUploadId
    ? crypto.createHash('sha256').update('md-upload:' + clientUploadId).digest('hex').slice(0, 20)
    : crypto.randomBytes(10).toString('hex'));
  const existing = get(id);
  if (existing && fs.existsSync(filePath(existing))) return { meta: existing, duplicate: true };
  const dims = dimensions(buf, t.mime);
  const num = (v) => (Number.isInteger(+v) && +v > 0 && +v < 100000 ? +v : null);
  const meta = {
    id, mime: t.mime, ext: t.ext, size: buf.length,
    width: dims.width || num(width), height: dims.height || num(height),
    sha256: crypto.createHash('sha256').update(buf).digest('hex'),
    createdAt: new Date().toISOString(), clientUploadId: clientUploadId || undefined,
  };
  fs.mkdirSync(core.UPLOADS_DIR, { recursive: true });
  writeAtomic(filePath(meta), buf);
  writeAtomic(metaFile(id), Buffer.from(JSON.stringify(meta, null, 2) + '\n'));
  return { meta, duplicate: false };
}

module.exports = { MAX_BYTES, MAX_PER_ANSWER, ID_RE, sniff, dimensions, get, describe, filePath, save };
