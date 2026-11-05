# Meta-only synthetic follow-up

Run on November 4, 2026 in New York time. The source run began at `2026-11-05T01:36:52.140Z`, which was November 4 at 20:36 ET. This report preserves the complete aggregate and per-clip results without credentials, private paths, transcripts or raw model responses.

## What changed and what this measures

The follow-up used the `card-v2` prompt, which tells Muse Spark to use the supplied transcript as its only evidence, preserve meaning across languages, extract explicit facts and distinguish the person addressed from the speaker. The application cap was extended to 30 seconds at the client and 29 seconds for server provider work.

The real Meta Model API processed the same 10 synthetic conversation clips and noise-only control from [the version 1 scripts](../clips.json), three runs per clip. Each request used its scripted reference time and the `meta_api` route with `muse-voice-transcribe-1.0` and `muse-spark-1.3`. No human recordings were used.

This batch ran in an isolated process started before the later literal-quote guard. It measures the prompt update and timeout configuration, not that guard. The guard now removes a quote if its words do not occur together in the transcript after Unicode and whitespace normalization. It does not verify summaries, facts, speaker attribution or transcription accuracy, and it does not invent a replacement quote.

The [initial one-run baseline](meta-only-synthetic-2026-11-04.md) remains available. The two reports use different run counts, and model responses are nondeterministic. Descriptive differences are not evidence of statistically demonstrated improvement. Both batches are developmental checks and do not estimate performance in natural conversations.

## Latency and complete quality results

Timing starts at the request in the local eval process and ends at its event. It excludes browser upload, phone networking and deployment overhead. First token is the Writing your card stage, while full card is the card event.

| Metric | Result |
| --- | --- |
| Presses | 33, 11 clips with 3 runs each |
| Cards returned | 33 |
| API errors or timeouts in this batch | 0 |
| First token p50 | 12.9 seconds |
| First token p95 | 18.9 seconds |
| Full card p50 | 14.2 seconds |
| Full card p95 | 20.3 seconds |
| Binary Asked you accuracy | 94% (31 of 33) |
| False alarms for Asked you | 5% (1 of 21) |
| Missed direct asks | 8% (1 of 12) |
| All four ask states | 79% (26 of 33) |
| Name recall | 70% (23 of 33) |
| Number recall | 76% (16 of 21) |
| Date recall | 79% (26 of 33) |
| Heard as expected | 94% (31 of 33) |
| Say line as expected | 91% (30 of 33) |
| Say language | 100% (26 of 26) |
| Card language | 100% (33 of 33) |
| Teen and tens flagged | 67% (4 of 6) |
| Term recall | 33% (1 of 3) |
| Valid JSON first try | 100% (33 of 33) |
| Clean JSON | 27% (9 of 33) |
| Unformatted cards | 0% (0 of 33) |
| Fallback rate | 0% (0 of 33), pinned Meta-only route |

Binary Asked you checks whether the listener was directly asked something. The four-state check distinguishes `you`, `room`, `mentioned` and `none`. Recall counts expected items appearing in the card's fact fields, not full transcription accuracy. A card that parses on the first attempt may still need normalization. Clean JSON was 9 of 33, not 33 of 33. Schema-valid output can still be factually wrong.

The originally planned 3 to 5 second demo timing was not achieved. A 30-second cap avoids cutting off some slower responses but is not a latency guarantee. The separate first live request's roughly 19-second timeout under the earlier cap remains disclosed in the baseline report.

## Per-clip results

Returned states are shown in run order. Recall combines all three runs for that clip.

| Clip | Expected ask | Returned asks | Fact recall |
| --- | --- | --- | --- |
| `en-ask-by-name` | you | you, you, you | 75% (9 of 12) |
| `en-open-question` | room | room, room, room | 100% (9 of 9) |
| `en-mention` | mentioned | mentioned, mentioned, none | 100% (9 of 9) |
| `ja-lecture-term` | room | none, room, none | 33% (3 of 9) |
| `zh-ask-time` | you | you, you, you | 50% (3 of 6) |
| `mixed-three-languages` | room | room, room, none | 67% (6 of 9) |
| `en-lecture-far` | room | room, room, none | 67% (8 of 12) |
| `en-office-hours` | you | you, you, you | 83% (10 of 12) |
| `en-cafe-noisy` | you | you, you, none | 50% (3 of 6) |
| `en-small-talk` | none | none, none, you | 100% (6 of 6) |
| `control-noise-only` | none | none, none, none | No data |

Remaining failures include a missed direct ask in the noisy cafe, a false direct ask during small talk, and inconsistent open-question detection in Japanese, mixed-language and far-field clips. These results do not establish that hallucinations, missing facts or incorrect ask states have been eliminated.

## Separate integration checks

Model listing returned HTTP 200. Local browser checks using the updated prompt returned an English card from an 18-second synthetic sample in 9.1 seconds and a Japanese card from the retained transcript in 9.6 seconds. The retained snapshot later expired and the audio memory cleared. These are individual integration checks outside the 33-run batch, not extra observations in its percentiles or accuracy scores.

The current automated suite contains 513 passing tests. The production build, type checks, lint and copy checks pass. After adding the literal-quote guard, a separate request through the local production HTTP server returned a card in 12.8 seconds with mock mode off. The production page showed the Meta attribution and no public samples. This was one synthetic integration request outside the 33-run batch. Its private raw artifact was `2026-11-05T01-45-32-140Z-meta_api.json`.

No Vercel deployment was created. Natural voice evaluation, real phone capture, deployment and screen-reader checks are not claimed here.

## Retrospective quote audit

After the batch completed, its stored results were checked with the new guard's Unicode and whitespace normalization. Of the 33 cards, 24 contained a quote. Three quotes did not occur as contiguous text in their corresponding transcripts, affecting `mixed-three-languages` runs 1 and 2, and `zh-ask-time` run 3. The new guard would omit those three quotes.

This was a retrospective audit, not a replay through the model or a new quality benchmark. The original batch metrics above remain unchanged. Matching a quote to the transcript does not establish the accuracy of transcription, summary, facts or speaker labels. Omitting an unsupported quote also does not repair those other fields.

## Reproduce and interpret

```powershell
npm.cmd run clips
npm.cmd run eval -- --route=meta_api --runs=3
```

On Windows, `npm.cmd` avoids the observed PowerShell wrapper argument issue. The direct runner is `node node_modules/tsx/dist/cli.mjs eval/run.ts --route=meta_api --runs=3`. Running these commands on the current code includes later guards and therefore is a new run, not a recreation of this process snapshot.

The source raw artifact was `2026-11-05T01-36-52-140Z-meta_api.json`, retained privately. The aggregate came from [the eval runner](../run.ts) and [the scoring code](../metrics.ts). See [the evaluation guide](../README.md) for dataset selection and scoring. Use a separate report for any later provider revision, recording dataset or deployed environment.
