'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')
const { DESKTOP_HOTKEY_PRESETS, DESKTOP_IPC } = require('../contract')
const { trayIconPng } = require('../tray-icon')
const { DESKTOP_DIR, createFakeElectron, loadWithElectron } = require('./helpers/fake-electron')

const ORIGIN = 'http://localhost:3000'
const NOW = 1762000000000
const ENV_KEYS = ['CATCHUP_URL', 'CATCHUP_VIDEO_SOURCE', 'CATCHUP_DEVTOOLS']
const INVOKE_CHANNELS = ['getView', 'setView', 'getHotkey', 'setHotkey', 'setTrayState', 'showPanel', 'copyText', 'hide']
const PUSH_CHANNELS = ['hotkey', 'hotkeyChanged', 'command', 'viewChanged']

const mockedTests = new WeakSet()

async function boot (t, options = {}) {
  if (!mockedTests.has(t)) {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW })
    mockedTests.add(t)
  }
  const saved = {}
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key]
    const value = options.env && options.env[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  const fake = createFakeElectron(options)
  t.after(() => fake.cleanup())
  let main
  try {
    main = loadWithElectron('main.js', fake.electron)
    await fake.ready()
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  }
  return { fake, main, win: fake.window(), tray: fake.tray() }
}

function pageEvent (win, frame = {}) {
  return { sender: win.webContents, senderFrame: { parent: null, origin: ORIGIN, url: ORIGIN + '/', ...frame } }
}

async function invoke (fake, channel, event, ...args) {
  const handler = fake.state.handlers.get(channel)
  assert.ok(handler, 'no handler for ' + channel)
  return handler(event, ...args)
}

function menuItem (tray, label) {
  const item = tray.menu.items.find((entry) => entry.label === label)
  assert.ok(item, 'no tray item ' + label)
  return item
}

function hotkeyMenu (tray) {
  return tray.menu.items.find((entry) => Array.isArray(entry.submenu))
}

function settingsOf (fake) {
  return JSON.parse(fs.readFileSync(path.join(fake.state.userData, 'catch-up-desktop.json'), 'utf8'))
}

function tempUserData (t, settings) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catch-up-desktop-test-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  if (settings) fs.writeFileSync(path.join(dir, 'catch-up-desktop.json'), JSON.stringify(settings))
  return dir
}

test('opens one compact panel that never takes focus, with safe web preferences', async (t) => {
  const { fake, win } = await boot(t)
  assert.equal(fake.state.windows.length, 1)
  const o = win.opts
  assert.deepEqual([o.width, o.height], [360, 480])
  assert.deepEqual([o.x, o.y], [1920 - 360 - 16, 1040 - 480 - 16], 'bottom right, 16 px above the taskbar')
  assert.equal(o.frame, false)
  assert.equal(o.roundedCorners, true)
  assert.equal(o.focusable, false)
  assert.equal(o.skipTaskbar, true)
  assert.equal(o.alwaysOnTop, true)
  assert.equal(o.resizable, false)
  assert.equal(o.show, false)
  assert.equal(win.level, 'screen-saver')
  const prefs = o.webPreferences
  assert.equal(prefs.contextIsolation, true)
  assert.equal(prefs.sandbox, true)
  assert.equal(prefs.nodeIntegration, false)
  assert.equal(prefs.nodeIntegrationInSubFrames, false)
  assert.equal(prefs.webviewTag, false)
  assert.equal(prefs.backgroundThrottling, false)
  assert.equal(prefs.preload, path.join(DESKTOP_DIR, 'preload.js'))
  assert.equal(o.backgroundColor, '#FAFAF7')
  assert.deepEqual(win.webContents.loads, [{ kind: 'url', url: ORIGIN + '/' }])
  assert.equal(win.visible, false)
  assert.equal(fake.state.appUserModelId, 'dev.catchup.desktop')
})

test('re-applies the panel size on the first show and shows it without focus', async (t) => {
  const { win } = await boot(t)
  win.bounds = { x: 1544, y: 544, width: 362, height: 482 } // as if it came up 2 px large
  win.emit('ready-to-show')
  assert.deepEqual(win.getBounds(), { x: 1544, y: 544, width: 360, height: 480 })
  assert.equal(win.resizable, false)
  assert.equal(win.visible, true)
  assert.equal(win.shownInactive, true)
  assert.equal(win.focused, false)
})

test('shows the panel after a short wait even when the page is slow to paint', async (t) => {
  const { win } = await boot(t)
  t.mock.timers.tick(2500)
  assert.equal(win.visible, true)
  assert.equal(win.shownInactive, true)
})

test('follows a dark system theme for the window background', async (t) => {
  const { win } = await boot(t, { dark: true })
  assert.equal(win.opts.backgroundColor, '#121316')
})

