'use strict'
// A stand-in for the parts of Electron 45 that main.js and preload.js use. It records calls so
// the tests can check the logic and the API call shapes. It proves nothing about real Electron.

const fs = require('node:fs')
const Module = require('node:module')
const os = require('node:os')
const path = require('node:path')

const DESKTOP_DIR = path.resolve(__dirname, '..', '..')

function addListener (map, name, fn) {
  if (!map.has(name)) map.set(name, [])
  map.get(name).push(fn)
}

function emitTo (map, name, args) {
  for (const fn of [...(map.get(name) || [])]) fn(...args)
}

function createFakeElectron (options = {}) {
  const taken = new Set(options.taken || [])
  const state = {
    sent: [],
    registered: new Map(),
    handlers: new Map(),
    appEvents: new Map(),
    screenEvents: new Map(),
    windows: [],
    trays: [],
    copied: [],
    opened: [],
    errorBoxes: [],
    capturerCalls: [],
    quitCalls: 0,
    contentProtectionCalls: 0,
    readyResolve: null,
    userData: options.userData || null,
    madeUserData: false,
    workArea: options.workArea || { x: 0, y: 0, width: 1920, height: 1040 },
    scaleFactor: options.scaleFactor || 1,
    permissionRequest: null,
    permissionCheck: null,
    displayMedia: null,
    exposed: {},
    rendererListeners: new Map(),
    invokes: []
  }

  class FakeWebContents {
    constructor () {
      this.listeners = new Map()
      this.url = ''
      this.loads = []
      this.destroyed = false
      this.windowOpenHandler = null
      this.focused = false
      this.devToolsOpened = 0
    }

    on (name, fn) {
      addListener(this.listeners, name, fn)
      return this
    }

    emit (name, ...args) {
      emitTo(this.listeners, name, args)
    }

    send (channel, payload) {
      state.sent.push({ channel, payload })
    }

    loadURL (url) {
      this.url = url
      this.loads.push({ kind: 'url', url })
      return Promise.resolve()
    }

    loadFile (file, opts) {
      const query = (opts && opts.query) || {}
      const search = new URLSearchParams(query).toString()
      this.url = 'file:///' + file.replace(/\\/g, '/') + (search ? '?' + search : '')
      this.loads.push({ kind: 'file', file, query })
      return Promise.resolve()
    }

    getURL () {
      return this.url
    }

    isDestroyed () {
      return this.destroyed
    }

    setWindowOpenHandler (fn) {
      this.windowOpenHandler = fn
    }

    focus () {
      this.focused = true
    }

    openDevTools () {
      this.devToolsOpened += 1
    }
  }

  class FakeBrowserWindow {
    constructor (opts) {
      this.opts = opts
      this.bounds = { x: opts.x, y: opts.y, width: opts.width, height: opts.height }
      this.visible = false
      this.shownInactive = false
      this.focused = false
      this.minimized = false
      this.focusable = opts.focusable !== false
      this.skipTaskbar = Boolean(opts.skipTaskbar)
      this.resizable = opts.resizable !== false
      this.alwaysOnTop = Boolean(opts.alwaysOnTop)
      this.level = null
      this.moveTopCalls = 0
      this.blockedResizes = 0
      this.destroyed = false
      this.listeners = new Map()
      this.onceListeners = new Map()
      this.webContents = new FakeWebContents()
      state.windows.push(this)
      emitTo(state.appEvents, 'web-contents-created', [{}, this.webContents])
    }

    on (name, fn) {
      addListener(this.listeners, name, fn)
      return this
    }

    once (name, fn) {
      addListener(this.onceListeners, name, fn)
      return this
    }

    emit (name, ...args) {
      const once = this.onceListeners.get(name) || []
      this.onceListeners.delete(name)
      for (const fn of once) fn(...args)
      emitTo(this.listeners, name, args)
    }

    setAlwaysOnTop (flag, level) {
      this.alwaysOnTop = flag
      this.level = level
    }

    isVisible () {
      return this.visible
    }

    isMinimized () {
      return this.minimized
    }

    isDestroyed () {
      return this.destroyed
    }

    show () {
      this.visible = true
      this.minimized = false
      this.shownInactive = false
      if (this.focusable) this.focused = true
    }

    showInactive () {
      this.visible = true
      this.minimized = false
      this.shownInactive = true
    }

    hide () {
      this.visible = false
      this.focused = false
    }

    focus () {
      if (this.focusable) this.focused = true
    }

    moveTop () {
      this.moveTopCalls += 1
    }

    getBounds () {
      return { ...this.bounds }
    }

    // Like Electron on Windows, a window that is not resizable keeps its size.
    setBounds (rect) {
      if (!this.resizable && (rect.width !== this.bounds.width || rect.height !== this.bounds.height)) {
        this.blockedResizes += 1
        this.bounds = { ...this.bounds, x: rect.x, y: rect.y }
        return
      }
      this.bounds = { ...rect }
    }

    setResizable (flag) {
      this.resizable = flag
    }

    setFocusable (flag) {
      this.focusable = flag
      if (!flag) this.focused = false
    }

    setSkipTaskbar (flag) {
      this.skipTaskbar = flag
    }

    setContentProtection () {
      state.contentProtectionCalls += 1
    }
  }

  class FakeTray {
    constructor (image) {
      this.image = image
      this.tooltip = ''
      this.menu = null
      this.listeners = new Map()
      this.destroyed = false
      state.trays.push(this)
    }

    setImage (image) {
      this.image = image
    }

    setToolTip (text) {
      this.tooltip = text
    }

    setContextMenu (menu) {
      this.menu = menu
    }

    on (name, fn) {
      addListener(this.listeners, name, fn)
      return this
    }

    emit (name, ...args) {
      emitTo(this.listeners, name, args)
    }

    destroy () {
      this.destroyed = true
    }
  }

  const app = {
    isPackaged: Boolean(options.packaged),
    requestSingleInstanceLock: () => options.singleInstance !== false,
    whenReady: () =>
      new Promise((resolve) => {
        state.readyResolve = resolve
      }),
    on (name, fn) {
      addListener(state.appEvents, name, fn)
      return app
    },
    quit () {
      state.quitCalls += 1
    },
    setAppUserModelId (id) {
      state.appUserModelId = id
    },
    getPreferredSystemLanguages () {
      return options.languages || ['en-US']
    },
    getPath (name) {
      if (name !== 'userData') throw new Error('unexpected path ' + name)
      if (!state.userData) {
        state.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'catch-up-desktop-test-'))
        state.madeUserData = true
      }
      return state.userData
    }
  }

  const electron = {
    app,
    BrowserWindow: FakeBrowserWindow,
    Menu: { buildFromTemplate: (items) => ({ items }) },
    Tray: FakeTray,
    clipboard: {
      writeText: async (text) => {
        state.copied.push(text)
      }
    },
    desktopCapturer: {
      getSources: async (opts) => {
        state.capturerCalls.push(opts)
        return [{ id: 'screen:0:0', name: 'Entire screen' }]
      }
    },
    dialog: {
      showErrorBox: (title, content) => state.errorBoxes.push({ title, content })
    },
    globalShortcut: {
      register (accelerator, callback) {
        if (taken.has(accelerator)) return false
        state.registered.set(accelerator, callback)
        return true
      },
      unregister (accelerator) {
        state.registered.delete(accelerator)
      },
      unregisterAll () {
        state.registered.clear()
      },
      isRegistered: (accelerator) => state.registered.has(accelerator)
    },
    ipcMain: {
      handle (channel, fn) {
        if (state.handlers.has(channel)) throw new Error('second handler for ' + channel)
        state.handlers.set(channel, fn)
      }
    },
    nativeImage: {
      createFromBuffer: (png, opts) => ({ png, opts, isEmpty: () => false })
    },
    nativeTheme: { shouldUseDarkColors: Boolean(options.dark) },
    screen: {
      getPrimaryDisplay: () => ({ workArea: { ...state.workArea }, scaleFactor: state.scaleFactor }),
      getDisplayMatching: () => ({ workArea: { ...state.workArea }, scaleFactor: state.scaleFactor }),
      on (name, fn) {
        addListener(state.screenEvents, name, fn)
      }
    },
    session: {
      defaultSession: {
        setPermissionRequestHandler (fn) {
          state.permissionRequest = fn
        },
        setPermissionCheckHandler (fn) {
          state.permissionCheck = fn
        },
        setDisplayMediaRequestHandler (fn) {
          state.displayMedia = fn
        }
      }
    },
    shell: {
      openExternal: async (url) => {
        state.opened.push(url)
      }
    },
    contextBridge: {
      exposeInMainWorld (key, api) {
        state.exposed[key] = api
      }
    },
    ipcRenderer: {
      on (channel, fn) {
        addListener(state.rendererListeners, channel, fn)
      },
      removeListener (channel, fn) {
        const list = state.rendererListeners.get(channel) || []
        state.rendererListeners.set(
          channel,
          list.filter((item) => item !== fn)
        )
      },
      invoke: async (channel, ...args) => {
        state.invokes.push([channel, ...args])
        return options.invokeResult ? options.invokeResult(channel, ...args) : undefined
      }
    }
  }

  return {
    electron,
    state,
    taken,
    async ready () {
      if (state.readyResolve) state.readyResolve()
      await new Promise((resolve) => setImmediate(resolve))
    },
    window: () => state.windows[state.windows.length - 1],
    tray: () => state.trays[state.trays.length - 1],
    emitApp: (name, ...args) => emitTo(state.appEvents, name, args),
    emitScreen: (name, ...args) => emitTo(state.screenEvents, name, args),
    rendererEmit: (channel, event, payload) => emitTo(state.rendererListeners, channel, [event, payload]),
    rendererListenerCount: (channel) => (state.rendererListeners.get(channel) || []).length,
    sentOn: (channel) => state.sent.filter((item) => item.channel === channel).map((item) => item.payload),
    cleanup () {
      if (state.madeUserData) fs.rmSync(state.userData, { recursive: true, force: true })
    }
  }
}

/** Requires a desktop module with 'electron' replaced by the fake, from a fresh module cache. */
function loadWithElectron (relativeFile, electron) {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(DESKTOP_DIR + path.sep) && !key.includes(path.sep + 'test' + path.sep)) delete require.cache[key]
  }
  const originalLoad = Module._load
  Module._load = function load (request, parent, isMain) {
    if (request === 'electron') return electron
    return originalLoad.call(this, request, parent, isMain)
  }
  try {
    return require(path.join(DESKTOP_DIR, relativeFile))
  } finally {
    Module._load = originalLoad
  }
}

module.exports = { DESKTOP_DIR, createFakeElectron, loadWithElectron }
