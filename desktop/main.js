'use strict'
// Catch Up for Windows. A thin Electron 45 shell around the Catch Up web app. It adds a global
// hotkey, a compact always-on-top panel that never takes focus from a call, system audio without
// the share picker, and a tray icon. Audio stays in the page's memory, as it does in a browser tab.
// This process never sees audio or transcripts. Text the page copies passes through to the
// clipboard and is not kept or logged.

const fs = require('node:fs')
const path = require('node:path')
const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  clipboard,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  nativeImage,
  nativeTheme,
  screen,
  session,
  shell
} = require('electron')
const { DESKTOP_HOTKEY_PRESETS, DESKTOP_IPC, DESKTOP_VIEWS } = require('./contract')
const { trayIconPng } = require('./tray-icon')

const DEFAULT_URL = 'http://localhost:3000'
const APP_USER_MODEL_ID = 'dev.catchup.desktop'
const COMPACT_SIZE = Object.freeze({ width: 360, height: 480 })
const FULL_SIZE = Object.freeze({ width: 480, height: 760 })
const EDGE_GAP = 16 // from the right edge of the work area and above the taskbar
const HOTKEY_DEBOUNCE_MS = 700 // Windows registers hotkeys without MOD_NOREPEAT, so a held combo repeats
const FIRST_SHOW_FALLBACK_MS = 2500
const SETTINGS_SAVE_DELAY_MS = 500
const RELOAD_DELAY_MS = 1000
const RELOAD_WINDOW_MS = 60000
const MAX_RELOADS = 3
const MAX_COPY_CHARS = 16000
const MAX_PROBLEM_CHARS = 120
const MAX_TOOLTIP_CHARS = 127 // the Windows tray tooltip limit
const SETTINGS_FILE = 'catch-up-desktop.json'
const OFFLINE_PAGE = path.join(__dirname, 'offline.html')
const PRELOAD = path.join(__dirname, 'preload.js')
const BACKGROUND = Object.freeze({ light: '#FAFAF7', dark: '#121316' })
// Never a hotkey. Windows owns Alt+Space, and the others are taken on the demo PC.
const BLOCKED_HOTKEYS = Object.freeze(['Alt+Space', 'Control+Alt+Q', 'Control+Alt+Up', 'Control+Alt+Down'])
// own-frame grants the page's own window as the required video track. screen grants a whole screen.
const VIDEO_SOURCE = process.env.CATCHUP_VIDEO_SOURCE === 'screen' ? 'screen' : 'own-frame'

// User-facing copy. It follows the writing rules in src/lib/copy-rules.ts (test/copy.test.js).
const COPY = Object.freeze({
  badUrl: 'CATCHUP_URL must be an https address, or an http address on this computer such as http://localhost:3000.',
  hotkeyFallback: (wanted, active) => `${hotkeyLabel(wanted)} is in use by another app, so ${hotkeyLabel(active)} is on instead.`,
  hotkeyNoneFree: () => `${listWords(DESKTOP_HOTKEY_PRESETS.map(hotkeyLabel))} are all in use by other apps. Close one of those apps, then pick a hotkey again.`,
  hotkeyTakenKept: (wanted, kept) => `${hotkeyLabel(wanted)} is in use by another app. ${hotkeyLabel(kept)} stays on.`,
  hotkeyTakenNone: (wanted) => `${hotkeyLabel(wanted)} is in use by another app. No hotkey is on right now.`,
  tray: Object.freeze({
    catchMeUp: 'Catch me up',
    pause: 'Pause',
    resume: 'Resume',
    showPanel: 'Show panel',
    showPanelFocus: 'Show panel with focus',
    fullView: 'Full view',
    hidePanel: 'Hide panel',
    hotkey: (accelerator) => (accelerator ? `Hotkey ${hotkeyLabel(accelerator)}` : 'Hotkey not set'),
    quit: 'Quit Catch Up',
    name: 'Catch Up',
    listening: 'Listening',
    notListening: 'Not listening',
    noHotkey: 'No hotkey'
  })
})

