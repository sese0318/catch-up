'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const { DESKTOP_BRIDGE_GLOBAL, DESKTOP_IPC } = require('../contract')
const { readContract } = require('./helpers/contract-source')
const { DESKTOP_DIR, createFakeElectron, loadWithElectron } = require('./helpers/fake-electron')

// The CatchUpDesktopBridge members, used when the TypeScript contract is not next to desktop/.
const BRIDGE_MEMBERS = [
  'isDesktop',
  'bridgeVersion',
  'onHotkey',
  'onHotkeyChange',
  'onCommand',
  'onViewChange',
  'getView',
  'setView',
  'getHotkey',
  'setHotkey',
  'setTrayState',
  'showPanel',
  'copyText',
  'hideWindow'
]

const SUBSCRIPTIONS = [
  ['onHotkey', DESKTOP_IPC.hotkey, { at: 1762000000000, via: 'hotkey', accelerator: 'Control+Alt+C' }],
  ['onHotkey', DESKTOP_IPC.hotkey, { at: 1762000000500, via: 'tray', accelerator: null }],
  ['onHotkeyChange', DESKTOP_IPC.hotkeyChanged, { accelerator: 'Control+Shift+Space', registered: true, error: null }],
  ['onCommand', DESKTOP_IPC.command, 'pause'],
  ['onViewChange', DESKTOP_IPC.viewChanged, 'full']
]

function loadPreload (options) {
  const fake = createFakeElectron(options)
  loadWithElectron('preload.js', fake.electron)
  return { fake, api: fake.state.exposed[DESKTOP_BRIDGE_GLOBAL] }
}

test('exposes window.catchUpDesktop with exactly the contract members', () => {
  const { fake, api } = loadPreload()
  assert.deepEqual(Object.keys(fake.state.exposed), ['catchUpDesktop'])
  const contract = readContract()
  const members = contract ? contract.members : BRIDGE_MEMBERS
  assert.deepEqual(Object.keys(api).sort(), [...members].sort())
  assert.equal(api.isDesktop, true)
  assert.equal(api.bridgeVersion, 1)
  for (const [key, value] of Object.entries(api)) {
    if (key === 'isDesktop' || key === 'bridgeVersion') continue
    assert.equal(typeof value, 'function', key)
    assert.notEqual(value, fake.electron.ipcRenderer.invoke, key)
  }
  assert.ok(!Object.values(api).includes(fake.electron.ipcRenderer))
})

test('listeners get the payload only, never the IPC event, and unsubscribe cleanly', () => {
  for (const [method, channel, payload] of SUBSCRIPTIONS) {
    const { fake, api } = loadPreload()
    const calls = []
    const off = api[method]((...args) => calls.push(args))
    assert.equal(typeof off, 'function')
    assert.equal(fake.rendererListenerCount(channel), 1)
    const ipcEvent = { sender: 'SECRET', senderFrame: 'SECRET', ports: [] }
    fake.rendererEmit(channel, ipcEvent, payload)
    assert.deepEqual(calls, [[payload]], method)
    off()
    off() // a second call does nothing
    assert.equal(fake.rendererListenerCount(channel), 0)
    fake.rendererEmit(channel, ipcEvent, payload)
    assert.equal(calls.length, 1)
  }
})

test('several listeners share one IPC listener and a failing one does not stop the rest', (t) => {
  const { fake, api } = loadPreload()
  t.mock.method(console, 'error', () => {})
  const seen = []
  const offA = api.onHotkey(() => {
    throw new Error('page bug')
  })
  const offB = api.onHotkey((payload) => seen.push(payload.via))
  assert.equal(fake.rendererListenerCount(DESKTOP_IPC.hotkey), 1)
  fake.rendererEmit(DESKTOP_IPC.hotkey, {}, { at: 1, via: 'hotkey', accelerator: 'Control+Alt+C' })
  assert.deepEqual(seen, ['hotkey'])
  assert.equal(console.error.mock.callCount(), 1)
  offA()
  assert.equal(fake.rendererListenerCount(DESKTOP_IPC.hotkey), 1)
  fake.rendererEmit(DESKTOP_IPC.hotkey, {}, { at: 2, via: 'tray', accelerator: null })
  assert.deepEqual(seen, ['hotkey', 'tray'])
  offB()
  assert.equal(fake.rendererListenerCount(DESKTOP_IPC.hotkey), 0)
  // The same function subscribed twice gets two independent subscriptions.
  const twice = []
  const fn = (payload) => twice.push(payload)
  const off1 = api.onCommand(fn)
  const off2 = api.onCommand(fn)
  fake.rendererEmit(DESKTOP_IPC.command, {}, 'resume')
  assert.deepEqual(twice, ['resume', 'resume'])
  off1()
  fake.rendererEmit(DESKTOP_IPC.command, {}, 'pause')
  assert.deepEqual(twice, ['resume', 'resume', 'pause'])
  off2()
})

