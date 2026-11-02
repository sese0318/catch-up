'use strict'
const assert = require('node:assert/strict')
const { test } = require('node:test')
const contract = require('../contract')
const { readContract } = require('./helpers/contract-source')
const { createFakeElectron, loadWithElectron } = require('./helpers/fake-electron')

const ts = readContract()
const skip = ts ? false : 'src/lib/audio/types.ts is not next to desktop/'

test('the IPC channel names match src/lib/audio/types.ts', { skip }, () => {
  assert.deepEqual({ ...contract.DESKTOP_IPC }, ts.ipc)
})

test('the bridge name, version, presets, commands and views match the contract', { skip }, () => {
  assert.equal(contract.DESKTOP_BRIDGE_GLOBAL, ts.global)
  assert.equal(contract.DESKTOP_BRIDGE_VERSION, ts.version)
  assert.deepEqual([...contract.DESKTOP_HOTKEY_PRESETS], ts.presets)
  assert.deepEqual([...contract.DESKTOP_COMMANDS], ts.commands)
  assert.deepEqual([...contract.DESKTOP_VIEWS], ts.views)
})

test('the press payload and hotkey state have the contract fields', { skip }, () => {
  assert.deepEqual(ts.pressPayloadKeys, ['at', 'via', 'accelerator'])
  assert.deepEqual(ts.hotkeyStateKeys, ['accelerator', 'registered', 'error'])
})

test('every preset is a safe Windows global hotkey', () => {
  const fake = createFakeElectron()
  const main = loadWithElectron('main.js', fake.electron) // whenReady never resolves here
  const modifiers = new Set(['control', 'ctrl', 'commandorcontrol', 'cmdorctrl', 'alt', 'option', 'shift'])
  for (const preset of contract.DESKTOP_HOTKEY_PRESETS) {
    const tokens = preset.split('+').map((token) => token.toLowerCase())
    assert.ok(tokens.includes('control') || tokens.includes('alt'), preset + ' needs Ctrl or Alt')
    assert.equal(tokens.filter((token) => !modifiers.has(token)).length, 1, preset + ' has one key')
    for (const unsafe of ['super', 'meta', 'command', 'cmd', 'altgr', 'f12']) assert.ok(!tokens.includes(unsafe), preset)
    assert.ok(!main.BLOCKED_HOTKEYS.includes(preset), preset + ' is taken on the demo PC')
  }
  assert.deepEqual([...main.BLOCKED_HOTKEYS], ['Alt+Space', 'Control+Alt+Q', 'Control+Alt+Up', 'Control+Alt+Down'])
  fake.cleanup()
})