let appUrl = null
let appOrigin = null
let win = null
let tray = null
let quitting = false
let shownOnce = false
let view = 'compact'
let focusLatched = false // the compact panel was made focusable by Show panel with focus
let compactPos = null // top left of the compact panel, null until placed or moved
let preferredHotkey = DESKTOP_HOTKEY_PRESETS[0]
let hotkeyState = { accelerator: null, registered: false, error: null }
let lastHotkeyEventAt = -Infinity
let trayState = { listening: false, problem: null }
let saveTimer = null
let reloadTimes = []

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function log (message) {
  console.log('[catch-up] ' + message)
}

function hotkeyLabel (accelerator) {
  return String(accelerator).replace(/\bControl\b/g, 'Ctrl')
}

function listWords (words) {
  if (words.length < 2) return words.join('')
  return words.slice(0, -1).join(', ') + ' and ' + words[words.length - 1]
}

function windowAlive () {
  return Boolean(win) && !win.isDestroyed()
}

function send (channel, payload) {
  if (!windowAlive() || win.webContents.isDestroyed()) return
  win.webContents.send(channel, payload)
}

// ---------------------------------------------------------------------------
// One origin, from CATCHUP_URL
// ---------------------------------------------------------------------------

function isLoopbackHost (hostname) {
  const host = String(hostname).toLowerCase()
  return host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(host)
}

/** https anywhere, or http on this computer only (getUserMedia needs a secure context). */
function resolveAppUrl (raw, packaged) {
  let url
  try {
    url = new URL(String(raw).trim())
  } catch {
    return { url: null, error: COPY.badUrl }
  }
  if (url.username || url.password) return { url: null, error: COPY.badUrl }
  if (url.protocol === 'https:') return { url, error: null }
  if (url.protocol === 'http:' && !packaged && isLoopbackHost(url.hostname)) return { url, error: null }
  return { url: null, error: COPY.badUrl }
}

function isAppOrigin (value) {
  if (!value || !appOrigin) return false
  try {
    return new URL(value).origin === appOrigin
  } catch {
    return false
  }
}

/** IPC is answered only for the top frame of our window on our origin. */
function fromAppPage (event) {
  const frame = event && event.senderFrame
  if (!windowAlive() || !event || event.sender !== win.webContents) return false
  return Boolean(frame) && !frame.parent && isAppOrigin(frame.origin)
}

/** The local offline page may only hide the window. Our window cannot load any other file. */
function fromOfflinePage (event) {
  const frame = event && event.senderFrame
  if (!windowAlive() || !event || event.sender !== win.webContents || !frame || frame.parent) return false
  try {
    const url = new URL(frame.url)
    return url.protocol === 'file:' && /\/offline\.html$/i.test(url.pathname)
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Permissions and system audio, for our origin only
// ---------------------------------------------------------------------------

function permissionGranted (permission, details, contents) {
  const requestingUrl = (details && details.requestingUrl) || (contents && contents.getURL())
  if (!isAppOrigin(requestingUrl)) return false
  if (details && details.isMainFrame === false) return false
  switch (permission) {
    case 'display-capture': // getDisplayMedia() in Electron 45 asks here first
      return true
    case 'media': {
      // Microphone yes, camera no.
      const types = (details && details.mediaTypes) || []
      return types.length > 0 && types.every((type) => type === 'audio')
    }
    case 'clipboard-sanitized-write': // navigator.clipboard while the window has focus
      return true
    default:
      return false
  }
}

function permissionAllowed (permission, requestingOrigin, details) {
  if (!isAppOrigin(requestingOrigin)) return false
  if (permission === 'media') return !details || details.mediaType !== 'video'
  return permission === 'display-capture' || permission === 'clipboard-sanitized-write'
}

function installPermissionPolicy (ses) {
  ses.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(permissionGranted(permission, details, contents))
  })
  ses.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) =>
    permissionAllowed(permission, requestingOrigin, details)
  )
}