test('registers Ctrl+Alt+C at startup and tells the page', async (t) => {
  const { fake, win } = await boot(t)
  assert.deepEqual([...fake.state.registered.keys()], ['Control+Alt+C'])
  const state = { accelerator: 'Control+Alt+C', registered: true, error: null }
  assert.deepEqual(fake.sentOn(DESKTOP_IPC.hotkeyChanged), [state])
  assert.deepEqual(await invoke(fake, DESKTOP_IPC.getHotkey, pageEvent(win)), state)
})

test('a hotkey press shows the panel without focus and sends one press payload', async (t) => {
  const { fake, win } = await boot(t)
  win.emit('ready-to-show')
  win.hide()
  fake.state.registered.get('Control+Alt+C')()
  assert.equal(win.visible, true)
  assert.equal(win.shownInactive, true)
  assert.equal(win.focused, false)
  assert.ok(win.moveTopCalls > 0)
  assert.equal(win.level, 'screen-saver')
  assert.deepEqual(fake.sentOn(DESKTOP_IPC.hotkey), [{ at: NOW, via: 'hotkey', accelerator: 'Control+Alt+C' }])
})

test('a held hotkey counts once, and a new press after a quiet 700 ms counts again', async (t) => {
  const { fake } = await boot(t)
  const pressKey = fake.state.registered.get('Control+Alt+C')
  pressKey()
  for (let i = 0; i < 4; i++) {
    t.mock.timers.tick(300) // Windows repeats the hotkey while it is held
    pressKey()
  }
  assert.equal(fake.sentOn(DESKTOP_IPC.hotkey).length, 1)
  t.mock.timers.tick(800)
  pressKey()
  const presses = fake.sentOn(DESKTOP_IPC.hotkey)
  assert.equal(presses.length, 2)
  assert.equal(presses[1].at, NOW + 2000)
})

test('tray Catch me up sends the same press with via tray and no accelerator', async (t) => {
  const { fake, win, tray } = await boot(t)
  const item = menuItem(tray, 'Catch me up')
  assert.equal(item.accelerator, 'Control+Alt+C')
  assert.equal(item.registerAccelerator, false)
  win.hide()
  t.mock.timers.tick(5)
  item.click()
  assert.equal(win.visible, true)
  assert.equal(win.focused, false)
  assert.deepEqual(fake.sentOn(DESKTOP_IPC.hotkey), [{ at: NOW + 5, via: 'tray', accelerator: null }])
})

test('falls back to the next preset when Ctrl+Alt+C is taken, with a tray badge', async (t) => {
  const { fake, tray } = await boot(t, { taken: ['Control+Alt+C'] })
  assert.deepEqual([...fake.state.registered.keys()], ['Control+Shift+Space'])
  const [state] = fake.sentOn(DESKTOP_IPC.hotkeyChanged)
  assert.equal(state.accelerator, 'Control+Shift+Space')
  assert.equal(state.registered, true)
  assert.equal(state.error, 'Ctrl+Alt+C is in use by another app, so Ctrl+Shift+Space is on instead.')
  assert.equal(hotkeyMenu(tray).label, 'Hotkey Ctrl+Shift+Space')
  assert.deepEqual(hotkeyMenu(tray).submenu.filter((item) => item.checked).map((item) => item.label), ['Ctrl+Shift+Space'])
  assert.equal(tray.tooltip, 'Catch Up · Not listening · Ctrl+Shift+Space')
  assert.deepEqual(tray.image.png, trayIconPng({ listening: false, problem: true }, 1))
  fake.state.registered.get('Control+Shift+Space')()
  assert.equal(fake.sentOn(DESKTOP_IPC.hotkey)[0].accelerator, 'Control+Shift+Space')
})

test('says so when no preset is free', async (t) => {
  const { fake, tray } = await boot(t, { taken: [...DESKTOP_HOTKEY_PRESETS] })
  assert.equal(fake.state.registered.size, 0)
  const [state] = fake.sentOn(DESKTOP_IPC.hotkeyChanged)
  assert.deepEqual(
    state,
    {
      accelerator: null,
      registered: false,
      error: 'Ctrl+Alt+C, Ctrl+Shift+Space and Ctrl+Alt+Space are all in use by other apps. Close one of those apps, then pick a hotkey again.'
    }
  )
  assert.equal(hotkeyMenu(tray).label, 'Hotkey not set')
  assert.equal(menuItem(tray, 'Catch me up').accelerator, undefined)
  assert.equal(tray.tooltip, 'Catch Up · Not listening · No hotkey')
})

test('a tray preset pick switches the hotkey, tells the page and is remembered', async (t) => {
  const { fake, tray } = await boot(t)
  fake.state.sent.length = 0
  hotkeyMenu(tray).submenu.find((item) => item.label === 'Ctrl+Alt+Space').click()
  assert.deepEqual([...fake.state.registered.keys()], ['Control+Alt+Space'])
  assert.deepEqual(fake.sentOn(DESKTOP_IPC.hotkeyChanged), [{ accelerator: 'Control+Alt+Space', registered: true, error: null }])
  assert.equal(hotkeyMenu(fake.tray()).label, 'Hotkey Ctrl+Alt+Space')
  t.mock.timers.tick(500)
  assert.equal(settingsOf(fake).hotkey, 'Control+Alt+Space')
})

