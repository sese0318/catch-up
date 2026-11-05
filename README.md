# Catch Up

Missed something? Press once.

Catch Up keeps the last 2 minutes of sound in memory, and nothing leaves your device until you press. One key or tap turns the last 30, 60 or 120 seconds of a meeting, a class, a conversation in person or a video into a short card in English, Japanese or Simplified Chinese.

Built with Muse Voice Transcribe and Muse Spark on Meta Model API.

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

Catch Up is an accessibility and language tool, not a medical device. It never reads emotions or identifies anyone by voice.

## How it works

1. **Pick a source.** People in the room through the microphone, a tab in this browser, or apps on this computer. Tick People here know I'm using Catch Up. Show heads-up opens a line to say or paste into the chat, and it names the most a press can send, up to the last 2 minutes. The page keeps the last 2 minutes in an AudioWorklet ring buffer in memory.
2. **Press.** Click Catch up, press Ctrl+Alt+C (Ctrl+Shift+Space and Ctrl+Alt+Space also work), or tap the button on a phone. The page slices the window you chose and checks that someone spoke. If no one did, nothing is sent. Otherwise one 16 kHz mono WAV goes to the server.
3. **Read the card.** The server hands the clip to a Meta model and streams the card back. While it is written, the panel shows a short line you can say to buy a moment.

On a computer, Float on top keeps the panel in a small window above your call, in browsers that support it.

## Meta Model API first

| Route | Models | How it hears the clip | When it runs |
| --- | --- | --- | --- |
| Submission route, Meta Model API | Muse Voice Transcribe `muse-voice-transcribe-1.0` in PUSH_TO_TALK mode, then `muse-spark-1.3` | Voice Transcribe writes a transcript, and Muse Spark turns it into the card with a JSON schema | Every live press in the Meta-only setup |
| Optional adapter, open weights | Muse Spark Open on Baseten, `meta-models/muse-spark-open-1026` | The WAV goes in as an `audio_url` data URL, so one call hears the audio and writes the card | Only with a separate Baseten key and a route setting that selects it |

The submission setup uses `CATCHUP_ROUTE=meta_api` and only `MODEL_API_KEY`. No Baseten or Modal account is needed. Auto in the UI follows that server setting, and the receipt names the models that actually ran. A language change can reuse the Meta transcript, so it does not need to upload the audio again.

The optional Baseten adapter remains in the code but is not part of the Meta-only submission. To use both providers later, set both keys and change `CATCHUP_ROUTE` to `auto`. That policy tries Baseten first and falls back to Meta once on a provider error, unreadable JSON, or no answer token within 8 seconds. Meta-only has no second-provider fallback and makes no claim to use Muse Spark Open.

The server streams progress, parses the model's JSON, clamps each field to its width cap and sends one card event. When no route returns readable JSON, the raw text shows as an Unformatted card with a Retry button.

## Privacy and consent

### What stays on the device

1. Up to 2 minutes of sound, in memory only, never on disk and never in browser storage. Pause wipes it at once and stops every track, and so does closing the tab.
2. After a press, the clip stays in memory for 2 minutes so Further back and the language chips can reuse it. Then it is zeroed.
3. Cards stay in the tab. Export .md is the only way to save them.
4. Settings (languages, names, window, text size) are the only thing Catch Up keeps on the device.

### What leaves, and when