async function grantDisplayMedia (request) {
  if (!request || !isAppOrigin(request.securityOrigin)) return null
  const frame = request.frame
  // A frame grant captures the whole page, so an iframe never gets one.
  if (frame && (frame.parent || !isAppOrigin(frame.origin))) return null
  const streams = {}
  if (request.videoRequested) {
    // getDisplayMedia() must ask for video and Electron refuses a grant without one.
    if (VIDEO_SOURCE === 'own-frame' && frame && !frame.isDestroyed()) {
      streams.video = frame // the page's own window, the desktop is not captured
    } else {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
      if (sources.length === 0) return null
      streams.video = sources[0]
    }
  }
  if (request.audioRequested) {
    // What the speakers play. With the page constraint restrictOwnAudio Electron switches to
    // process loopback, which skips Catch Up's own sounds. Never loopbackWithMute, it mutes the call.
    streams.audio = 'loopback'
  }
  return streams.video || streams.audio ? streams : null
}

function installDisplayMediaHandler (ses) {
  ses.setDisplayMediaRequestHandler((request, callback) => {
    grantDisplayMedia(request).then(
      (streams) => {
        try {
          callback(streams)
        } catch {
          log('display media grant failed, the page may have gone') // Electron rejects the page's promise
        }
      },
      () => {
        log('display media error')
        try {
          callback(null)
        } catch {
          // the request is already gone
        }
      }
    )
  })
}

// ---------------------------------------------------------------------------
// Global hotkey
// ---------------------------------------------------------------------------

function isPreset (value) {
  return DESKTOP_HOTKEY_PRESETS.includes(value) && !BLOCKED_HOTKEYS.includes(value)
}

function tryRegister (accelerator) {
  try {
    return globalShortcut.register(accelerator, onHotkeyPressed) === true
  } catch {
    return false
  }
}

function unregister (accelerator) {
  try {
    globalShortcut.unregister(accelerator)
  } catch {
    // already gone
  }
}

function hotkeyChanged () {
  updateTray()
  send(DESKTOP_IPC.hotkeyChanged, { ...hotkeyState })
}

function registerStartupHotkey () {
  const order = [preferredHotkey, ...DESKTOP_HOTKEY_PRESETS.filter((preset) => preset !== preferredHotkey)]
  const active = order.find((accelerator) => isPreset(accelerator) && tryRegister(accelerator)) || null
  if (active === preferredHotkey) {
    hotkeyState = { accelerator: active, registered: true, error: null }
  } else if (active) {
    hotkeyState = { accelerator: active, registered: true, error: COPY.hotkeyFallback(preferredHotkey, active) }
  } else {
    hotkeyState = { accelerator: null, registered: false, error: COPY.hotkeyNoneFree() }
  }
  hotkeyChanged()
}

/** The page and the tray pick one of the presets. A taken preset leaves the current one on. */
function setHotkey (accelerator) {
  if (!isPreset(accelerator)) throw new TypeError('Not a Catch Up hotkey preset')
  if (!(hotkeyState.registered && hotkeyState.accelerator === accelerator)) {
    const previous = hotkeyState
    if (previous.registered) unregister(previous.accelerator)
    if (tryRegister(accelerator)) {
      hotkeyState = { accelerator, registered: true, error: null }
    } else if (previous.registered && tryRegister(previous.accelerator)) {
      hotkeyState = { ...previous, error: COPY.hotkeyTakenKept(accelerator, previous.accelerator) }
      hotkeyChanged()
      return { ...hotkeyState }
    } else {
      hotkeyState = { accelerator: null, registered: false, error: COPY.hotkeyTakenNone(accelerator) }
      hotkeyChanged()
      return { ...hotkeyState }
    }
  }
  hotkeyState = { accelerator, registered: true, error: null }
  preferredHotkey = accelerator
  saveSettingsSoon()
  hotkeyChanged()
  return { ...hotkeyState }
}

function onHotkeyPressed () {
  const now = Date.now()
  const quietFor = now - lastHotkeyEventAt
  lastHotkeyEventAt = now // every repeat restarts the quiet time, so a held combo is one press
  if (quietFor < HOTKEY_DEBOUNCE_MS || !hotkeyState.registered) return
  press('hotkey', now)
}

