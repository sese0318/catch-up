# Catch Up for Windows

A thin Electron 45 shell around the Catch Up web app. It adds what a browser tab cannot do on Windows.

1. A global hotkey, Ctrl+Alt+C, that works while Zoom, Teams or a lecture has focus.
2. A compact panel that stays on top and never takes focus from your call.
3. System audio from apps on this computer, with no share picker.
4. A tray icon that shows whether Catch Up is listening.

Catch Up keeps the last 2 minutes of sound in memory, and nothing leaves your device until you press. The audio stays inside the page, just as in a browser tab. This shell never records, saves or uploads audio. Text you copy from a card passes through it to the clipboard and is not kept.

Built with Muse Spark Open. Cards are written by AI and can be wrong. Catch Up is for people 18 and over.

## Run it on Windows

You need Node 22 or newer, and the web app running where this computer can reach it.

1. In the repo root, start the web app with `npm run dev`. It serves http://localhost:3000 by default.
2. Open PowerShell in `desktop` and run `npm install` once.
3. Run `npm start`. The Electron 45.2.1 runtime, about 150 MB, downloads during the install or on the first start.

```powershell
cd desktop
npm install
npm start
```

To load the deployed app or a preview instead, set `CATCHUP_URL` before `npm start`. It takes an https address, or an http address on this computer.

```powershell
$env:CATCHUP_URL = "https://your-app.vercel.app"
npm start
```

Nothing here builds an exe, an installer or a signed app. The Windows app runs from source.

## Using it

| Action | What happens |
| --- | --- |
| Ctrl+Alt+C anywhere | The panel comes forward without taking focus and catches you up |
| Tray icon click | Shows the panel without taking focus |
| Catch me up in the tray | The same press as the hotkey |
| Pause or Resume in the tray | Stops listening and clears memory, or starts again |
| Show panel | The compact panel, 360 × 480, in the bottom right corner |
| Show panel with focus | The same panel, reachable with Tab and a screen reader until you click elsewhere |
| Full view | A 480 × 760 window with history and settings, which takes focus |
| Hide panel | Hides the window. Listening goes on, and the tray icon still shows it |
| Hotkey in the tray | Pick Ctrl+Alt+C, Ctrl+Shift+Space or Ctrl+Alt+Space |
| Quit Catch Up in the tray | Closes the app. Closing the window only hides it |

When another app already owns Ctrl+Alt+C, Catch Up tries Ctrl+Shift+Space, then Ctrl+Alt+Space. The tray icon gets a yellow badge and its tooltip names the hotkey that is on. A held hotkey counts as one press.

The tray icon is a filled red dot while Catch Up is listening and a hollow ring when it is not. A yellow badge means something needs a look, such as a lost audio source or a hotkey that is taken.

Drag the panel by its status row. It reopens where you left it.

## What stays on this computer

Only the hotkey you picked and where you left the panel, in `%APPDATA%\Catch Up\catch-up-desktop.json`. The page keeps its own settings, such as the card language, in its local storage. The shell saves no audio, cards, transcripts or names.

## Privacy and safety

1. Use it openly. Tell the people around you and follow local rules. In class, ask the instructor or the disability office first.
2. The panel always shows up in screen shares. The shell never calls `setContentProtection`.
3. The window loads one origin, the one in `CATCHUP_URL`. Links to other https sites open in your browser, and every other page load or new window is blocked.
4. The microphone, system audio and clipboard writes are allowed for that origin only. The camera and every other permission are refused.
5. System audio uses Windows loopback with no share picker. The browser API also requires a video track, so the shell grants the page's own window as that track and the page can stop it. When the page adds the `restrictOwnAudio` constraint, Electron switches to process loopback on Windows 11, which hears every output device and leaves Catch Up's own sounds out.
6. The page runs with context isolation and the sandbox on, and with no Node in the page. It reaches the shell only through `window.catchUpDesktop`.

## Settings for testing

| Variable | Default | Use |
| --- | --- | --- |
| `CATCHUP_URL` | `http://localhost:3000` | The web app to load |
| `CATCHUP_VIDEO_SOURCE` | `own-frame` | Set `screen` if system audio fails with the page's own window as the video |
| `CATCHUP_DEVTOOLS` | not set | Set `1` to open DevTools in their own window |

## Checks on the demo PC

None of these have run in a live Electron process yet. The demo PC runs Windows 11 Home build 26300 on x64.

1. Start the web app, then run `npm start` here. The panel appears in the bottom right corner, frameless and above other windows. The tray shows a hollow ring.
2. Start listening with Apps on this computer, then play a YouTube video in Chrome. The level meter moves. With `CATCHUP_DEVTOOLS` set to `1`, the console shows the audio track's deviceId as `loopbackWithoutChrome`.
3. Choose a USB or Bluetooth headset as the speaker inside Zoom or Teams while the Windows default output is the laptop speaker. Catch Up should still hear the call. Repeat with the headset set only as the default communication device in the classic Sound control panel.
4. Press Ctrl+Alt+C while Zoom has focus. One card request goes out and Zoom keeps focus. Hold the combo for 2 seconds. It still counts once.
5. Audio keeps flowing for a minute after the page stops the video track. If capture fails, set `CATCHUP_VIDEO_SOURCE` to `screen` and try again.
6. Share the whole screen in Zoom and check from a second device that the panel shows up in the share.
7. Type Japanese with Microsoft IME and Chinese with Microsoft Pinyin in another app, then press Ctrl+Alt+C in the middle of a word. Note what happens to the text being typed.
8. If a tool such as AutoHotkey is at hand, make it hold Ctrl+Alt+C first, then start Catch Up. The tray names Ctrl+Shift+Space and shows the badge. Skip this without such a tool.
9. With Zoom focused, press the hotkey, click Copy line on the card, then paste into Notepad.
10. At 125% or 150% display scale, quit and restart Catch Up three times. The panel reopens where you left it at 360 × 480.
11. Drag the panel by its status row. Pick Show panel with focus in the tray, press Tab through the panel, then click another app. The panel stops taking focus again.
12. Pick Full view in the tray. The window grows to 480 × 760 from the panel's corner and takes focus. Show panel brings the compact panel back to its spot.
13. Stop the web app. The panel shows Can't reach Catch Up. Start the web app again. The panel comes back by itself within a few seconds, or press Retry.

## Tests

`npm test` runs the Node test runner with a stand-in for Electron. It checks the bridge keys and channel names against `src/lib/audio/types.ts`, the press payload from the hotkey and the tray, the hotkey fallback, views, tray state, permissions, the display media grant, the origin lock, the offline page and the writing rules. It never starts Electron, so the checks above still need the demo PC.

`npm run check` parses every file with `node --check`.