test('the next start tries the remembered hotkey and panel spot first', async (t) => {
  const userData = tempUserData(t, { version: 1, hotkey: 'Control+Shift+Space', panel: { x: 100, y: 120 } })
  const { fake, win } = await boot(t, { userData })
  assert.deepEqual([...fake.state.registered.keys()], ['Control+Shift+Space'])
  assert.equal(fake.sentOn(DESKTOP_IPC.hotkeyChanged)[0].error, null)
  assert.deepEqual([win.opts.x, win.opts.y], [100, 120])
})

test('a remembered spot that is off screen comes back onto the screen', async (t) => {
  const userData = tempUserData(t, { version: 1, hotkey: 'Alt+Space', panel: { x: 5000, y: -300 } })
  const { fake, win } = await boot(t, { userData })
  assert.deepEqual([win.opts.x, win.opts.y], [1920 - 360, 0])
  assert.deepEqual([...fake.state.registered.keys()], ['Control+Alt+C'], 'an unknown saved hotkey is ignored')
})

test('setHotkey from the page keeps the current hotkey when the new one is taken', async (t) => {
  const { fake, win } = await boot(t)
  fake.taken.add('Control+Shift+Space')
  fake.state.sent.length = 0
  let state = await invoke(fake, DESKTOP_IPC.setHotkey, pageEvent(win), 'Control+Shift+Space')
  assert.deepEqual(state, {
    accelerator: 'Control+Alt+C',
    registered: true,
    error: 'Ctrl+Shift+Space is in use by another app. Ctrl+Alt+C stays on.'
  })
  assert.deepEqual([...fake.state.registered.keys()], ['Control+Alt+C'])
  assert.deepEqual(fake.sentOn(DESKTOP_IPC.hotkeyChanged), [state])
  assert.deepEqual(fake.tray().image.png, trayIconPng({ listening: false, problem: true }, 1))

  state = await invoke(fake, DESKTOP_IPC.setHotkey, pageEvent(win), 'Control+Alt+Space')
  assert.deepEqual(state, { accelerator: 'Control+Alt+Space', registered: true, error: null })
  assert.deepEqual([...fake.state.registered.keys()], ['Control+Alt+Space'])
  assert.deepEqual(fake.tray().image.png, trayIconPng({ listening: false, problem: false }, 1))

  for (const bad of ['Alt+Space', 'Control+Alt+Q', 'Control+Alt+Up', 'Super+C', 'C', 'Control+F12', 42, null]) {
    await assert.rejects(invoke(fake, DESKTOP_IPC.setHotkey, pageEvent(win), bad), /preset/)
  }
  assert.deepEqual([...fake.state.registered.keys()], ['Control+Alt+Space'])
})

test('setHotkey reports when nothing could stay registered', async (t) => {
  const { fake, win } = await boot(t, { taken: [...DESKTOP_HOTKEY_PRESETS] })
  const state = await invoke(fake, DESKTOP_IPC.setHotkey, pageEvent(win), 'Control+Alt+Space')
  assert.deepEqual(state, {
    accelerator: null,
    registered: false,
    error: 'Ctrl+Alt+Space is in use by another app. No hotkey is on right now.'
  })
})

test('answers IPC only for the top frame of its own window on the app origin', async (t) => {
  const { fake, win } = await boot(t)
  assert.deepEqual([...fake.state.handlers.keys()].sort(), INVOKE_CHANNELS.map((key) => DESKTOP_IPC[key]).sort())
  for (const key of PUSH_CHANNELS) assert.ok(!fake.state.handlers.has(DESKTOP_IPC[key]), key + ' is main to page only')
  const refused = [
    { sender: win.webContents, senderFrame: { parent: null, origin: 'https://evil.example', url: 'https://evil.example/' } },
    { sender: win.webContents, senderFrame: { parent: {}, origin: ORIGIN, url: ORIGIN + '/frame' } },
    { sender: win.webContents, senderFrame: null },
    { sender: { other: true }, senderFrame: { parent: null, origin: ORIGIN, url: ORIGIN + '/' } },
    { sender: win.webContents, senderFrame: { parent: null, origin: 'file://', url: 'file:///C:/elsewhere/page.html' } }
  ]
  for (const key of INVOKE_CHANNELS) {
    for (const event of refused) {
      await assert.rejects(invoke(fake, DESKTOP_IPC[key], event, 'compact'), /Refused/, key)
    }
  }
  assert.equal(fake.state.copied.length, 0)
})