/** One press from main. The hotkey and tray Catch me up share the channel and the payload. */
function press (via, at) {
  if (!windowAlive()) return
  if (!win.isVisible() || win.isMinimized()) win.showInactive() // keep focus in Zoom, Teams or the lecture
  win.setAlwaysOnTop(true, 'screen-saver')
  win.moveTop()
  send(DESKTOP_IPC.hotkey, { at, via, accelerator: via === 'hotkey' ? hotkeyState.accelerator : null })
}

function sendCommand (command) {
  if (command === 'resume') reveal(false)
  send(DESKTOP_IPC.command, command)
}

// ---------------------------------------------------------------------------
// Window placement and views
// ---------------------------------------------------------------------------

function workAreaFor (rect) {
  return screen.getDisplayMatching(rect).workArea
}

function clampRect (rect, area) {
  const width = Math.min(rect.width, area.width)
  const height = Math.min(rect.height, area.height)
  const x = Math.round(Math.min(Math.max(rect.x, area.x), area.x + area.width - width))
  const y = Math.round(Math.min(Math.max(rect.y, area.y), area.y + area.height - height))
  return { x, y, width, height }
}

function defaultCompactPosition () {
  const area = screen.getPrimaryDisplay().workArea
  return {
    x: area.x + area.width - COMPACT_SIZE.width - EDGE_GAP,
    y: area.y + area.height - COMPACT_SIZE.height - EDGE_GAP
  }
}

function compactBounds () {
  const position = compactPos || defaultCompactPosition()
  const rect = { x: position.x, y: position.y, ...COMPACT_SIZE }
  return clampRect(rect, workAreaFor(rect))
}

/** Full view grows from the compact panel's bottom right corner. */
function fullBounds () {
  const compact = compactBounds()
  const rect = {
    x: compact.x + compact.width - FULL_SIZE.width,
    y: compact.y + compact.height - FULL_SIZE.height,
    ...FULL_SIZE
  }
  return clampRect(rect, workAreaFor(compact))
}

function applyBounds (rect) {
  const current = win.getBounds()
  const resize = current.width !== rect.width || current.height !== rect.height
  if (resize) win.setResizable(true) // Windows pins the size of a window that is not resizable
  win.setBounds(rect)
  if (resize) win.setResizable(false)
}

function rememberCompactPosition () {
  if (!windowAlive() || view !== 'compact') return
  const { x, y } = win.getBounds()
  if (compactPos && compactPos.x === x && compactPos.y === y) return
  compactPos = { x, y }
  saveSettingsSoon()
}

function keepOnScreen () {
  if (!windowAlive()) return
  if (view === 'compact') {
    applyBounds(compactBounds())
  } else {
    const rect = win.getBounds()
    applyBounds(clampRect(rect, workAreaFor(rect)))
  }
}

/** Shows the window. With focus it takes keyboard focus, otherwise the call keeps it. */
function reveal (focus) {
  if (!windowAlive()) return
  if (focus) {
    if (view === 'compact' && !focusLatched) {
      focusLatched = true // until the panel loses focus, for keyboard and screen reader users
      win.setFocusable(true)
      win.setSkipTaskbar(true)
    }
    win.show()
    win.focus()
    win.webContents.focus()
  } else if (!win.isVisible() || win.isMinimized()) {
    win.showInactive()
  }
  win.setAlwaysOnTop(true, 'screen-saver')
  win.moveTop()
}

function setView (next) {
  if (!DESKTOP_VIEWS.includes(next)) throw new TypeError('Unknown view')
  if (!windowAlive()) return view
  if (next !== view) {
    if (next === 'full') {
      rememberCompactPosition()
      view = 'full'
      focusLatched = false
      win.setFocusable(true)
      win.setSkipTaskbar(false)
      applyBounds(fullBounds())
    } else {
      view = 'compact'
      focusLatched = false
      win.setFocusable(false)
      win.setSkipTaskbar(true)
      applyBounds(compactBounds())
    }
    send(DESKTOP_IPC.viewChanged, view)
  }
  reveal(view === 'full')
  return view
}

function showCompact (focus) {
  if (!windowAlive()) return
  if (view !== 'compact') setView('compact')
  reveal(focus)
}

function onBlur () {
  if (view !== 'compact' || !focusLatched || !windowAlive()) return
  focusLatched = false
  win.setFocusable(false)
  win.setSkipTaskbar(true)
}

