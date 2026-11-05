# Catch Up submission checklist

Prepared November 4, 2026 for the Meta-only build. This is a release checklist, not a declaration that every item is complete.

## Scope

The submission route is Muse Voice Transcribe `muse-voice-transcribe-1.0` followed by Muse Spark `muse-spark-1.3` on Meta Model API. Use `CATCHUP_ROUTE=meta_api`, a server-only `MODEL_API_KEY`, no Baseten key and `ALLOW_MOCK=0`.

Show the one-press recovery flow, the source controls, the card in the chosen language and the receipt. Do not describe this build as using Muse Spark Open, hearing audio without a transcription step, comparing providers, or surviving one provider's outage through another. The optional Baseten adapter does not demonstrate an open-weight model submission.

## Release gates

Record a result and evidence for each gate. A key in the environment or a green health response alone does not pass the live API gate.

| Gate | Evidence required |
| --- | --- |
| Model access | Both Meta model IDs are available to the selected account and one real request returns a usable card |
| Synthetic API check | Saved run identifies the audio as synthetic, shows the returned card, latency and failures, with no claim about real conversation accuracy |
| Real voice evaluation | Consented recordings of the 10 eval scripts plus the noise-only control, 3 runs per clip on `meta_api`, with the dataset and failure counts disclosed |
| Public samples | Written permission to publish every voice, real recordings under 30 seconds, actual muffle timings and at least one saved real card for each shipped sample |
| Web flow | Production build, microphone capture, tab capture where supported, language change, Pause, cancellation, rate limit and live-off behavior checked |
| Windows flow | Source-run Electron panel, system audio, global hotkey and Pause checked against the final web build |
| Phone | Actual phone microphone flow, interruption handling and one-thumb controls checked, with limitations disclosed |
| Accessibility | Keyboard-only use and an actual screen-reader pass on the final UI |
| Deployment | Exact deployment inspected, server-only secret set, Meta route active, no dev clips or mock mode, external access checked |
| Public materials | Repository contents and attribution reviewed, real demo video under 3 minutes, working product and repository URLs |
| Owner actions | Owner approves publishing the repository, deployment, video and any post, then approves the final submission |

No consented recordings were supplied at the start of this work. Do not mark the public samples, real voice evaluation or filmed demo gates complete until the recordings exist. Keep this checklist's evidence current when a gate is completed.

Recorded evidence on November 4, 2026 confirms model access and real API card generation. The [initial baseline](../eval/results/meta-only-synthetic-2026-11-04.md) exposed unsupported content and an incorrect no-speech judgment. A transcript-focused prompt was followed by [33 synthetic runs](../eval/results/meta-only-followup-2026-11-04.md), all returning cards, but with remaining ask classification and fact recall errors. That batch predates the literal-quote guard and is not a validation of it. Local browser checks returned an English card and a Japanese transcript redo. The current 513-test suite, production build, type checks, lint and copy checks pass.

After the guard was added, one request through the local production HTTP server returned a real card in 12.8 seconds with mock mode off. The production page showed no public samples and the Meta attribution. This verifies one final-build interaction. A retrospective audit of the earlier batch found 3 quotes absent from their transcripts, which the guard would remove, but it does not verify the rest of those cards. No Vercel deployment has been created. Human speech, deployed flows, the final film and the remaining release gates still need their own evidence.

## Record the public samples

Start with `sample-office-hours`, which has one speaking role and can be recorded by the project owner alone. The other two samples can be staged, including one consenting performer reading several roles. Describe a staged recording honestly, and do not claim a multi-person field trial from a single performer.

Use a quiet room and a natural pace. Record each script as a separate file, with no unrelated conversation before or after it. Keep the full clip under 30 seconds. Do not play synthetic development speech into the recording. The names and situations below are fictional.

### Office hours

File stem `sample-office-hours`. Four lines, one performer. Siobhan is pronounced roughly shih-VAWN.

> Hi, come on in. I'm Siobhan, the TA for this section.
>
> So, about the final paper.
>
> It's fifteen percent of your grade, and it's due on the thirteenth.
>
> Does that sound okay?

### Asked by name

File stem `sample-ask-by-name`. Keep Sam as the listener name so it matches the sample metadata.

| Role | Line |
| --- | --- |
| Marcus | Okay, last thing before we wrap up. The client wants a live demo this week. |
| Lena | I can prep the slides, but I'm out on Friday. |
| Marcus | Sam, does Thursday work for the demo, or should we push it to Monday? |

