# Meta-only synthetic API baseline

Run on November 4, 2026 in New York time. The source run began at `2026-11-05T01:28:56.463Z`, which was November 4 at 20:28 ET. This report contains aggregate developmental results, with no credentials, private machine paths, transcripts or raw model responses. It is the initial baseline, not a validation of later grounding or timeout changes.

## Method and scope

The real Meta Model API processed 10 scripted conversation clips and one noise-only control, one run per clip. Audio came from synthetic Windows voices reading [the version 1 scripts](../clips.json). Each press used the script's fixed reference time, November 2, 2026 at 10:30 in New York time unless the clip specifies another time. The route was pinned to `meta_api`, with `muse-voice-transcribe-1.0` for transcription and `muse-spark-1.3` for the card.

Times run from request start to the event in the local eval process. They exclude browser capture and upload, phone networking and deployment overhead. First token is the Writing your card stage. Full card is the card event. One run per clip provides only an initial check and does not estimate reliability across repeated runs or natural conversations.

## Failures outside the batch

Before this batch, a separate first live `en-ask-by-name` request timed out at about 19 seconds under the earlier 20-second press cap. A direct retry returned a card in 11.957 seconds. These preliminary calls are outside the batch table below. Its zero-error result is not an all-session success rate, and the cause of the first request's delay was not established.

The original 3 to 5 second demo target was not met by this batch. Do not use that target as a measured latency claim. Extending a timeout allows a slower response to finish, but does not itself reduce model latency or establish a new reliability rate.

## Batch results

| Metric | Result |
| --- | --- |
| Presses | 11 |
| Cards returned | 11 |
| Errors within this batch | 0 |
| First token p50 | 12.6 seconds |
| First token p95 | 15.7 seconds |
| Full card p50 | 13.8 seconds |
| Full card p95 | 17.1 seconds |
| Binary Asked you accuracy | 100% (11 of 11) |
| False alarms for Asked you | 0% (0 of 7) |
| Missed direct asks | 0% (0 of 4) |
| All four ask states | 82% (9 of 11) |
| Name recall | 55% (6 of 11) |
| Number recall | 57% (4 of 7) |
| Date recall | 64% (7 of 11) |
| Heard as expected | 82% (9 of 11) |
| Say line as expected | 91% (10 of 11) |
| Say language | 100% (8 of 8) |
| Card language | 100% (11 of 11) |
| Term recall | 100% (1 of 1) |
| Teen and tens flagged | No data |
| Valid JSON first try | 100% (11 of 11) |
| Clean JSON | 36% (4 of 11) |
| Unformatted cards | 0% (0 of 11) |
| Fallback rate | 0% (0 of 11), pinned Meta-only route |

Binary Asked you accuracy asks only whether the listener was directly asked something. The four-state check distinguishes `you`, `room`, `mentioned` and `none`, and is stricter. Recall measures expected items appearing in the card's fact fields, not full transcription accuracy. A parsed first-attempt card may still need normalization, so the valid-JSON result must be read beside clean JSON. Clean JSON was 4 of 11, not 11 of 11.

## Per-clip results

| Clip | Expected ask | Returned ask | Fact recall |
| --- | --- | --- | --- |
| `en-ask-by-name` | you | you | 75% (3 of 4) |
| `en-open-question` | room | room | 100% (3 of 3) |
| `en-mention` | mentioned | room | 100% (3 of 3) |
| `ja-lecture-term` | room | room | 100% (3 of 3) |
| `zh-ask-time` | you | you | 0% (0 of 2) |
| `mixed-three-languages` | room | none | 0% (0 of 3) |
| `en-lecture-far` | room | room | 0% (0 of 4) |
| `en-office-hours` | you | you | 75% (3 of 4) |
| `en-cafe-noisy` | you | you | 50% (1 of 2) |
| `en-small-talk` | none | none | 100% (2 of 2) |
| `control-noise-only` | none | none | No data |

The mixed-language ask classification and the zero fact recall on the Mandarin, mixed-language and far-field clips need attention before making quality claims about those use cases. Synthetic voices and effects do not reproduce natural accents, room acoustics, interruptions or speech overlap.

Manual review found a more serious issue than missing fact fields. The Mandarin transcription was intelligible, but the card contained a quote unsupported by that transcript. The mixed-language card reported no speech despite an intelligible transcript. A successful API response and parse do not establish that the content is grounded. These findings require a fix and new, separately labeled verification.

A later local browser check processed an 18-second synthetic sample through the UI, server and live Meta API, returning an English card in 8.3 seconds. This was outside the baseline dataset and is not included in its percentiles or quality scores. It shows one working browser-to-card interaction, not a resolution of the errors above.

## Reproduction and next checks

Generate the development clips and run the same route once per clip.

```powershell
npm.cmd run clips
npm.cmd run eval -- --route=meta_api --runs=1
```

On Windows, `npm.cmd` avoids the observed PowerShell wrapper argument issue. The direct runner is `node node_modules/tsx/dist/cli.mjs eval/run.ts --route=meta_api --runs=1`.

The result will vary on another call and may use a later application revision. The original aggregate is preserved here rather than overwritten by later sample-cache runs. The source raw artifact was `2026-11-05T01-28-56-463Z-meta_api.json`, retained privately, and the aggregate was produced by [the eval runner](../run.ts) and [the scoring code](../metrics.ts). See [the evaluation guide](../README.md) for scoring definitions and dataset selection.

Next, repeat the evaluation with consented human recordings, three runs per clip, then check actual phone capture, a deployed request, screen-reader use and the final uncut demo. Public recordings and their cached cards require publication consent. No natural-speech, mobile, deployment or screen-reader result is claimed by this report.
