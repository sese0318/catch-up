# Catch Up

Missed something? Press once.

Catch Up keeps the last 2 minutes of sound in memory, and nothing leaves your device until you press. One key or tap turns the last 30, 60 or 120 seconds of a meeting, a class, a conversation in person or a video into a short card in English, Japanese or Simplified Chinese.

Built with Muse Spark Open.

## What the card holds

1. Whether you were just asked something.
2. One line you can say out loud that restates or confirms what you heard. It never answers for you, and it carries an AI-suggested tag. It stays in the language the speaker used, with a gloss in your card language when the two differ.
3. A summary of 1 or 2 sentences.
4. Up to 5 facts (names, dates, numbers, places, terms and tasks), each marked when the model is unsure.
5. The key quote, word for word.
6. A receipt that names what was sent, the route, the model and the time. Every receipt ends with Catch Up saved nothing.

The card language starts from your browser language (Japanese, Chinese, or English for everything else). You can change it, and the choice stays on this device.

## Who it is for

Anyone who loses a few seconds of a conversation and wants back in without asking the room to repeat. People whose attention drifts for a moment, people who find speech hard to follow in noise, and people listening in a second language.

Catch Up is a hearing and language aid. It is not a medical device, it never reads emotions, and it never identifies speakers by voice.

## How it works

1. **Pick a source.** People in the room through the microphone, a tab in this browser, or apps on this computer. Tick People here know I'm using Catch Up, and paste the heads-up line into the chat if that helps. The page keeps the last 2 minutes in an AudioWorklet ring buffer in memory.
2. **Press.** Click Catch up, press Ctrl+Alt+C (Ctrl+Shift+Space and Ctrl+Alt+Space also work), or tap the button on a phone. The page slices the window you chose and checks that someone spoke. If no one did, nothing is sent. Otherwise one 16 kHz mono WAV goes to the server.
3. **Read the card.** The server hands the clip to a Meta model and streams the card back. While it is written, the panel shows a short line you can say to buy a moment.

On a computer, Float on top keeps the panel in a small window above your call, in browsers that support it.

## Two Meta routes

| Route | Models | How it hears the clip | When it runs |
| --- | --- | --- | --- |
| Main, open weights | Muse Spark Open on Baseten, `meta-models/muse-spark-open-1026` | The WAV goes in as an `audio_url` data URL, so one call hears the audio and writes the card with no transcript step in between | First, on every press |
| Backup, Meta Model API | Muse Voice Transcribe `muse-voice-transcribe-1.0` in PUSH_TO_TALK mode, then `muse-spark-1.3` | Voice Transcribe writes a transcript, and Muse Spark turns it into the card with a JSON schema | Once, when the main route fails, returns text that does not parse, or sends no answer token within 8 s |

Muse Spark Open hears the audio itself, which is why it is the main route. The Meta Model API route keeps cards coming when the main route is down. Auto is the default, and a route without a key is skipped. Settings can pin either route, and Open weights only keeps the backup off.

Both routes stream. The server parses the model's JSON, clamps each field to its width cap and sends one card event. A card is never blank. When no route returns readable JSON, the raw text shows as an Unformatted card with a Retry button.

## Privacy and consent

### What stays on the device

1. Up to 2 minutes of sound, in memory only, never on disk and never in browser storage. Pause wipes it at once and stops every track, and so does closing the tab.
2. After a press, the clip stays in memory for 2 minutes so Further back and the language chips can reuse it. Then it is zeroed.
3. Cards stay in the tab. Export .md is the only way to save them.
4. Settings (languages, names, window, text size) are the only thing Catch Up keeps on the device.

### What leaves, and when