function showFirstTime () {
  if (shownOnce || !windowAlive()) return
  shownOnce = true
  // Set the size again on the first show. Restored and scaled windows can come up 1 to 2 px off
  // at 125 to 175% display scale (electron#55245).
  applyBounds(view === 'full' ? fullBounds() : compactBounds())
  win.showInactive()
  win.setAlwaysOnTop(true, 'screen-saver')
}

function hideWindow () {
  if (windowAlive()) win.hide()
}

// ---------------------------------------------------------------------------
// Loading the app, the offline page and crashes
// ---------------------------------------------------------------------------

function loadApp () {
  if (!windowAlive()) return
  win.webContents.loadURL(appUrl.href).catch(() => {
    // did-fail-load shows the offline page
  })
}

function showOfflinePage (reason) {
  if (!windowAlive()) return
  win.webContents.loadFile(OFFLINE_PAGE, { query: { url: appUrl.href, reason } }).catch(() => {
    log('could not show the offline page')
  })
}

function onDidFailLoad (_event, errorCode, _errorDescription, validatedURL, isMainFrame) {
  if (!isMainFrame || errorCode === -3) return // -3 is ERR_ABORTED, also seen on redirects
  if (!isAppOrigin(validatedURL)) return
  log('could not load the app, error ' + errorCode)
  showOfflinePage('offline')
}

function onDidNavigate () {
  // A new document means the old page and its capture are gone, until the page reports again.
  if (!trayState.listening && !trayState.problem) return
  trayState = { listening: false, problem: null }
  updateTray()
}

function onDidFinishLoad () {
  if (!windowAlive() || !isAppOrigin(win.webContents.getURL())) return
  // The startup hotkey message goes out before the page can listen, so repeat the state on load.
  send(DESKTOP_IPC.hotkeyChanged, { ...hotkeyState })
  send(DESKTOP_IPC.viewChanged, view)
}

function onRenderGone (_event, details) {
  log('the page stopped (' + ((details && details.reason) || 'unknown') + ')')
  onDidNavigate()
  if (quitting || !windowAlive()) return
  const now = Date.now()
  reloadTimes = reloadTimes.filter((time) => now - time < RELOAD_WINDOW_MS)
  reloadTimes.push(now)
  if (reloadTimes.length > MAX_RELOADS) {
    showOfflinePage('crashed')
    return
  }
  setTimeout(loadApp, RELOAD_DELAY_MS)
}

// ---------------------------------------------------------------------------
// Every webContents stays on our origin
// ---------------------------------------------------------------------------

function openExternalSafe (value) {
  let url
  try {
    url = new URL(value)
  } catch {
    return
  }
  if (url.protocol !== 'https:') return
  shell.openExternal(url.href).catch(() => {})
}

function lockContents (contents) {
  contents.on('will-navigate', (event) => {
    if (isAppOrigin(event.url)) return
    event.preventDefault()
    openExternalSafe(event.url)
  })
  contents.on('will-redirect', (event) => {
    if (!event.isMainFrame || isAppOrigin(event.url)) return
    event.preventDefault()
    if (windowAlive() && contents === win.webContents) showOfflinePage('redirect')
  })
  contents.on('will-attach-webview', (event) => event.preventDefault())
  contents.setWindowOpenHandler(({ url }) => {
    openExternalSafe(url)
    return { action: 'deny' }
  })
}

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------

function hasProblem () {
  return Boolean(trayState.problem) || Boolean(hotkeyState.error)
}

function trayImage () {
  const display = screen.getPrimaryDisplay()
  const png = trayIconPng({ listening: trayState.listening, problem: hasProblem() }, display && display.scaleFactor)
  return nativeImage.createFromBuffer(png, { scaleFactor: 1 })
}

function trayTooltip () {
  const parts = [
    COPY.tray.name,
    trayState.listening ? COPY.tray.listening : COPY.tray.notListening,
    hotkeyState.registered ? hotkeyLabel(hotkeyState.accelerator) : COPY.tray.noHotkey
  ]
  if (trayState.problem) parts.push(trayState.problem)
  const text = parts.join(' · ')
  return text.length > MAX_TOOLTIP_CHARS ? text.slice(0, MAX_TOOLTIP_CHARS - 1) + '…' : text
}

