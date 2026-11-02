'use strict'
// The bridge the Catch Up page uses inside the Windows app, window.catchUpDesktop.
// It runs sandboxed with context isolation, so require() only loads 'electron' and the channel
// names are copied here from src/lib/audio/types.ts (test/contract.test.js keeps them in sync).
// The page never gets ipcRenderer or an IPC event, only the payload.

const { contextBridge, ipcRenderer } = require('electron')

const BRIDGE_GLOBAL = 'catchUpDesktop'
const BRIDGE_VERSION = 1

const IPC = {
  hotkey: 'catchup:hotkey',
  hotkeyChanged: 'catchup:hotkey-changed',
  command: 'catchup:command',
  viewChanged: 'catchup:view-changed',
  getView: 'catchup:get-view',
  setView: 'catchup:set-view',
  getHotkey: 'catchup:get-hotkey',
  setHotkey: 'catchup:set-hotkey',
  setTrayState: 'catchup:set-tray-state',
  showPanel: 'catchup:show-panel',
  copyText: 'catchup:copy-text',
  hide: 'catchup:hide'
}

// One IPC listener per channel fans out to the page's callbacks, so one failing callback
// cannot stop the others.
const hubs = new Map()

function subscribe (channel, callback) {
  if (typeof callback !== 'function') return () => {}
  let hub = hubs.get(channel)
  if (!hub) {
    const callbacks = new Set()
    const listener = (_event, payload) => {
      for (const deliver of Array.from(callbacks)) {
        try {
          deliver(payload)
        } catch (error) {
          console.error('[catch-up] a desktop listener failed', error)
        }
      }
    }
    hub = { callbacks, listener }
    hubs.set(channel, hub)
    ipcRenderer.on(channel, listener)
  }
  const deliver = (payload) => {
    callback(payload)
  }
  hub.callbacks.add(deliver)
  let active = true
  return () => {
    if (!active) return
    active = false
    hub.callbacks.delete(deliver)
    if (hub.callbacks.size === 0 && hubs.get(channel) === hub) {
      hubs.delete(channel)
      ipcRenderer.removeListener(channel, hub.listener)
    }
  }
}

function done () {
  return undefined
}

function plainTrayState (state) {
  return {
    listening: Boolean(state && state.listening),
    problem: state && typeof state.problem === 'string' ? state.problem : null
  }
}

contextBridge.exposeInMainWorld(BRIDGE_GLOBAL, {
  isDesktop: true,
  bridgeVersion: BRIDGE_VERSION,
  onHotkey: (callback) => subscribe(IPC.hotkey, callback),
  onHotkeyChange: (callback) => subscribe(IPC.hotkeyChanged, callback),
  onCommand: (callback) => subscribe(IPC.command, callback),
  onViewChange: (callback) => subscribe(IPC.viewChanged, callback),
  getView: () => ipcRenderer.invoke(IPC.getView),
  setView: (view) => ipcRenderer.invoke(IPC.setView, view),
  getHotkey: () => ipcRenderer.invoke(IPC.getHotkey),
  setHotkey: (accelerator) => ipcRenderer.invoke(IPC.setHotkey, accelerator),
  setTrayState: (state) => ipcRenderer.invoke(IPC.setTrayState, plainTrayState(state)).then(done),
  showPanel: (options) => ipcRenderer.invoke(IPC.showPanel, { focus: Boolean(options && options.focus === true) }).then(done),
  copyText: (text) => (typeof text === 'string' ? ipcRenderer.invoke(IPC.copyText, text) : Promise.resolve(false)),
  hideWindow: () => ipcRenderer.invoke(IPC.hide).then(done)
})
