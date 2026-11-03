# Catch Up eval

The eval sends short scripted conversations through the same `/api/card` handler the app uses, then scores each card against labels written from the scripts. It measures how fast a card arrives on each Meta route, how often Asked you is right, and how many names, numbers and dates make it into the facts.

## What is here

| File | What it holds |
| --- | --- |
| `clips.json` | 10 scripts for the scenes in the spec, 3 sample scripts and a control clip with no speech, each with gold labels (the ask, names, numbers, dates resolved against the press time, heard, languages). Names and companies are fictional. |
| `clips.ts` | the schema of `clips.json` and the press metadata each clip is sent with |
| `press.ts` | sends one clip and reads the event stream back |
| `metrics.ts` | pure scoring and the Markdown tables |
| `run.ts` | the runner behind `npm run eval` |

The 10 scenes are an English ask by name, an open question to the room, a mention without a question, a Japanese lecture with a term, a Mandarin exchange with a time, a meeting in English, Japanese and Chinese, a far-field lecture with a date and teen numbers, office hours with names, a noisy cafe, and small talk with no ask.

## Make the clips

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/make-synthetic-clips.ps1
```

The script speaks every line with the Windows voices (Microsoft Zira, David, Haruka and Huihui), adds room tone or cafe noise with ffmpeg, and peak-normalizes each clip the way the press pipeline does. It writes 16 kHz mono 16-bit WAV files to `eval/clips` and copies the 3 sample clips to `public/samples/dev`. Both folders are git-ignored. Synthetic clips are for development and the eval only. They are never shipped or filmed.

For the real eval, consenting voices read the same scripts. Save each recording as `<id>.wav` in 16 kHz mono 16-bit PCM in one folder and pass it with `--audio-dir`.

## Run it

```bash
npm run eval -- --dry-run                            # checks scripts, audio and headers, sends nothing
ALLOW_MOCK=1 npm run eval -- --route mock --runs 1   # keyless smoke run, no model is called
npm run eval                                         # every live route with a key, 3 runs each
npm run eval -- --route open_weights,meta_api,auto   # pick routes
npm run eval -- --summary-only                       # rebuild the tables from saved runs
```

In PowerShell, set the variable first with `$env:ALLOW_MOCK = "1"`.

Keys come from `.env.local` and stay on this machine. The runner never prints them. By default it calls the handler in process with the hourly limit off and one client key per pass. With `--base-url` it talks to a local server instead, and only to localhost or 127.0.0.1, so the eval never spends the deployed app's daily cap. Start that server with `RATE_LIMIT_PER_HOUR=0`.

Every press sends one whole clip with the press time from `clips.json`, so relative dates such as next Wednesday have one right answer. Use `--press-time now` only for runs that save cached sample cards.

## What it measures

| Column | Meaning |
| --- | --- |
| First token p50 and p95 | request start to the Writing your card stage |
| Full card p50 and p95 | request start to the card event |
| Asked you accuracy | cards that show the Asked you banner exactly when the script asks the listener |
| False alarms | Asked you on clips where the script asked someone else or no one |
| Name, number and date recall | script names, numbers and dates found in the card's facts, with other spellings and readings counted, and a date counted only once it is resolved to a month and day |
| Valid JSON first try | cards that parsed after exactly one provider attempt, without a retry or backup route. Older results without attempt telemetry are excluded |
| Fallback rate | cards that Auto served from the Meta Model API after Muse Spark Open failed |

A second table checks all four ask states (you, room, mentioned and none), heard, the say line, the say language, the card language, teen and tens numbers marked Check, term recall and Unformatted cards. A third shows every clip's ask on every run.

Times are measured inside the eval process, so they leave out the upload from a phone or laptop.

## Results

`eval/results/raw` holds every press with its card, timings and status. It is git-ignored, because consent covers measurement, not publishing. `eval/results/summary.md` holds the scripted eval tables for the README and the video, and `summary.json` the same numbers. The newest dataset selects the comparison, and only matching clips, languages, audio sources, script versions, run counts and execution modes are compared across routes. Mock runs get their own section that says no model was called.

Sample runs with `--set samples --press-time now` write `samples-now-summary.md` and `samples-now-summary.json` instead, so saving public sample cards never replaces the benchmark. Other sets and clock modes likewise get separate summary names. `--summary-only` rebuilds the scripted eval by default. Add `--set samples --press-time now` to rebuild the saved-sample summary.

## Saved sample cards

When a consented public sample clip has a real run, save its card for the times live calls fail, are capped or are off.

```bash
npm run eval -- --set samples --route open_weights --press-time now --audio-dir eval/recorded
npx tsx scripts/save-cached-card.ts --raw eval/results/raw/<file>.json --clip sample-ask-by-name --lang ja
```

The script refuses mock runs, synthetic audio, Unformatted cards and clips without written consent. It writes `src/lib/samples/cached-cards.json`, and every saved card names its live route and run date.