### Three languages

File stem `sample-three-languages`. Preserve the mixed-language line as spoken.

| Role | Line |
| --- | --- |
| Dana | Okay, quick check on the group project. |
| Marcus | So the 締め切り is 下周三, right? |
| Xiaoyu | 对，下周三。张老师说了，不要迟到。 |
| Aoi | じゃあ、スライドは私が作るね。 |
| Dana | Great. Sam, can you book the study room for this Friday? |

These are the existing scripts in `eval/clips.json`. If the spoken words change, update the script and expected labels before scoring the new recording. A sample run uses the current press time, so do not promise the historical November 5, 6 or 11 dates from the scripted benchmark.

## Consent and recording handoff

For each performer, keep a private record of the date, the exact clip IDs, permission to process the recording through Meta, and whether permission also covers the public app, public repository and demo video. A person's permission for measurement alone does not allow publication. Do not put signatures, contact details or consent documents in the public repository. The owner must also explicitly agree to publication when she is the only performer.

Keep original audio outside the repository or in the git-ignored `eval/recorded` folder. Convert each final clip to 16 kHz mono 16-bit PCM for evaluation. This command strips metadata from a recording already approved for processing.

```powershell
ffmpeg -i eval/recorded/sample-office-hours-original.m4a -ac 1 -ar 16000 -c:a pcm_s16le -map_metadata -1 eval/recorded/sample-office-hours.wav
```

The final public recording goes under `public/samples/`, not `public/samples/dev/`. Add it to `PUBLIC_CLIPS` in `src/lib/samples/catalog.ts` with the real duration, the actual key sentence timing, and `consent: "written"` only after permission is recorded. Do not reuse synthetic timing values without checking the real recording.

Run the samples through the Meta route, then save only the real result. This example waits until all three public sample recordings are present.

```powershell
npm run eval -- --set samples --route meta_api --runs 3 --press-time now --audio-dir eval/recorded
npx tsx scripts/save-cached-card.ts --raw eval/results/raw/RESULT.json --clip sample-office-hours --lang ja
```

Replace `RESULT.json` with the actual raw result. To save a different card language, run the samples again with `--card-lang en` or `--card-lang zh`, then use the matching result. The saver rejects mock cards, synthetic audio and samples without recorded public consent.

## Three-minute recording plan

Use the production build or the exact deployment under review. Keep the model receipt visible. Do not speed up the model response or insert a card from a different run. If a later take succeeds after a failure, do not claim that one take establishes reliability.

| Time | What to show |
| --- | --- |
| 0:00 to 0:25 | A consenting speaker asks Sam a question in the staged clip. Press Catch up, wait for the real card and read its confirmation line. Show the real elapsed time. |
| 0:25 to 0:40 | Explain the problem with one personal example of missing a sentence. Keep health claims out of the demo. |
| 0:40 to 1:05 | Show the same real clip as a Japanese card, then change to English or Chinese. Explain that the Meta transcript can be reused for the language change. |
| 1:05 to 1:30 | Use the office-hours clip to show a name, a number and a date. Show the actual uncertainty marks and quote, even if a model detail needs correction. |
| 1:30 to 1:55 | Show the consent control, the memory bar and the request trace. Distinguish the browser's one audio upload from the server's transcription and card-generation calls. Pause and show that capture stops and memory clears. |
| 1:55 to 2:20 | Show the architecture and code. Browser ring buffer, WAV on press, Muse Voice Transcribe, Muse Spark, streamed card. Show the actual commit history for work completed during the event. |
| 2:20 to 2:40 | Show only measured evaluation numbers, labeled with audio source, clip count and runs. If real voice evaluation is incomplete, say so instead of using synthetic results as a substitute. |
| 2:40 to 3:00 | Show the working product and public repository URLs after approval. Finish with the actual Meta models used. A future glasses idea is optional and must be labeled a concept. |

If a response is too slow to fit this plan, change the shot timings while preserving the uncut live interaction. Do not promise the original 3 to 5 second target before measuring it.

## Final review packet

Before asking for publication or submission approval, collect the exact repository commit, reviewed deployment URL, real evaluation table, final video file, public voice permissions status and all remaining limitations in one review packet. Redact secrets from terminal windows and browser panels before filming. Do not publish raw evaluation files or private recordings just to make the repository reproducible.

The owner has authorized API key setup and live verification. Publishing, posting and submission remain separate owner decisions. A technical check that passes does not itself authorize those actions.
