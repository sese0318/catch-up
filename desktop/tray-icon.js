'use strict'
// Tray icons drawn in code, so the app ships no image files. A filled disc while listening, a
// hollow ring when not, and a small badge when something needs attention. Electron builds the
// Windows tray icon from the 1x bitmap, so the icon is drawn at the display's own pixel size.

const zlib = require('node:zlib')

const BASE_SIZE = 16
const SAMPLES = 4 // per axis and pixel, for smooth edges

const COLORS = Object.freeze({
  listening: Object.freeze([217, 45, 32]), // #D92D20, the panel's listening red
  idle: Object.freeze([138, 138, 147]), // #8A8A93, readable on light and dark taskbars
  badge: Object.freeze([250, 204, 21]), // #FACC15
  badgeEdge: Object.freeze([58, 46, 0]) // #3A2E00
})

// In units of the icon size.
const SHAPE = Object.freeze({
  center: 0.5,
  outer: 0.44,
  ringInner: 0.29,
  badgeX: 0.76,
  badgeY: 0.76,
  badgeOuter: 0.24,
  badgeEdge: 0.07,
  badgeGap: 0.09
})

function iconSize (scaleFactor) {
  const scale = Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1
  return Math.min(64, Math.max(BASE_SIZE, Math.round(BASE_SIZE * scale)))
}

function sampleColor (u, v, listening, problem) {
  if (problem) {
    const b = Math.hypot(u - SHAPE.badgeX, v - SHAPE.badgeY)
    if (b <= SHAPE.badgeOuter - SHAPE.badgeEdge) return COLORS.badge
    if (b <= SHAPE.badgeOuter) return COLORS.badgeEdge
    if (b <= SHAPE.badgeOuter + SHAPE.badgeGap) return null // a clear gap around the badge
  }
  const d = Math.hypot(u - SHAPE.center, v - SHAPE.center)
  if (d > SHAPE.outer) return null
  if (listening) return COLORS.listening
  return d >= SHAPE.ringInner ? COLORS.idle : null
}

/** RGBA pixels with straight alpha, size by size. */
function drawTrayIcon (state, size) {
  const listening = Boolean(state && state.listening)
  const problem = Boolean(state && state.problem)
  const rgba = Buffer.alloc(size * size * 4)
  const total = SAMPLES * SAMPLES
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0
      let g = 0
      let b = 0
      let covered = 0
      for (let j = 0; j < SAMPLES; j++) {
        for (let i = 0; i < SAMPLES; i++) {
          const color = sampleColor((x + (i + 0.5) / SAMPLES) / size, (y + (j + 0.5) / SAMPLES) / size, listening, problem)
          if (!color) continue
          r += color[0]
          g += color[1]
          b += color[2]
          covered += 1
        }
      }
      if (covered === 0) continue
      const o = (y * size + x) * 4
      rgba[o] = Math.round(r / covered)
      rgba[o + 1] = Math.round(g / covered)
      rgba[o + 2] = Math.round(b / covered)
      rgba[o + 3] = Math.round((covered / total) * 255)
    }
  }
  return rgba
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
let crcTable = null

function crc32 (buffer) {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (let i = 0; i < buffer.length; i++) crc = crcTable[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk (type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

/** A minimal 8-bit RGBA PNG, no interlace, filter type 0 on every row. */
function encodePng (rgba, width, height) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = 6 // color type RGBA
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

/** PNG bytes for the tray, drawn for the given display scale. */
function trayIconPng (state, scaleFactor) {
  const size = iconSize(scaleFactor)
  return encodePng(drawTrayIcon(state, size), size, size)
}

module.exports = { COLORS, crc32, drawTrayIcon, encodePng, iconSize, trayIconPng }