function trayMenuTemplate () {
  const live = hotkeyState.registered ? hotkeyState.accelerator : null
  return [
    {
      label: COPY.tray.catchMeUp,
      accelerator: live || undefined,
      registerAccelerator: false, // shown for reference, the global hotkey does the work
      click: () => press('tray', Date.now())
    },
    {
      label: trayState.listening ? COPY.tray.pause : COPY.tray.resume,
      click: () => sendCommand(trayState.listening ? 'pause' : 'resume')
    },
    { type: 'separator' },
    { label: COPY.tray.showPanel, click: () => showCompact(false) },
    { label: COPY.tray.showPanelFocus, click: () => showCompact(true) },
    { label: COPY.tray.fullView, click: () => setView('full') },
    { label: COPY.tray.hidePanel, click: hideWindow },
    {
      label: COPY.tray.hotkey(live),
      submenu: DESKTOP_HOTKEY_PRESETS.map((accelerator) => ({
        label: hotkeyLabel(accelerator),
        type: 'radio',
        checked: live === accelerator,
        click: () => setHotkey(accelerator)
      }))
    },
    { type: 'separator' },
    { label: COPY.tray.quit, click: quit }
  ]
}

function updateTray () {
  if (!tray) return
  tray.setImage(trayImage())
  tray.setToolTip(trayTooltip())
  tray.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate()))
}

function createTray () {
  tray = new Tray(trayImage())
  tray.on('click', () => reveal(false))
  updateTray()
}

function setTrayState (state) {
  if (!state || typeof state !== 'object' || typeof state.listening !== 'boolean') {
    throw new TypeError('Tray state needs listening as a boolean')
  }
  let problem = null
  if (typeof state.problem === 'string') {
    const text = state.problem.replace(/\s+/g, ' ').trim()
    problem = text ? text.slice(0, MAX_PROBLEM_CHARS) : null
  } else if (state.problem !== null && state.problem !== undefined) {
    throw new TypeError('Tray problem must be a string or null')
  }
  trayState = { listening: state.listening, problem }
  updateTray()
}

// ---------------------------------------------------------------------------
// IPC from the page
// ---------------------------------------------------------------------------

async function copyText (text) {
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_COPY_CHARS) return false
  try {
    // navigator.clipboard needs a focused document, and the panel never takes focus.
    await clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

function handle (channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!fromAppPage(event)) throw new Error('Refused')
    return handler(...args)
  })
}

function installIpc () {
  handle(DESKTOP_IPC.getView, () => view)
  handle(DESKTOP_IPC.setView, (next) => setView(next))
  handle(DESKTOP_IPC.getHotkey, () => ({ ...hotkeyState }))
  handle(DESKTOP_IPC.setHotkey, (accelerator) => setHotkey(accelerator))
  handle(DESKTOP_IPC.setTrayState, (state) => {
    setTrayState(state)
  })
  handle(DESKTOP_IPC.showPanel, (options) => {
    reveal(Boolean(options && options.focus === true))
  })
  handle(DESKTOP_IPC.copyText, (text) => copyText(text))
  ipcMain.handle(DESKTOP_IPC.hide, (event) => {
    if (!fromAppPage(event) && !fromOfflinePage(event)) throw new Error('Refused')
    hideWindow()
  })
}

// ---------------------------------------------------------------------------
// Settings. Only the hotkey choice and where the panel sits, never audio or text.
// ---------------------------------------------------------------------------

function settingsPath () {
  return path.join(app.getPath('userData'), SETTINGS_FILE)
}

function readSettings () {
  let data
  try {
    data = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'))
  } catch {
    return // first run, or a file we cannot read, so the defaults stay
  }
  if (data && isPreset(data.hotkey)) preferredHotkey = data.hotkey
  const panel = data && data.panel
  if (panel && Number.isFinite(panel.x) && Number.isFinite(panel.y) && Math.abs(panel.x) < 1e6 && Math.abs(panel.y) < 1e6) {
    compactPos = { x: Math.round(panel.x), y: Math.round(panel.y) }
  }
}