1. Only on a press, and only the slice the memory bar lights up. With it go the card language and, if you set them, the names people call you and the session hint.
2. Catch Up's server streams the card straight back and stores no audio, transcripts or card text. Its logs hold the time, route, model, window, byte size, stage timings and status of each press. Never audio, transcripts, card text, names, hints, IP addresses or keys.
3. The main route calls Baseten synchronously. Baseten documents that it keeps no inputs or outputs of synchronous inference ([Baseten security](https://docs.baseten.co/observability/security)).
4. The backup route calls the Meta Model API in Standard mode, where Meta does not use content to train its models. Meta can still retain content under its [terms of service](https://dev.meta.ai/legal/terms-of-service), so Catch Up makes no zero retention claim for that route. Pick Open weights only in Settings to keep the backup off.
5. No analytics, no accounts and no cookies.

### Consent

1. Every listening session starts with the People here know I'm using Catch Up tick, which lasts only for that page session.
2. The heads-up line comes in English, Japanese and Chinese, with Copy for chat.
3. Use it openly and follow local rules. In class, ask the instructor or the disability office first.
4. The panel always shows up in screen shares. Nothing hides it from capture.
5. Cards are written by AI and can be wrong. The line to say is AI-suggested and only restates or confirms.
6. Catch Up is for people 18 and over.

Meta's geographic use policy restricts its model services in mainland China, Hong Kong and Macau. Catch Up is not offered or promoted there.

### Attribution

Built with Muse Spark Open, used under the [Muse Model License](https://huggingface.co/meta-models/Muse-Spark-Open-816B-A42B/blob/main/LICENSE.md). Catch Up is an independent project. It is not made or endorsed by Meta.

## Limits

1. Cards can be wrong. A fact marked unsure needs a check.
2. Memory holds 120 s. A press sends 30, 60 or 120 s, or less when memory holds less.
3. The server takes clips from 1 s to 125 s and request bodies up to 4,400,000 bytes, and it ends a press after 20 s.
4. Live presses are limited to 30 per client per hour and 500 per server instance per day. Both limits live in memory and are best effort.
5. A tab in this browser needs Chrome or Edge on a computer. Apps on this computer needs Chrome or Edge on Windows or ChromeOS, or the Windows app. Safari, Firefox and phones get the microphone only.
6. Capture needs a secure page, so use localhost or an https address.
7. Catch Up has no live captions, no running transcript, no minutes, no automatic triggers and no meeting bots. It never answers on your behalf.

## Status

As of November 2, 2026, both routes, the web app, the Windows app and the eval runner are built and pass their tests. The routes follow the providers' published request formats and are tested against stand-in streams. They have not been called with real keys yet, so this README gives no speed or accuracy numbers. Public sample clips need written consent from every voice, and none are published yet.

## Setup

You need Node 22 or newer.

```bash
npm install
cp .env.example .env.local    # in PowerShell, Copy-Item .env.example .env.local
```

Put the keys the project owner gives you into `.env.local`. `BASETEN_API_KEY` turns on the main route and `MODEL_API_KEY` turns on the backup route. Keys live only in `.env.local`, which git ignores, or in the Vercel project settings. The server reads them, they never reach the browser, they never take the `NEXT_PUBLIC_` prefix, and nothing logs them. Never commit a key.

Without keys the app still runs, and a press says live cards aren't set up on this server yet.

`.env.example` lists every setting with its default. The ones you are most likely to change are these.

| Variable | Default | Purpose |
| --- | --- | --- |
| `CATCHUP_ROUTE` | `auto` | Route for a press that asks for Auto |
| `LIVE_ENABLED` | `1` | `0` stops every live call |
| `RATE_LIMIT_PER_HOUR` | `30` | Live presses per client per hour |
| `DAILY_PRESS_CAP` | `500` | Live presses per server instance per day |
| `BASETEN_MODEL` | `meta-models/muse-spark-open-1026` | Main route model |
| `META_CARD_MODEL` | `muse-spark-1.3` | Backup route card model |
| `META_ASR_MODEL` | `muse-voice-transcribe-1.0` | Backup route transcription model |

## Run

```bash
npm run dev     # http://localhost:3000
npm run build
npm start       # serves the production build
```

On Vercel, set the keys as environment variables of the project. `POST /api/card` runs on the Node runtime with a 60 s max duration, and `GET /api/health` says which routes have keys without ever returning one.

## Test

```bash
npm run typecheck
npm run lint
npm test                  # vitest
npm run check:copy        # writing rules for the UI copy and this README
cd desktop && npm test    # the Windows app shell, with a stand-in for Electron
```

## Eval

The eval sends short scripted conversations through the same `/api/card` handler the app uses and scores each card against labels written from the scripts. It reports time to the first token and to the full card, Asked you accuracy and false alarms, recall of names, numbers and dates, valid JSON on the first try and the fallback rate.

```bash
npm run clips             # synthetic clips with the Windows voices, Windows only
npm run eval -- --dry-run # checks scripts, audio and headers, sends nothing
npm run eval              # every live route with a key, 3 runs each
```

Raw results stay in `eval/results/raw`, which git ignores, and `eval/results/summary.md` holds the tables. Synthetic clips are for development and the eval only, and they are never shipped or filmed. The details are in [eval/README.md](eval/README.md).

## Windows app

`desktop` holds a thin Electron 45 shell around the web app. It adds a global Ctrl+Alt+C that works while Zoom, Teams or a lecture has focus, a compact panel that stays on top without taking focus from your call, system audio without the share picker, and a tray icon that shows when Catch Up is listening. The panel still shows up in screen shares.

```powershell
npm run dev      # in the repo root, serves http://localhost:3000
cd desktop
npm install
npm start
```

Set `CATCHUP_URL` to load a deployed copy instead. The Windows app runs from source. There is no installer, no signed build and no published exe. The full guide and the checks for a demo PC are in [desktop/README.md](desktop/README.md).

## Project structure

```text
src/app/               landing page, privacy page, POST /api/card and GET /api/health
src/components/        the Panel, card, history, setup sheet and source step
src/lib/audio/         capture engine, sources, level meter, silence gate, WAV, sample playback
src/lib/press/         press pipeline, from snapshot to the streamed card
src/lib/card/          card schema, prompt, parsing and clamping, local strings, receipts, export
src/lib/providers/     Route B on Baseten, Route A on the Meta Model API, the Auto fallback
src/lib/server/        settings, guards, body cap, request handler, log line
src/lib/client/        UI controller, settings, hotkeys, floating window, copy
src/lib/samples/       sample clip catalog and saved real cards
src/lib/protocol.ts    header, event stream, limits and error codes shared by browser and server
public/worklets/       the AudioWorklet ring buffer
desktop/               the Windows app (Electron shell, runs from source)
eval/                  eval scripts, scoring and runner
scripts/               synthetic clip maker, copy checker, saved card tool
docs/ARCHITECTURE.md   module boundaries, HTTP contract and privacy invariants
```

## Hackathon

Built for the Meta Global AI Developer Hackathon (Meta x Cerebral Valley, Indie track) between October 27 and November 4, 2026.