test('the offline page may hide the window and nothing else', async (t) => {
  const { fake, win } = await boot(t)
  win.emit('ready-to-show')
  const offline = { sender: win.webContents, senderFrame: { parent: null, origin: 'file://', url: 'file:///C:/app/desktop/offline.html?url=x' } }
  await invoke(fake, DESKTOP_IPC.hide, offline)
  assert.equal(win.visible, false)
  await assert.rejects(invoke(fake, DESKTOP_IPC.setView, offline, 'full'), /Refused/)
  await assert.rejects(invoke(fake, DESKTOP_IPC.copyText, offline, 'hi'), /Refused/)
})

test('switches between the compact panel and a focusable Full view', async (t) => {
  const { fake, win } = await boot(t)
  win.emit('ready-to-show')
  fake.state.sent.length = 0
  assert.equal(await invoke(fake, DESKTOP_IPC.getView, pageEvent(win)), 'compact')

  assert.equal(await invoke(fake, DESKTOP_IPC.setView, pageEvent(win), 'full'), 'full')
  assert.equal(win.focusable, true)
  assert.equal(win.skipTaskbar, false)
  assert.equal(win.focused, true)
  assert.deepEqual(win.getBounds(), { x: 1544 + 360 - 480, y: 544 + 480 - 760, width: 480, height: 760 })
  assert.equal(win.resizable, false)
  assert.equal(await invoke(fake, DESKTOP_IPC.getView, pageEvent(win)), 'full')

  assert.equal(await invoke(fake, DESKTOP_IPC.setView, pageEvent(win), 'compact'), 'compact')
  assert.equal(win.focusable, false)
  assert.equal(win.skipTaskbar, true)
  assert.equal(win.focused, false)
  assert.deepEqual(win.getBounds(), { x: 1544, y: 544, width: 360, height: 480 })

  await invoke(fake, DESKTOP_IPC.setView, pageEvent(win), 'compact')
  assert.deepEqual(fake.sentOn(DESKTOP_IPC.viewChanged), ['full', 'compact'])
  await assert.rejects(invoke(fake, DESKTOP_IPC.setView, pageEvent(win), 'mini'), /Unknown view/)
})

test('the tray opens Full view and Show panel brings back the compact panel', async (t) => {
  const { fake, win, tray } = await boot(t)
  win.emit('ready-to-show')
  menuItem(tray, 'Full view').click()
  assert.equal(await invoke(fake, DESKTOP_IPC.getView, pageEvent(win)), 'full')
  assert.equal(win.focused, true)
  menuItem(fake.tray(), 'Show panel').click()
  assert.equal(await invoke(fake, DESKTOP_IPC.getView, pageEvent(win)), 'compact')
  assert.equal(win.focusable, false)
  assert.equal(win.visible, true)
  assert.deepEqual(fake.sentOn(DESKTOP_IPC.viewChanged), ['full', 'compact'])
})

test('Show panel with focus lets keyboard users in until the panel loses focus', async (t) => {
  const { win, tray } = await boot(t)
  win.emit('ready-to-show')
  menuItem(tray, 'Show panel with focus').click()
  assert.equal(win.focusable, true)
  assert.equal(win.focused, true)
  assert.equal(win.skipTaskbar, true)
  assert.equal(win.webContents.focused, true)
  assert.deepEqual(win.getBounds(), { x: 1544, y: 544, width: 360, height: 480 })
  win.emit('blur')
  assert.equal(win.focusable, false)
  assert.equal(win.skipTaskbar, true)
})

test('showPanel from the page shows the window, with focus only when asked', async (t) => {
  const { fake, win } = await boot(t)
  win.emit('ready-to-show')
  win.hide()
  assert.equal(await invoke(fake, DESKTOP_IPC.showPanel, pageEvent(win), {}), undefined)
  assert.equal(win.visible, true)
  assert.equal(win.focused, false)
  assert.equal(win.focusable, false)
  await invoke(fake, DESKTOP_IPC.showPanel, pageEvent(win), { focus: true })
  assert.equal(win.focused, true)
})

