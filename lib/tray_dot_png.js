/**
 * Generate a small filled-circle PNG (RGBA) for menu bar status dots.
 *
 * Electron's nativeImage cannot decode SVG, so we rasterize a colored dot
 * ourselves with no external dependencies. The color comes from
 * getTaskTrayStatusColor() so the dots stay in sync with the rest of the UI.
 */

const zlib = require('zlib');

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

/**
 * Parse a #rrggbb (or #rgb) string into [r, g, b]. Returns null if unparseable.
 */
function parseHexColor(hex) {
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(String(hex || '').trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/**
 * Build an RGBA filled circle as a PNG buffer.
 * @param {string} color - hex color like "#2d9d78"
 * @param {number} [size=32] - image width/height in pixels (supersampled source)
 * @returns {Buffer|null} PNG bytes, or null if color is invalid
 */
function makeDotPng(color, size = 32) {
  const rgb = parseHexColor(color);
  if (!rgb) return null;
  const [r, g, b] = rgb;

  const w = size;
  const h = size;
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const radius = (size / 2) * 0.62; // leave a little padding around the dot

  // Raw image data: each row prefixed with a filter byte (0 = none).
  const raw = Buffer.alloc((w * 4 + 1) * h);
  let p = 0;
  for (let y = 0; y < h; y++) {
    raw[p++] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      // 2x2 supersample for a soft anti-aliased edge.
      let cover = 0;
      for (let sy = 0; sy < 2; sy++) {
        for (let sx = 0; sx < 2; sx++) {
          const dx = x + (sx + 0.5) / 2 - 0.5 - cx;
          const dy = y + (sy + 0.5) / 2 - 0.5 - cy;
          if (dx * dx + dy * dy <= radius * radius) cover++;
        }
      }
      const alpha = Math.round((cover / 4) * 255);
      raw[p++] = r;
      raw[p++] = g;
      raw[p++] = b;
      raw[p++] = alpha;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

module.exports = { makeDotPng, parseHexColor };