1. Audio leaves only on a press, and only the slice the memory bar lights up. With it go the card language, the language people around you speak, the source type, your local time and time zone, and a random id for this tab. The names people call you and the session hint go too, if you set them. A sample press sends the sample's own listener names and never your hint. On the Meta route, a language change sends the retained transcript to make a new card.
2. Catch Up's server streams the card straight back and stores no audio, transcripts or card text. Its logs hold the time, route, model, window, byte size, stage timings and status of each press. Never audio, transcripts, card text, names, hints, IP addresses or keys.
3. The Meta route sends audio to Muse Voice Transcribe, then sends the transcript to Muse Spark. Catch Up's own storage behavior does not describe Meta's retention or use of that content. Read the account's current data-use notice and Meta's [terms of service](https://dev.meta.ai/legal/terms-of-service) before sending a recording. Catch Up does not promise zero provider retention or that credit-backed requests are excluded from model improvement.
4. The optional Baseten adapter sends audio to Baseten synchronously and passes the random tab id as a session affinity header. Baseten documents that it keeps no inputs or outputs of synchronous inference ([Baseten security](https://docs.baseten.co/observability/security)). Baseten is not called in the Meta-only setup.
5. No analytics, no accounts and no cookies.

### Consent

1. Every listening session starts with the People here know I'm using Catch Up tick, which lasts only for that page session.
2. The heads-up line comes in English, Japanese and Chinese, with Copy for chat.
3. Use it openly and follow local rules. In class, ask the instructor or the disability office first.
4. The panel always shows up in screen shares. Nothing hides it from capture.
5. Cards are written by AI and can be wrong. The line to say is AI-suggested and only restates or confirms.
6. Catch Up is for people 18 and over.

Meta's [geographic use policy](https://dev.meta.ai/legal/geographic-use-policy) restricts its model services in a list of territories that includes mainland China, Hong Kong and Macau. Catch Up is not promoted there. On Vercel the server reads the caller's country from Vercel's own header and refuses the Meta route for listed territories, including when Auto selects it.

### Attribution

The Meta-only version uses Muse Voice Transcribe and Muse Spark through Meta Model API. Catch Up is an independent project. It is not made or endorsed by Meta.

The optional Muse Spark Open adapter is subject to the [Muse Model License](https://huggingface.co/meta-models/Muse-Spark-Open-816B-A42B/blob/main/LICENSE.md). If you enable that route, retain its required attribution, Built with Muse Spark Open. Its presence in the code is not evidence that a submission used it.

## Limits

1. Cards can be wrong. A fact marked unsure needs a check.
2. Memory holds 120 s. A press sends 30, 60 or 120 s, or less when memory holds less.
3. The server takes clips from 1 s to 125 s and request bodies up to 4,400,000 bytes. The client ends a press after 30 s, while the server stops provider work after 29 s so it can send a timeout response.
4. Live presses are limited to 30 per client per hour, 2 in flight per client at once, and 500 per server instance per day. The limits are checked again right before a press counts, so parallel presses cannot overshoot them. They live in memory and are best effort, and `/api/health` reports only the kill switch, because each instance keeps its own count. On Vercel the client is the `x-real-ip` address (an IPv6 address counts by its /64). Anywhere else forwarding headers are ignored and the whole machine is one client.
5. A tab in this browser needs Chrome or Edge on a computer. Apps on this computer needs Chrome or Edge on Windows or ChromeOS, or the Windows app. Safari, Firefox and phones get the microphone only.
6. Capture needs a secure page, so use localhost or an https address.
7. Catch Up has no live captions, no running transcript, no minutes, no automatic triggers and no meeting bots. It never answers on your behalf.

## Status

The November 4, 2026 submission configuration uses Meta Model API only. Model listing returned HTTP 200 and both configured models produced real cards. The current automated suite has 513 passing tests and the production build passes. These checks do not establish natural-speech accuracy.

An initial synthetic baseline exposed an unsupported Mandarin quote and a false no-speech judgment on a mixed-language transcript. The prompt now explicitly uses the transcript as evidence. A follow-up batch with that prompt returned 33 cards from 11 synthetic clips run 3 times each, with no API errors or timeouts. Full-card time was 14.2 seconds at p50 and 20.3 seconds at p95, excluding browser upload time. Binary Asked you accuracy was 94% (31 of 33), the full four-state ask accuracy was 79% (26 of 33), and name, number and date recall were 70%, 76% and 79%. There was one missed direct ask and one false direct ask. All 33 responses parsed on the first provider attempt, but only 9 of 33 were clean JSON without normalization.

That batch used `card-v2` before the later literal-quote guard was added. The guard now removes a claimed quote if it is not a contiguous part of the transcript after Unicode and whitespace normalization. A later audit found 3 such quotes among the 24 quoted cards in the batch. The guard would omit those 3, but this audit is not a rerun. It does not validate summaries, facts, speaker attribution or the transcription itself. The 33-run metrics must not be presented as a benchmark of this later guard. Different run counts and nondeterministic model responses also prevent a claim of statistically demonstrated improvement over the initial baseline.

Local browser checks with the updated prompt returned an English card from an 18-second synthetic sample in 9.1 seconds and a Japanese card from the retained transcript in 9.6 seconds. The retained snapshot expired and its audio memory cleared. A separate first live request had timed out at about 19 seconds under the former 20-second cap, with a direct retry in 11.957 seconds. These separate checks are outside the batch statistics. See [the initial baseline](eval/results/meta-only-synthetic-2026-11-04.md) and [the follow-up results and remaining failures](eval/results/meta-only-followup-2026-11-04.md).

After the quote guard was added, one synthetic request through the local production HTTP server returned a card in 12.8 seconds with mock mode off. The production page showed the Meta attribution and no public samples. Type checking, lint and copy checks also pass. This confirms one final-build HTTP interaction, not deployed or natural-speech performance. No Vercel deployment has been created.

Public sample clips need written consent from every voice. No such recordings have been supplied yet, so the production sample catalog is empty. Synthetic development clips are excluded from production and must not appear in the submission video. Real voice evaluation, the filmed demo, deployed checks, phone hardware and screen-reader checks remain release gates. See [the submission checklist](docs/SUBMISSION.md) for the current scope and recording steps.

## Setup

You need Node 22 or newer.

```bash
npm install
cp .env.example .env.local    # in PowerShell, Copy-Item .env.example .env.local
```

Create a Meta Model API key and put it in `MODEL_API_KEY` in `.env.local`. Set `CATCHUP_ROUTE=meta_api`, leave `BASETEN_API_KEY` empty, and keep `ALLOW_MOCK=0` for live verification and recording. Confirm that your account can use both model IDs before treating the setup as ready. An available credit balance alone does not verify model access.

Keys live only in `.env.local`, which git ignores, or in the Vercel project settings. The server reads them, they never reach the browser, they never take the `NEXT_PUBLIC_` prefix, and nothing logs them. Never commit a key or paste one into an issue, demo, screenshot or report.

Without keys the app still runs, and a press says live cards aren't set up on this server yet. The page checks `/api/health` first, so a press the server would refuse unread never uploads the clip.

`.env.example` lists every setting with its default. The ones you are most likely to change are these.

| Variable | Default | Purpose |
| --- | --- | --- |
| `CATCHUP_ROUTE` | `meta_api` in the submission setup | Route for a press that asks for Auto. The server fallback when unset is `auto` |
| `LIVE_ENABLED` | `1` | `0` stops every live call |
| `RATE_LIMIT_PER_HOUR` | `30` | Live presses per client per hour |
| `DAILY_PRESS_CAP` | `500` | Live presses per server instance per day |
| `META_CARD_MODEL` | `muse-spark-1.3` | Meta route card model |
| `META_ASR_MODEL` | `muse-voice-transcribe-1.0` | Meta route transcription model |
| `BASETEN_MODEL` | `meta-models/muse-spark-open-1026` | Optional Baseten model, unused in the submission setup |

## Run

```bash
npm run dev     # http://localhost:3000, on this computer only
npm run build
npm start       # serves the production build, on this computer only
```

`npm run dev` and `npm start` listen on 127.0.0.1, so other devices on the network cannot spend your keys. localhost, the Windows app and a tunnel such as cloudflared still reach it. Record the demo against `npm run build` and `npm start` or the Vercel URL, since the dev server adds its own overlays.

On Vercel, set `MODEL_API_KEY`, `CATCHUP_ROUTE=meta_api` and the other server settings as environment variables of the project. `POST /api/card` runs on the Node runtime with a 60 s max duration, and `GET /api/health` says which routes have keys without ever returning one. A configured health response is not a successful model call.

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
npm run clips                                        # synthetic development audio, Windows only
npm run eval -- --route meta_api --dry-run            # sends nothing
npm run eval -- --route meta_api --runs 1 --clip en-ask-by-name
npm run eval -- --route meta_api --runs 3 --audio-dir eval/recorded
```

The one-clip command is a synthetic live API check, not a real-world benchmark. The last command requires consented recordings of the 10 eval scenes and the noise-only control first. Raw results stay in `eval/results/raw`, which git ignores, and `eval/results/summary.md` holds the tables. Synthetic and recorded results must be labeled separately. Synthetic clips are never shipped or filmed. The details are in [eval/README.md](eval/README.md).

In Windows PowerShell, use `npm.cmd run eval -- --route=meta_api --runs=1 --clip=en-ask-by-name` if the `npm.ps1` wrapper loses the argument separator. The direct equivalent is `node node_modules/tsx/dist/cli.mjs eval/run.ts --route=meta_api --runs=1 --clip=en-ask-by-name`.

## Windows app

`desktop` holds a thin Electron 45 shell around the web app. It adds a global Ctrl+Alt+C that works while Zoom, Teams or a lecture has focus, a compact panel that stays on top without taking focus from your call, system audio without the share picker, and a tray icon that shows when Catch Up is listening. The panel still shows up in screen shares.

```powershell
npm run dev      # in the repo root, serves http://localhost:3000 on this computer only
cd desktop
npm ci           # installs the exact versions in desktop/package-lock.json
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
