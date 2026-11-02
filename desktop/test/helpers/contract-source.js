'use strict'
// Reads the Windows app bridge contract from src/lib/audio/types.ts as text, so the desktop
// tests can check the copied values without a TypeScript build. Returns null outside the repo.

const fs = require('node:fs')
const path = require('node:path')

const TYPES_FILE = path.resolve(__dirname, '..', '..', '..', 'src', 'lib', 'audio', 'types.ts')

function match (source, pattern, what) {
  const found = pattern.exec(source)
  if (!found) throw new Error('could not find ' + what + ' in ' + TYPES_FILE)
  return found[1]
}

function strings (text) {
  return [...text.matchAll(/"([^"]+)"/g)].map((m) => m[1])
}

function readContract () {
  if (!fs.existsSync(TYPES_FILE)) return null
  const source = fs.readFileSync(TYPES_FILE, 'utf8')
  const ipcBody = match(source, /export const DESKTOP_IPC = \{([\s\S]*?)\} as const;/, 'DESKTOP_IPC')
  const ipc = Object.fromEntries([...ipcBody.matchAll(/^\s*(\w+):\s*"([^"]+)"/gm)].map((m) => [m[1], m[2]]))
  const bridgeBody = match(source, /export interface CatchUpDesktopBridge \{([\s\S]*?)\n\}/, 'CatchUpDesktopBridge')
  return {
    file: TYPES_FILE,
    ipc,
    presets: strings(match(source, /export const DESKTOP_HOTKEY_PRESETS = \[([^\]]*)\] as const;/, 'DESKTOP_HOTKEY_PRESETS')),
    commands: strings(match(source, /export const DESKTOP_COMMANDS = \[([^\]]*)\] as const;/, 'DESKTOP_COMMANDS')),
    views: strings(match(source, /export type DesktopView = ([^;]+);/, 'DesktopView')),
    global: match(source, /export const DESKTOP_BRIDGE_GLOBAL = "([^"]+)"/, 'DESKTOP_BRIDGE_GLOBAL'),
    version: Number(match(source, /export const DESKTOP_BRIDGE_VERSION = (\d+)/, 'DESKTOP_BRIDGE_VERSION')),
    members: [...bridgeBody.matchAll(/^\s*(?:readonly\s+)?(\w+)\s*[(:?]/gm)].map((m) => m[1]),
    pressPayloadKeys: [...match(source, /export interface DesktopPressPayload \{([\s\S]*?)\n\}/, 'DesktopPressPayload').matchAll(/^\s*(\w+):/gm)].map((m) => m[1]),
    hotkeyStateKeys: [...match(source, /export interface DesktopHotkeyState \{([\s\S]*?)\n\}/, 'DesktopHotkeyState').matchAll(/^\s*(\w+):/gm)].map((m) => m[1])
  }
}

module.exports = { TYPES_FILE, readContract }