function writeSettings () {
  clearTimeout(saveTimer)
  saveTimer = null
  const file = settingsPath()
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file + '.tmp', JSON.stringify({ version: 1, hotkey: preferredHotkey, panel: compactPos }, null, 2))
    fs.renameSync(file + '.tmp', file)
  } catch {
    log('could not save settings')
  }
}

function saveSettingsSoon () {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(writeSettings, SETTINGS_SAVE_DELAY_MS)
}

// ---------------------------------------------------------------------------
// Window and app lifecycle
// ---------------------------------------------------------------------------

function createWindow () {
  win = new BrowserWindow({
    ...compactBounds(),
    show: false,
    frame: false, // the page's status row is the drag region (app-region: drag)
    roundedCorners: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false, // clicks never pull focus from Zoom or Teams
    title: 'Catch Up',
    backgroundColor: nativeTheme.shouldUseDarkColors ? BACKGROUND.dark : BACKGROUND.light,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      spellcheck: false,
      backgroundThrottling: false, // keeps timers and the page visible to itself while the panel is hidden
      focusOnNavigation: false
    }
  })
  win.setAlwaysOnTop(true, 'screen-saver') // above the taskbar and most floating call controls
  win.once('ready-to-show', showFirstTime)
  setTimeout(showFirstTime, FIRST_SHOW_FALLBACK_MS) // a slow first compile should not hide the panel
  win.on('moved', rememberCompactPosition)
  win.on('blur', onBlur)
  win.on('close', (event) => {
    if (quitting) return
    event.preventDefault()
    win.hide() // closing hides to the tray, Quit lives in the tray menu
  })
  win.on('closed', () => {
    win = null
  })

  const contents = win.webContents
  contents.on('did-fail-load', onDidFailLoad)
  contents.on('did-navigate', onDidNavigate)
  contents.on('did-finish-load', onDidFinishLoad)
  contents.on('render-process-gone', onRenderGone)
  if (process.env.CATCHUP_DEVTOOLS === '1') contents.openDevTools({ mode: 'detach', activate: false })
  loadApp()
}

function onReady () {
  const { url, error } = resolveAppUrl(process.env.CATCHUP_URL || DEFAULT_URL, app.isPackaged)
  if (!url) {
    dialog.showErrorBox('Catch Up', error)
    app.quit()
    return
  }
  appUrl = url
  appOrigin = url.origin
  app.setAppUserModelId(APP_USER_MODEL_ID)
  readSettings()
  installPermissionPolicy(session.defaultSession)
  installDisplayMediaHandler(session.defaultSession)
  installIpc()
  createWindow()
  createTray()
  registerStartupHotkey()
  screen.on('display-added', keepOnScreen)
  screen.on('display-removed', keepOnScreen)
  screen.on('display-metrics-changed', keepOnScreen)
}

function quit () {
  quitting = true
  app.quit()
}

function start () {
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }
  app.on('second-instance', () => reveal(false))
  app.on('web-contents-created', (_event, contents) => lockContents(contents))
  app.on('window-all-closed', () => {
    // Stay in the tray. Quit from the tray menu.
  })
  app.on('before-quit', () => {
    quitting = true
    rememberCompactPosition()
    if (appUrl) writeSettings()
  })
  app.on('will-quit', () => {
    globalShortcut.unregisterAll()
    if (tray) {
      tray.destroy()
      tray = null
    }
  })
  app
    .whenReady()
    .then(onReady)
    .catch((error) => {
      log('startup failed')
      console.error(error)
      app.quit()
    })
}

start()

// Read by the tests only. Electron ignores what the main script exports.
module.exports = {
  BLOCKED_HOTKEYS,
  COMPACT_SIZE,
  COPY,
  EDGE_GAP,
  FULL_SIZE,
  HOTKEY_DEBOUNCE_MS,
  MAX_COPY_CHARS,
  MAX_PROBLEM_CHARS,
  SETTINGS_FILE,
  clampRect,
  hotkeyLabel,
  isLoopbackHost,
  resolveAppUrl
}