test('a listener that is not a function is ignored', () => {
  const { fake, api } = loadPreload()
  const off = api.onViewChange('not a function')
  assert.equal(typeof off, 'function')
  off()
  assert.equal(fake.rendererListenerCount(DESKTOP_IPC.viewChanged), 0)
})

test('calls go to the contract channels with plain arguments', async () => {
  const hotkey = { accelerator: 'Control+Alt+C', registered: true, error: null }
  const results = {
    [DESKTOP_IPC.getView]: () => 'compact',
    [DESKTOP_IPC.setView]: (view) => view,
    [DESKTOP_IPC.getHotkey]: () => hotkey,
    [DESKTOP_IPC.setHotkey]: (accelerator) => ({ ...hotkey, accelerator }),
    [DESKTOP_IPC.copyText]: () => true,
    [DESKTOP_IPC.setTrayState]: () => 'ignored',
    [DESKTOP_IPC.showPanel]: () => 'ignored',
    [DESKTOP_IPC.hide]: () => 'ignored'
  }
  const { fake, api } = loadPreload({ invokeResult: (channel, ...args) => results[channel](...args) })
  const last = () => fake.state.invokes[fake.state.invokes.length - 1]

  assert.equal(await api.getView(), 'compact')
  assert.deepEqual(last(), [DESKTOP_IPC.getView])
  assert.equal(await api.setView('full'), 'full')
  assert.deepEqual(last(), [DESKTOP_IPC.setView, 'full'])
  assert.deepEqual(await api.getHotkey(), hotkey)
  assert.deepEqual(last(), [DESKTOP_IPC.getHotkey])
  assert.deepEqual(await api.setHotkey('Control+Shift+Space'), { ...hotkey, accelerator: 'Control+Shift+Space' })
  assert.deepEqual(last(), [DESKTOP_IPC.setHotkey, 'Control+Shift+Space'])

  assert.equal(await api.setTrayState({ listening: true, problem: 'Stopped hearing system audio' }), undefined)
  assert.deepEqual(last(), [DESKTOP_IPC.setTrayState, { listening: true, problem: 'Stopped hearing system audio' }])
  await api.setTrayState({ listening: 1, problem: 5, extra: 'dropped' })
  assert.deepEqual(last(), [DESKTOP_IPC.setTrayState, { listening: true, problem: null }])

  assert.equal(await api.showPanel(), undefined)
  assert.deepEqual(last(), [DESKTOP_IPC.showPanel, { focus: false }])
  await api.showPanel({ focus: true })
  assert.deepEqual(last(), [DESKTOP_IPC.showPanel, { focus: true }])
  await api.showPanel({ focus: 'yes' })
  assert.deepEqual(last(), [DESKTOP_IPC.showPanel, { focus: false }])

  const before = fake.state.invokes.length
  assert.equal(await api.copyText(42), false)
  assert.equal(fake.state.invokes.length, before)
  assert.equal(await api.copyText('Sorry, was that fifteen, one five?'), true)
  assert.deepEqual(last(), [DESKTOP_IPC.copyText, 'Sorry, was that fifteen, one five?'])

  assert.equal(await api.hideWindow(), undefined)
  assert.deepEqual(last(), [DESKTOP_IPC.hide])
})

test('the preload stays sandbox safe', () => {
  const source = fs.readFileSync(path.join(DESKTOP_DIR, 'preload.js'), 'utf8')
  const required = [...source.matchAll(/require\(\s*(['"])([^'"]+)\1\s*\)/g)].map((m) => m[2])
  assert.deepEqual(required, ['electron'])
  assert.ok(!/\bprocess\.|\bBuffer\b|\bsetImmediate\b/.test(source), 'no Node globals in a sandboxed preload')
  assert.ok(!/exposeInMainWorld\([^)]*ipcRenderer\s*\)/.test(source), 'ipcRenderer itself is never exposed')
})
