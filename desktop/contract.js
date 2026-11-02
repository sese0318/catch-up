'use strict'
// The Windows app bridge contract, copied from src/lib/audio/types.ts. The desktop app is plain
// CommonJS outside the TypeScript build, so test/contract.test.js keeps these values in sync.
// preload.js runs sandboxed and cannot require this file, so it carries its own copy (also tested).

const DESKTOP_BRIDGE_GLOBAL = 'catchUpDesktop'
const DESKTOP_BRIDGE_VERSION = 1

/** Electron accelerators, tried in order when one is taken. */
const DESKTOP_HOTKEY_PRESETS = Object.freeze(['Control+Alt+C', 'Control+Shift+Space', 'Control+Alt+Space'])

const DESKTOP_COMMANDS = Object.freeze(['pause', 'resume'])

/** DesktopView is only a type in the contract, so the runtime list lives here. */
const DESKTOP_VIEWS = Object.freeze(['compact', 'full'])

const DESKTOP_IPC = Object.freeze({
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
})

module.exports = {
  DESKTOP_BRIDGE_GLOBAL,
  DESKTOP_BRIDGE_VERSION,
  DESKTOP_COMMANDS,
  DESKTOP_HOTKEY_PRESETS,
  DESKTOP_IPC,
  DESKTOP_VIEWS
}
