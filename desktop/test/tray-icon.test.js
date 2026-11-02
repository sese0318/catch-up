'use strict'
const assert = require('node:assert/strict')
const zlib = require('node:zlib')
const { test } = require('node:test')
const { COLORS, crc32, drawTrayIcon, iconSize, trayIconPng } = require('../tray-icon')

function readPng (png) {
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const chunks = []
  let offset = 8
  while (offset < png.length) {
    const length = png.readUInt32BE(offset)
    const type = png.toString('ascii', offset + 4, offset + 8)
    const data = png.subarray(offset + 8, offset + 8 + length)
    const crc = png.readUInt32BE(offset + 8 + length)
    assert.equal(crc, crc32(png.subarray(offset + 4, offset + 8 + length)), type + ' CRC')
    chunks.push({ type, data })
    offset += 12 + length
  }
  const header = chunks[0]
  assert.equal(header.type, 'IHDR')
  const width = header.data.readUInt32BE(0)
  const height = header.data.readUInt32BE(4)
  assert.deepEqual([...header.data.subarray(8)], [8, 6, 0, 0, 0])
  assert.equal(chunks[chunks.length - 1].type, 'IEND')
  const raw = zlib.inflateSync(Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data)))
  const rgba = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    assert.equal(raw[y * (width * 4 + 1)], 0, 'filter type 0')
    raw.copy(rgba, y * width * 4, y * (width * 4 + 1) + 1, (y + 1) * (width * 4 + 1))
  }
  return { width, height, rgba }
}

function pixel ({ width, rgba }, x, y) {
  const o = (y * width + x) * 4
  return [rgba[o], rgba[o + 1], rgba[o + 2], rgba[o + 3]]
}

test('the CRC matches the well known IEND value', () => {
  assert.equal(crc32(Buffer.from('IEND', 'ascii')), 0xae426082)
  if (typeof zlib.crc32 === 'function') {
    const sample = Buffer.from('Catch Up keeps the last 2 minutes of sound in memory.')
    assert.equal(crc32(sample), zlib.crc32(sample))
  }
})

test('draws at 16 px times the display scale, within 16 to 64 px', () => {
  assert.equal(iconSize(1), 16)
  assert.equal(iconSize(1.25), 20)
  assert.equal(iconSize(1.5), 24)
  assert.equal(iconSize(2), 32)
  assert.equal(iconSize(0.5), 16)
  assert.equal(iconSize(10), 64)
  assert.equal(iconSize(Number.NaN), 16)
  assert.equal(iconSize(undefined), 16)
})

test('every state is a valid PNG with the drawn pixels', () => {
  for (const scale of [1, 1.5, 2]) {
    for (const state of [{ listening: false }, { listening: true }, { listening: false, problem: true }, { listening: true, problem: true }]) {
      const image = readPng(trayIconPng(state, scale))
      assert.equal(image.width, iconSize(scale))
      assert.equal(image.height, iconSize(scale))
      assert.deepEqual(image.rgba, drawTrayIcon(state, iconSize(scale)))
    }
  }
})

test('filled while listening, hollow when not, badged on a problem', () => {
  const size = 32
  const idle = readPng(trayIconPng({ listening: false }, 2))
  const listening = readPng(trayIconPng({ listening: true }, 2))
  const problem = readPng(trayIconPng({ listening: false, problem: true }, 2))
  const center = size / 2
  assert.deepEqual(pixel(listening, center, center), [...COLORS.listening, 255])
  assert.equal(pixel(idle, center, center)[3], 0, 'the ring is hollow')
  const ringX = Math.round(size * 0.5 - size * 0.365)
  assert.deepEqual(pixel(idle, ringX, center), [...COLORS.idle, 255])
  const badge = Math.round(size * 0.76)
  assert.deepEqual(pixel(problem, badge, badge), [...COLORS.badge, 255])
  assert.deepEqual(pixel(idle, badge, badge), [...COLORS.idle, 255], 'the badge sits over the ring')
  for (const image of [idle, listening, problem]) assert.equal(pixel(image, 0, 0)[3], 0, 'corners stay clear')
  assert.notDeepEqual(idle.rgba, listening.rgba)
  assert.notDeepEqual(idle.rgba, problem.rgba)
})