test('the tray icon, tooltip and Pause or Resume follow the page', async (t) => {
  const { fake, win, tray } = await boot(t)
  win.emit('ready-to-show')
  assert.deepEqual(tray.image.png, trayIconPng({ listening: false, problem: false }, 1))
  assert.deepEqual(tray.image.opts, { scaleFactor: 1 })
  assert.equal(tray.tooltip, 'Catch Up · Not listening · Ctrl+Alt+C')

  assert.equal(await invoke(fake, DESKTOP_IPC.setTrayState, pageEvent(win), { listening: true, problem: null }), undefined)
  assert.deepEqual(tray.image.png, trayIconPng({ listening: true, problem: false }, 1))
  assert.equal(tray.tooltip, 'Catch Up · Listening · Ctrl+Alt+C')
  menuItem(tray, 'Pause').click()
  assert.deepEqual(fake.sentOn(DESKTOP_IPC.command), ['pause'])

  await invoke(fake, DESKTOP_IPC.setTrayState, pageEvent(win), { listening: false, problem: '  Stopped hearing\n system audio ' })
  assert.deepEqual(tray.image.png, trayIconPng({ listening: false, problem: true }, 1))
  assert.equal(tray.tooltip, 'Catch Up · Not listening · Ctrl+Alt+C · Stopped hearing system audio')
  win.hide()
  menuItem(tray, 'Resume').click()
  assert.deepEqual(fake.sentOn(DESKTOP_IPC.command), ['pause', 'resume'])
  assert.equal(win.visible, true)
  assert.equal(win.focused, false)

  await invoke(fake, DESKTOP_IPC.setTrayState, pageEvent(win), { listening: true, problem: 'x'.repeat(300) })
  assert.ok(tray.tooltip.length <= 127)
  for (const bad of [null, {}, { listening: 'yes' }, { listening: true, problem: 5 }]) {
    await assert.rejects(invoke(fake, DESKTOP_IPC.setTrayState, pageEvent(win), bad), /Tray/)
  }
})

test('draws the tray icon at the display scale', async (t) => {
  const { tray } = await boot(t, { scaleFactor: 1.5 })
  assert.deepEqual(tray.image.png, trayIconPng({ listening: false, problem: false }, 1.5))
  assert.equal(tray.image.png.readUInt32BE(16), 24)
})

test('a tray click shows the panel without focus, and Hide panel hides it', async (t) => {
  const { win, tray } = await boot(t)
  win.emit('ready-to-show')
  win.hide()
  tray.emit('click')
  assert.equal(win.visible, true)
  assert.equal(win.focused, false)
  menuItem(tray, 'Hide panel').click()
  assert.equal(win.visible, false)
})

test('the tray menu holds the spec items in order', async (t) => {
  const { tray } = await boot(t)
  const labels = tray.menu.items.filter((item) => item.type !== 'separator').map((item) => item.label)
  assert.deepEqual(labels, [
    'Catch me up',
    'Resume',
    'Show panel',
    'Show panel with focus',
    'Full view',
    'Hide panel',
    'Hotkey Ctrl+Alt+C',
    'Quit Catch Up'
  ])
  assert.deepEqual(
    hotkeyMenu(tray).submenu.map((item) => [item.label, item.type]),
    [
      ['Ctrl+Alt+C', 'radio'],
      ['Ctrl+Shift+Space', 'radio'],
      ['Ctrl+Alt+Space', 'radio']
    ]
  )
})

test('copyText copies through the main process', async (t) => {
  const { fake, win } = await boot(t)
  const line = 'Just to check, Thursday for the demo, or push to Monday?'
  assert.equal(await invoke(fake, DESKTOP_IPC.copyText, pageEvent(win), line), true)
  assert.deepEqual(fake.state.copied, [line])
  for (const bad of ['', 42, null, 'x'.repeat(16001)]) {
    assert.equal(await invoke(fake, DESKTOP_IPC.copyText, pageEvent(win), bad), false)
  }
  assert.deepEqual(fake.state.copied, [line])
})

test('hideWindow hides the panel', async (t) => {
  const { fake, win } = await boot(t)
  win.emit('ready-to-show')
  assert.equal(await invoke(fake, DESKTOP_IPC.hide, pageEvent(win)), undefined)
  assert.equal(win.visible, false)
})

test('grants the microphone and system audio to the app origin only', async (t) => {
  const { fake, win } = await boot(t)
  win.webContents.url = ORIGIN + '/'
  const ask = (permission, details) =>
    new Promise((resolve) => fake.state.permissionRequest(win.webContents, permission, resolve, details))
  const main = { requestingUrl: ORIGIN + '/', isMainFrame: true }
  assert.equal(await ask('display-capture', { ...main, mediaTypes: ['video', 'audio'] }), true)
  assert.equal(await ask('media', { ...main, mediaTypes: ['audio'] }), true)
  assert.equal(await ask('media', { ...main, mediaTypes: ['video'] }), false)
  assert.equal(await ask('media', { ...main, mediaTypes: ['audio', 'video'] }), false)
  assert.equal(await ask('media', { ...main, mediaTypes: [] }), false)
  assert.equal(await ask('clipboard-sanitized-write', main), true)
  for (const other of ['clipboard-read', 'notifications', 'geolocation', 'fullscreen', 'openExternal', 'hid']) {
    assert.equal(await ask(other, main), false, other)
  }
  assert.equal(await ask('display-capture', { requestingUrl: ORIGIN + '/', isMainFrame: false, mediaTypes: ['video'] }), false)
  assert.equal(await ask('display-capture', { requestingUrl: 'https://evil.example/', isMainFrame: true }), false)
  assert.equal(await ask('media', { requestingUrl: 'http://localhost:3001/', isMainFrame: true, mediaTypes: ['audio'] }), false)
  assert.equal(await ask('media', { isMainFrame: true, mediaTypes: ['audio'] }), true, 'falls back to the page URL')

  const check = fake.state.permissionCheck
  assert.equal(check(null, 'media', ORIGIN, { mediaType: 'audio', isMainFrame: true }), true)
  assert.equal(check(null, 'media', ORIGIN, { mediaType: 'video', isMainFrame: true }), false)
  assert.equal(check(null, 'display-capture', ORIGIN, { isMainFrame: true }), true)
  assert.equal(check(null, 'display-capture', 'https://evil.example', { isMainFrame: true }), false)
  assert.equal(check(null, 'geolocation', ORIGIN, { isMainFrame: true }), false)
})

