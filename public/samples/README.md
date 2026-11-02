# Sample clips

The sample strip on the landing page plays these clips into the same memory and press pipeline as live audio, so anyone can try Catch Up without a microphone.

## Public clips

A public clip needs written consent from every voice in it. Its script and gold labels live in `eval/clips.json` (use `sample`). To add one, put the recording here as `<id>.wav` or `<id>.mp3`, under 30 seconds, then list it in `PUBLIC_CLIPS` in `src/lib/samples/catalog.ts` with consent `written`. There are none yet.

A public clip can carry saved cards from real runs, made with `scripts/save-cached-card.ts`. They stand in when live calls fail, are capped or are off, and each one names its live route and run date.

## Dev clips

`public/samples/dev` holds synthetic clips made by `scripts/make-synthetic-clips.ps1` with the Windows text to speech voices. The folder is git-ignored, and the app lists these clips only outside production. They are never shipped and never filmed.