test('grants system audio with the page as the video, or a screen when there is no frame', async (t) => {
  const { fake } = await boot(t)
  const grant = (request) => new Promise((resolve) => fake.state.displayMedia(request, resolve))
  const frame = { parent: null, origin: ORIGIN, isDestroyed: () => false }
  const base = { securityOrigin: ORIGIN + '/', videoRequested: true, audioRequested: true, userGesture: false }

  let streams = await grant({ ...base, frame })
  assert.equal(streams.video, frame)
  assert.equal(streams.audio, 'loopback')
  assert.equal(fake.state.capturerCalls.length, 0, 'the desktop is not captured')

  streams = await grant({ ...base, frame: null })
  assert.deepEqual(streams, { video: { id: 'screen:0:0', name: 'Entire screen' }, audio: 'loopback' })
  assert.deepEqual(fake.state.capturerCalls[0], { types: ['screen'], thumbnailSize: { width: 0, height: 0 } })

  streams = await grant({ ...base, frame: { ...frame, isDestroyed: () => true } })
  assert.equal(streams.video.id, 'screen:0:0')

  streams = await grant({ ...base, audioRequested: false, frame })
  assert.deepEqual(Object.keys(streams), ['video'])

  assert.equal(await grant({ ...base, frame: { ...frame, parent: frame } }), null, 'no grant for an iframe')
  assert.equal(await grant({ ...base, frame: { ...frame, origin: 'https://evil.example' } }), null)
  assert.equal(await grant({ ...base, securityOrigin: 'https://evil.example', frame }), null)
  assert.equal(await grant({ ...base, securityOrigin: 'null', frame }), null)
  assert.equal(await grant({ ...base, videoRequested: false, audioRequested: false, frame }), null)
})

test('CATCHUP_VIDEO_SOURCE=screen grants a screen as the video', async (t) => {
  const { fake } = await boot(t, { env: { CATCHUP_VIDEO_SOURCE: 'screen' } })
  const frame = { parent: null, origin: ORIGIN, isDestroyed: () => false }
  const streams = await new Promise((resolve) =>
    fake.state.displayMedia({ securityOrigin: ORIGIN, videoRequested: true, audioRequested: true, frame }, resolve)
  )
  assert.deepEqual(streams, { video: { id: 'screen:0:0', name: 'Entire screen' }, audio: 'loopback' })
})

test('keeps every page load on the app origin and opens https links in the browser', async (t) => {
  const { fake, win } = await boot(t)
  const contents = win.webContents
  const navigate = (url) => {
    let prevented = false
    contents.emit('will-navigate', { url, isMainFrame: true, preventDefault: () => { prevented = true } })
    return prevented
  }
  assert.equal(navigate(ORIGIN + '/settings'), false)
  assert.equal(navigate('https://example.com/terms'), true)
  for (const url of ['javascript:alert(1)', 'file:///C:/Windows/win.ini', 'http://example.com/', 'data:text/html,hi']) {
    assert.equal(navigate(url), true, url)
  }
  assert.deepEqual(fake.state.opened, ['https://example.com/terms'])

  assert.deepEqual(contents.windowOpenHandler({ url: 'https://ai.meta.com/' }), { action: 'deny' })
  assert.deepEqual(contents.windowOpenHandler({ url: ORIGIN + '/popup' }), { action: 'deny' })
  assert.deepEqual(fake.state.opened, ['https://example.com/terms', 'https://ai.meta.com/'])

  const redirect = (url, isMainFrame) => {
    let prevented = false
    contents.emit('will-redirect', { url, isMainFrame, preventDefault: () => { prevented = true } })
    return prevented
  }
  assert.equal(redirect(ORIGIN + '/app', true), false)
  assert.equal(redirect('https://vercel.com/login', false), false)
  assert.equal(redirect('https://vercel.com/login', true), true)
  const last = contents.loads[contents.loads.length - 1]
  assert.equal(last.kind, 'file')
  assert.deepEqual(last.query, { url: ORIGIN + '/', reason: 'redirect' })

  let blocked = false
  contents.emit('will-attach-webview', { preventDefault: () => { blocked = true } })
  assert.ok(blocked)
})

test('shows the offline page when the app cannot load', async (t) => {
  const { win } = await boot(t)
  const contents = win.webContents
  const fail = (code, url, isMainFrame = true) => contents.emit('did-fail-load', {}, code, 'error', url, isMainFrame, 1, 1)
  fail(-3, ORIGIN + '/')
  fail(-102, ORIGIN + '/', false)
  fail(-6, 'file:///C:/app/desktop/offline.html')
  assert.equal(contents.loads.length, 1)
  fail(-102, ORIGIN + '/')
  const last = contents.loads[contents.loads.length - 1]
  assert.equal(last.kind, 'file')
  assert.equal(last.file, path.join(DESKTOP_DIR, 'offline.html'))
  assert.deepEqual(last.query, { url: ORIGIN + '/', reason: 'offline' })
  assert.ok(fs.existsSync(last.file))
})

test('repeats the hotkey and view state when the app page loads, and forgets old tray state', async (t) => {
  const { fake, win, tray } = await boot(t)
  const contents = win.webContents
  fake.state.sent.length = 0
  contents.url = ORIGIN + '/'
  contents.emit('did-finish-load')
  assert.deepEqual(fake.sentOn(DESKTOP_IPC.hotkeyChanged), [{ accelerator: 'Control+Alt+C', registered: true, error: null }])
  assert.deepEqual(fake.sentOn(DESKTOP_IPC.viewChanged), ['compact'])
  contents.url = 'file:///C:/app/desktop/offline.html'
  contents.emit('did-finish-load')
  assert.equal(fake.sentOn(DESKTOP_IPC.viewChanged).length, 1)

  await invoke(fake, DESKTOP_IPC.setTrayState, pageEvent(win), { listening: true, problem: null })
  assert.equal(tray.tooltip, 'Catch Up · Listening · Ctrl+Alt+C')
  contents.emit('did-navigate', {}, ORIGIN + '/', 200, 'OK')
  assert.equal(tray.tooltip, 'Catch Up · Not listening · Ctrl+Alt+C')
  menuItem(tray, 'Resume')
})

test('reloads a crashed page, and stops after repeated crashes', async (t) => {
  const { win } = await boot(t)
  const contents = win.webContents
  for (let i = 1; i <= 3; i++) {
    contents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 })
    t.mock.timers.tick(1000)
    assert.equal(contents.loads.length, 1 + i)
    assert.deepEqual(contents.loads[i], { kind: 'url', url: ORIGIN + '/' })
  }
  contents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 })
  const last = contents.loads[contents.loads.length - 1]
  assert.equal(last.kind, 'file')
  assert.equal(last.query.reason, 'crashed')
  t.mock.timers.tick(5000)
  assert.equal(contents.loads[contents.loads.length - 1].kind, 'file')
})

test('remembers where the compact panel was left, also across Full view', async (t) => {
  const { fake, win } = await boot(t)
  win.emit('ready-to-show')
  win.bounds = { x: 300, y: 200, width: 360, height: 480 }
  win.emit('moved')
  t.mock.timers.tick(500)
  assert.deepEqual(settingsOf(fake).panel, { x: 300, y: 200 })

  await invoke(fake, DESKTOP_IPC.setView, pageEvent(win), 'full')
  assert.deepEqual(win.getBounds(), { x: 180, y: 0, width: 480, height: 760 }, 'kept inside the work area')
  win.bounds = { x: 600, y: 100, width: 480, height: 760 }
  win.emit('moved')
  await invoke(fake, DESKTOP_IPC.setView, pageEvent(win), 'compact')
  assert.deepEqual(win.getBounds(), { x: 300, y: 200, width: 360, height: 480 })
  t.mock.timers.tick(500)
  assert.deepEqual(settingsOf(fake).panel, { x: 300, y: 200 })
})

test('keeps the panel on screen when a display goes away', async (t) => {
  const { fake, win } = await boot(t)
  win.emit('ready-to-show')
  fake.state.workArea = { x: 0, y: 0, width: 1280, height: 680 }
  fake.emitScreen('display-removed')
  assert.deepEqual(win.getBounds(), { x: 1280 - 360 - 16, y: 680 - 480 - 16, width: 360, height: 480 })
})

test('closing hides to the tray, and Quit really quits', async (t) => {
  const { fake, win, tray } = await boot(t)
  win.emit('ready-to-show')
  let prevented = false
  win.emit('close', { preventDefault: () => { prevented = true } })
  assert.ok(prevented)
  assert.equal(win.visible, false)

  menuItem(tray, 'Quit Catch Up').click()
  assert.equal(fake.state.quitCalls, 1)
  fake.emitApp('before-quit')
  assert.deepEqual(settingsOf(fake), { version: 1, hotkey: 'Control+Alt+C', hotkeyPicked: false, panel: { x: 1544, y: 544 } })
  prevented = false
  win.emit('close', { preventDefault: () => { prevented = true } })
  assert.equal(prevented, false)
  fake.emitApp('will-quit')
  assert.equal(fake.state.registered.size, 0)
  assert.equal(tray.destroyed, true)
})

test('Quit wins over the page asking to stay, and other unloads are left to the page', async (t) => {
  const { win, tray } = await boot(t)
  let allowed = false
  win.webContents.emit('will-prevent-unload', { preventDefault: () => { allowed = true } })
  assert.equal(allowed, false)
  menuItem(tray, 'Quit Catch Up').click()
  win.webContents.emit('will-prevent-unload', { preventDefault: () => { allowed = true } })
  assert.equal(allowed, true)
})

test('starts on Ctrl+Shift+Space where AltGr+C types a character, and says why', async (t) => {
  const { fake, tray } = await boot(t, { languages: ['pl-PL', 'en-US'] })
  assert.deepEqual([...fake.state.registered.keys()], ['Control+Shift+Space'])
  const [state] = fake.sentOn(DESKTOP_IPC.hotkeyChanged)
  assert.equal(state.accelerator, 'Control+Shift+Space')
  assert.match(state.error, /instead of Ctrl\+Alt\+C, because AltGr\+C types a character/)
  assert.equal(hotkeyMenu(tray).label, 'Hotkey Ctrl+Shift+Space')
})

test('a hotkey the person picked is kept on an AltGr keyboard', async (t) => {
  const userData = tempUserData(t, { version: 1, hotkey: 'Control+Alt+C', hotkeyPicked: true, panel: null })
  const { fake } = await boot(t, { userData, languages: ['hu-HU'] })
  assert.deepEqual([...fake.state.registered.keys()], ['Control+Alt+C'])
  assert.equal(fake.sentOn(DESKTOP_IPC.hotkeyChanged)[0].error, null)
})

test('a second start shows the running panel instead', async (t) => {
  const { fake, win } = await boot(t)
  win.emit('ready-to-show')
  win.hide()
  fake.emitApp('second-instance', {}, [], DESKTOP_DIR)
  assert.equal(win.visible, true)
  assert.equal(win.focused, false)
})

test('only one copy runs', async (t) => {
  const { fake } = await boot(t, { singleInstance: false })
  assert.equal(fake.state.quitCalls, 1)
  assert.equal(fake.state.windows.length, 0)
  assert.equal(fake.state.handlers.size, 0)
})

test('loads an https CATCHUP_URL and limits permissions to that origin', async (t) => {
  const { fake, win } = await boot(t, { env: { CATCHUP_URL: 'https://catch-up.example.com/app' } })
  assert.deepEqual(win.webContents.loads, [{ kind: 'url', url: 'https://catch-up.example.com/app' }])
  const ask = (url) =>
    new Promise((resolve) =>
      fake.state.permissionRequest(win.webContents, 'display-capture', resolve, { requestingUrl: url, isMainFrame: true })
    )
  assert.equal(await ask('https://catch-up.example.com/'), true)
  assert.equal(await ask(ORIGIN + '/'), false)
})

test('refuses a CATCHUP_URL that is not https or local http', async (t) => {
  for (const url of ['http://192.168.1.20:3000', 'https://user:secret@example.com', 'ftp://localhost/', 'localhost:3000', 'not a url']) {
    const { fake, main } = await boot(t, { env: { CATCHUP_URL: url } })
    assert.equal(fake.state.windows.length, 0, url)
    assert.equal(fake.state.quitCalls, 1, url)
    assert.deepEqual(fake.state.errorBoxes, [{ title: 'Catch Up', content: main.COPY.badUrl }], url)
  }
})

test('local http addresses are accepted while running from source, never when packaged', async (t) => {
  const { main } = await boot(t)
  for (const url of ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000', 'http://catch-up.localhost:3000']) {
    assert.ok(main.resolveAppUrl(url, false).url, url)
    assert.equal(main.resolveAppUrl(url, true).url, null, url)
  }
  assert.equal(main.resolveAppUrl('http://localhost.evil.example:3000', false).url, null)
  assert.ok(main.resolveAppUrl('https://catch-up.vercel.app', true).url)
})

test('CATCHUP_DEVTOOLS=1 opens DevTools in their own window', async (t) => {
  const { win } = await boot(t, { env: { CATCHUP_DEVTOOLS: '1' } })
  assert.equal(win.webContents.devToolsOpened, 1)
})

test('never hides the panel from screen capture', async (t) => {
  const { fake, win, tray } = await boot(t)
  win.emit('ready-to-show')
  menuItem(tray, 'Full view').click()
  menuItem(fake.tray(), 'Show panel with focus').click()
  fake.state.registered.get('Control+Alt+C')()
  assert.equal(fake.state.contentProtectionCalls, 0)
  const source = fs.readFileSync(path.join(DESKTOP_DIR, 'main.js'), 'utf8')
  assert.ok(!source.includes('setContentProtection'))
  assert.ok(!source.includes("'loopbackWithMute'"))
})
