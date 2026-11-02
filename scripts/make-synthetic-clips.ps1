<#
.SYNOPSIS
Makes the synthetic clips listed in eval/clips.json with Windows voices (System.Speech) and ffmpeg.

.DESCRIPTION
Every clip becomes a 16 kHz mono 16-bit PCM WAV, peak-normalized like the press pipeline does.
All clips go to eval/clips/<id>.wav and the sample clips also go to public/samples/dev/<id>.wav.
Both folders are git-ignored. Synthetic clips are for local development and the eval only,
never shipped and never filmed. eval/clips/timings.json records where every line landed.

Run it with Windows PowerShell, from the repo root or anywhere.
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/make-synthetic-clips.ps1
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/make-synthetic-clips.ps1 -Only en-ask-by-name,sample-office-hours
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/make-synthetic-clips.ps1 -ListVoices
#>
[CmdletBinding()]
param(
  [string]$ClipsFile = '',
  [string[]]$Only = @(),
  [switch]$ListVoices,
  [switch]$KeepTemp
)

$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
if (-not $ClipsFile) { $ClipsFile = Join-Path $Root 'eval\clips.json' }
$EvalDir = Join-Path $Root 'eval\clips'
$DevDir = Join-Path $Root 'public\samples\dev'
$Rate = 16000
$PeakDb = -1.0
$TailSec = 1.6
$LeadSec = 0.6
$LineGapSec = 0.45
$SegmentGapSec = 0.06

Add-Type -AssemblyName System.Speech
$Format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(
  $Rate,
  [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
  [System.Speech.AudioFormat.AudioChannel]::Mono
)
$Synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$Installed = @($Synth.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo })

if ($ListVoices) {
  $Installed | ForEach-Object { '{0}  {1}  {2}' -f $_.Name, $_.Culture, $_.Gender }
  $Synth.Dispose()
  exit 0
}

$Ffmpeg = (Get-Command ffmpeg -ErrorAction SilentlyContinue)
if (-not $Ffmpeg) { throw 'ffmpeg was not found on PATH. Install it (for example winget install Gyan.FFmpeg) and run this again.' }
$Ffmpeg = $Ffmpeg.Source

# The leading comma keeps a one-item array (such as a single tts segment) from being unrolled.
function Get-Opt($Object, [string]$Name, $Default) {
  if ($null -ne $Object -and $Object.PSObject.Properties[$Name]) { return , $Object.$Name }
  return , $Default
}

function Invoke-Ffmpeg([string[]]$FfArgs) {
  $all = @('-hide_banner', '-nostdin', '-loglevel', 'error', '-y') + $FfArgs
  & $script:Ffmpeg @all
  if ($LASTEXITCODE -ne 0) { throw "ffmpeg failed with exit code $LASTEXITCODE (args $($FfArgs -join ' '))" }
}

# Runs ffmpeg for analysis and returns its log text (ffmpeg writes stats to stderr).
function Get-FfmpegLog([string[]]$FfArgs) {
  $all = @('-hide_banner', '-nostdin', '-nostats') + $FfArgs + @('-f', 'null', '-')
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $script:Ffmpeg
  $psi.Arguments = ($all | ForEach-Object { if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }) -join ' '
  $psi.UseShellExecute = $false
  $psi.RedirectStandardError = $true
  $psi.RedirectStandardOutput = $true
  $proc = [System.Diagnostics.Process]::Start($psi)
  $stdout = $proc.StandardOutput.ReadToEndAsync()
  $err = $proc.StandardError.ReadToEnd()
  $proc.WaitForExit()
  [void]$stdout.Result
  if ($proc.ExitCode -ne 0) { throw "ffmpeg analysis failed. $err" }
  return $err
}

# RMS level of a file, or of the part from Start for Length seconds.
function Get-RmsDb([string]$Path, [double]$Start = -1, [double]$Length = -1) {
  $range = @()
  if ($Start -ge 0 -and $Length -gt 0) { $range = @('-ss', (Format-Num $Start), '-t', (Format-Num $Length)) }
  $log = Get-FfmpegLog ($range + @('-i', $Path, '-af', 'astats=metadata=0:reset=0'))
  $hits = [regex]::Matches($log, 'RMS level dB:\s*(-?inf|-?[0-9.]+)')
  if ($hits.Count -eq 0) { throw "No RMS level for $Path" }
  $value = $hits[$hits.Count - 1].Groups[1].Value
  if ($value -match 'inf') { return -120.0 }
  return [double]::Parse($value, [Globalization.CultureInfo]::InvariantCulture)
}

function Get-MaxVolumeDb([string]$Path) {
  $log = Get-FfmpegLog @('-i', $Path, '-af', 'volumedetect')
  $m = [regex]::Match($log, 'max_volume:\s*(-?inf|-?[0-9.]+) dB')
  if (-not $m.Success) { throw "No max_volume for $Path" }
  if ($m.Groups[1].Value -match 'inf') { return -120.0 }
  return [double]::Parse($m.Groups[1].Value, [Globalization.CultureInfo]::InvariantCulture)
}

# Reads a RIFF WAV and returns its format and length in seconds.
function Get-WavInfo([string]$Path) {
  $b = [IO.File]::ReadAllBytes($Path)
  if ([Text.Encoding]::ASCII.GetString($b, 0, 4) -ne 'RIFF' -or [Text.Encoding]::ASCII.GetString($b, 8, 4) -ne 'WAVE') { throw "$Path is not a WAV file" }
  $pos = 12
  $info = $null
  while ($pos + 8 -le $b.Length) {
    $id = [Text.Encoding]::ASCII.GetString($b, $pos, 4)
    $size = [BitConverter]::ToUInt32($b, $pos + 4)
    if ($id -eq 'fmt ') {
      $info = [ordered]@{
        format = [BitConverter]::ToUInt16($b, $pos + 8)
        channels = [BitConverter]::ToUInt16($b, $pos + 10)
        rate = [BitConverter]::ToUInt32($b, $pos + 12)
        bits = [BitConverter]::ToUInt16($b, $pos + 22)
        headerBytes = 0
        seconds = 0.0
      }
    } elseif ($id -eq 'data') {
      if ($null -eq $info) { throw "$Path has data before fmt" }
      $bytes = [Math]::Min([int64]$size, [int64]($b.Length - $pos - 8))
      $info.headerBytes = $pos + 8
      $info.seconds = $bytes / ($info.rate * $info.channels * ($info.bits / 8))
      return $info
    }
    $pos += 8 + $size + ($size % 2)
  }
  throw "$Path has no data chunk"
}

function Format-Num([double]$Value, [int]$Digits = 3) {
  return [Math]::Round($Value, $Digits).ToString([Globalization.CultureInfo]::InvariantCulture)
}

$PcmOut = @('-ar', "$Rate", '-ac', '1', '-c:a', 'pcm_s16le', '-map_metadata', '-1', '-fflags', '+bitexact', '-flags:a', '+bitexact')

# Voices. Each key in clips.json names an installed voice, with a fallback to any voice of the same language.
$Culture = @{ en = 'en-'; ja = 'ja-'; zh = 'zh-' }
$Data = Get-Content -Raw -Encoding UTF8 -Path $ClipsFile | ConvertFrom-Json
$Voices = @{}
foreach ($prop in $Data.voices.PSObject.Properties) {
  $spec = $prop.Value
  $match = $Installed | Where-Object { $_.Name -eq $spec.name } | Select-Object -First 1
  if (-not $match) {
    $prefix = $Culture[$spec.lang]
    $match = $Installed | Where-Object { $_.Culture.Name.StartsWith($prefix) } | Select-Object -First 1
    if (-not $match) { throw "No installed voice for $($spec.lang). Add the speech pack in Settings, Time and language, Speech, then run this again." }
    Write-Warning "Voice '$($spec.name)' is missing, using '$($match.Name)' for $($prop.Name)."
  }
  $Voices[$prop.Name] = @{ name = $match.Name; rate = [int](Get-Opt $spec 'rate' 0); pitch = [double](Get-Opt $spec 'pitch' 1.0) }
}

$Temp = Join-Path ([IO.Path]::GetTempPath()) ('catchup-clips-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $Temp, $EvalDir, $DevDir | Out-Null

function New-SpeechSegment([string]$VoiceKey, [string]$Text, [string]$Path) {
  if (-not $script:Voices.ContainsKey($VoiceKey)) { throw "Unknown voice key $VoiceKey" }
  $v = $script:Voices[$VoiceKey]
  $raw = "$Path.raw.wav"
  $script:Synth.SelectVoice($v.name)
  $script:Synth.Rate = $v.rate
  $script:Synth.SetOutputToWaveFile($raw, $script:Format)
  try { $script:Synth.Speak($Text) } finally { $script:Synth.SetOutputToNull() }
  $trim = 'silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.03:detection=peak,areverse,silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.05:detection=peak,areverse'
  $filter = $trim
  if ([Math]::Abs($v.pitch - 1.0) -gt 0.001) {
    $shifted = [int][Math]::Round($script:Rate * $v.pitch)
    $tempo = Format-Num (1.0 / $v.pitch) 4
    $filter = "$trim,asetrate=$shifted,aresample=$($script:Rate),atempo=$tempo"
  }
  Invoke-Ffmpeg (@('-i', $raw, '-af', $filter) + $script:PcmOut + @($Path))
  Remove-Item -LiteralPath $raw -Force
  return (Get-WavInfo $Path).seconds
}

# Babble for the cafe bed. Reversed speech keeps the sound of a crowd without any words.
$BabblePath = Join-Path $Temp 'babble.wav'
$babbleLines = @(
  @('en-m', 'I think the line is shorter in the afternoon, but the music is always this loud.'),
  @('en-f', 'We should come back on the weekend when it is a little quieter in here.'),
  @('en-f-fast', 'Did you want oat milk or regular, because they ran out of the other one.'),
  @('en-m-slow', 'The table by the window opened up, grab it before somebody else does.')
)
$babbleParts = @()
for ($i = 0; $i -lt $babbleLines.Count; $i++) {
  $p = Join-Path $Temp "babble-$i.wav"
  [void](New-SpeechSegment $babbleLines[$i][0] $babbleLines[$i][1] $p)
  $babbleParts += $p
}
$concatInputs = @()
$concatLabels = ''
for ($i = 0; $i -lt $babbleParts.Count; $i++) { $concatInputs += @('-i', $babbleParts[$i]); $concatLabels += "[$($i):a]" }
Invoke-Ffmpeg ($concatInputs + @('-filter_complex', "$($concatLabels)concat=n=$($babbleParts.Count):v=0:a=1,areverse[b]", '-map', '[b]') + $PcmOut + @($BabblePath))

function New-NoiseBed([string]$Kind, [double]$Duration, [int]$Seed, [string]$Path) {
  $d = Format-Num $Duration
  switch ($Kind) {
    'room' {
      Invoke-Ffmpeg (@('-f', 'lavfi', '-i', "anoisesrc=d=$($d):c=pink:r=$($script:Rate):a=0.05:seed=$Seed", '-af', 'lowpass=f=5000') + $script:PcmOut + @($Path))
    }
    'noise' {
      $fc = "anoisesrc=d=$($d):c=brown:r=$($script:Rate):a=0.5:seed=$Seed[br];anoisesrc=d=$($d):c=pink:r=$($script:Rate):a=0.08:seed=$($Seed + 1)[pk];[br][pk]amix=inputs=2:normalize=0,highpass=f=60,tremolo=f=0.3:d=0.5[n]"
      Invoke-Ffmpeg (@('-filter_complex', $fc, '-map', '[n]') + $script:PcmOut + @($Path))
    }
    'cafe' {
      $fc = "[0:a]volume=1.0[b0];[1:a]adelay=delays=2300:all=1,volume=0.8[b1];[2:a]adelay=delays=5100:all=1,volume=0.7[b2];" +
        "[b0][b1][b2]amix=inputs=3:normalize=0:duration=longest,lowpass=f=3400,aecho=0.8:0.7:60|110:0.4|0.3,atrim=duration=$d[bab];" +
        "anoisesrc=d=$($d):c=brown:r=$($script:Rate):a=0.4:seed=$Seed[br];anoisesrc=d=$($d):c=pink:r=$($script:Rate):a=0.04:seed=$($Seed + 1)[pk];" +
        "[bab][br][pk]amix=inputs=3:normalize=0:duration=longest,highpass=f=60,atrim=duration=$d[n]"
      $loop = @('-stream_loop', '-1', '-i', $script:BabblePath)
      Invoke-Ffmpeg ($loop + $loop + $loop + @('-filter_complex', $fc, '-map', '[n]', '-t', $d) + $script:PcmOut + @($Path))
    }
    default { throw "Unknown noise kind $Kind" }
  }
}

$Effects = @{
  none = 'anull'
  call = 'highpass=f=200,lowpass=f=3800'
  room = 'aecho=0.8:0.4:25|45:0.18|0.1'
  far = 'highpass=f=180,lowpass=f=3000,aecho=0.8:0.6:40|75|110:0.35|0.25|0.15,volume=0.6'
}

$Timings = [ordered]@{
  synthetic = $true
  note = 'Made by scripts/make-synthetic-clips.ps1 with Windows voices. Never ship or film these clips.'
  generatedAt = (Get-Date).ToString('o')
  voices = [ordered]@{}
  clips = [ordered]@{}
}
foreach ($k in $Voices.Keys) { $Timings.voices[$k] = $Voices[$k].name }
$existing = Join-Path $EvalDir 'timings.json'
if ($Only.Count -gt 0 -and (Test-Path $existing)) {
  $old = Get-Content -Raw -Encoding UTF8 $existing | ConvertFrom-Json
  foreach ($p in $old.clips.PSObject.Properties) { $Timings.clips[$p.Name] = $p.Value }
}

$Only = @($Only | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
$seed = 7
$problems = 0
$made = 0

foreach ($clip in @($Data.clips)) {
  $seed += 11
  if ($Only.Count -gt 0 -and $Only -notcontains $clip.id) { continue }
  $id = $clip.id
  $duration = [double]$clip.durationSec
  $dir = Join-Path $Temp $id
  New-Item -ItemType Directory -Force -Path $dir | Out-Null

  # Speak every segment, then lay the lines out one after another.
  $segments = @()
  $lineSpans = @()
  $cursor = 0.0
  $lines = @($clip.lines)
  for ($li = 0; $li -lt $lines.Count; $li++) {
    $line = $lines[$li]
    $parts = @()
    $tts = Get-Opt $line 'tts' $null
    if ($null -ne $tts) { foreach ($t in @($tts)) { $parts += , @([string]$t[0], [string]$t[1]) } }
    else { $parts += , @([string]$line.voice, [string]$line.text) }
    $gap = [double](Get-Opt $line 'gap' $LineGapSec)
    $at = Get-Opt $line 'at' $null
    $start = if ($li -eq 0) { $LeadSec } else { $cursor + $gap }
    if ($null -ne $at) {
      if ([double]$at -lt $cursor + 0.05) { Write-Warning "$id line $li wants to start at $at s, but the line before ends at $(Format-Num $cursor 2) s. Moved it later." }
      else { $start = [double]$at }
    }
    $offset = 0.0
    for ($pi = 0; $pi -lt $parts.Count; $pi++) {
      $segPath = Join-Path $dir ("l{0:D2}-s{1:D2}.wav" -f $li, $pi)
      $segSec = New-SpeechSegment $parts[$pi][0] $parts[$pi][1] $segPath
      $segments += @{ path = $segPath; start = $start + $offset; seconds = $segSec }
      $offset += $segSec + $SegmentGapSec
    }
    $end = $start + $offset - $SegmentGapSec
    $lineSpans += @{ start = $start; end = $end }
    $cursor = $end
  }

  # Speech sits at the end of the clip, so the key line lands just before the press.
  $speechEnd = if ($lineSpans.Count -gt 0) { $lineSpans[$lineSpans.Count - 1].end } else { 0.0 }
  $shift = 0.0
  $hasAt = @($lines | Where-Object { $null -ne (Get-Opt $_ 'at' $null) }).Count -gt 0
  if ($lineSpans.Count -gt 0 -and -not $hasAt) { $shift = [Math]::Max(0.0, $duration - $TailSec - $speechEnd) }
  if ($speechEnd + $shift -gt $duration - 0.3) {
    Write-Warning "$id needs at least $(Format-Num ($speechEnd + $TailSec) 1) s but durationSec is $duration. Raise durationSec in clips.json."
    $problems++
    continue
  }
  foreach ($s in $segments) { $s.start += $shift }
  foreach ($span in $lineSpans) { $span.start += $shift; $span.end += $shift }

  $effect = $Effects[[string]$clip.effect]
  if (-not $effect) { throw "Unknown effect $($clip.effect) in $id" }
  $d = Format-Num $duration
  $speechPath = Join-Path $dir 'speech.wav'
  $noisePath = Join-Path $dir 'noise.wav'
  $mixPath = Join-Path $dir 'mix.wav'
  $outPath = Join-Path $EvalDir "$id.wav"

  $noise = Get-Opt $clip 'noise' $null
  $noiseKind = [string](Get-Opt $noise 'kind' 'room')
  $snr = [double](Get-Opt $noise 'snrDb' 35)
  New-NoiseBed $noiseKind $duration $seed $noisePath
  $speechDb = $null
  $noiseDb = Get-RmsDb $noisePath

  if ($segments.Count -gt 0) {
    $inputs = @('-f', 'lavfi', '-i', "anullsrc=r=$($Rate):cl=mono,atrim=duration=$d")
    $chain = ''
    $labels = '[0:a]'
    for ($i = 0; $i -lt $segments.Count; $i++) {
      $inputs += @('-i', $segments[$i].path)
      $ms = [int][Math]::Round($segments[$i].start * 1000)
      $chain += "[$($i + 1):a]adelay=delays=$($ms):all=1[d$i];"
      $labels += "[d$i]"
    }
    $fc = "$chain$($labels)amix=inputs=$($segments.Count + 1):normalize=0:duration=first,$effect,apad=whole_dur=$d,atrim=duration=$d[s]"
    Invoke-Ffmpeg ($inputs + @('-filter_complex', $fc, '-map', '[s]') + $PcmOut + @($speechPath))
    # SNR is measured over the stretch where people talk, not over the lead-in.
    $spanStart = $lineSpans[0].start
    $speechDb = Get-RmsDb $speechPath $spanStart ($lineSpans[$lineSpans.Count - 1].end - $spanStart)
    $gainDb = Format-Num (($speechDb - $snr) - $noiseDb) 2
    $fc = "[1:a]volume=$($gainDb)dB[n];[0:a][n]amix=inputs=2:normalize=0:duration=first,atrim=duration=$d[m]"
    Invoke-Ffmpeg (@('-i', $speechPath, '-i', $noisePath, '-filter_complex', $fc, '-map', '[m]') + $PcmOut + @($mixPath))
  } else {
    Copy-Item -LiteralPath $noisePath -Destination $mixPath -Force
  }

  # Peak-normalize like the press pipeline, to -1 dBFS.
  $maxDb = Get-MaxVolumeDb $mixPath
  $normDb = Format-Num ($PeakDb - $maxDb) 2
  Invoke-Ffmpeg (@('-i', $mixPath, '-af', "volume=$($normDb)dB,apad=whole_dur=$d,atrim=duration=$d") + $PcmOut + @($outPath))

  $info = Get-WavInfo $outPath
  if ($info.format -ne 1 -or $info.channels -ne 1 -or $info.rate -ne $Rate -or $info.bits -ne 16) { throw "$outPath is not 16 kHz mono PCM16" }
  if ([Math]::Abs($info.seconds - $duration) -gt 0.02) { throw "$outPath is $($info.seconds) s, expected $duration s" }

  $record = [ordered]@{
    durationSec = [Math]::Round($info.seconds, 3)
    headerBytes = $info.headerBytes
    lines = @($lineSpans | ForEach-Object { [ordered]@{ startSec = [Math]::Round($_.start, 2); endSec = [Math]::Round($_.end, 2) } })
    noise = $noiseKind
    snrDb = if ($null -ne $speechDb) { $snr } else { $null }
  }

  $sample = Get-Opt $clip 'sample' $null
  if ($clip.use -eq 'sample' -and $null -ne $sample) {
    $key = $lineSpans[[int]$sample.muffleLine]
    $press = $lineSpans[[int]$sample.pressAfterLine]
    $mStart = [Math]::Round([Math]::Max(0.0, $key.start - 0.3), 1)
    $mEnd = [Math]::Round([Math]::Min($duration, [Math]::Max($key.end + 0.3, $mStart + 4.0)), 1)
    $keyMoment = [Math]::Round([Math]::Min($duration, $press.end + 0.3), 1)
    $record.sample = [ordered]@{ muffle = [ordered]@{ startSec = $mStart; endSec = $mEnd }; keyMomentSec = $keyMoment }
    $want = $sample.muffle
    if ([Math]::Abs([double]$want.startSec - $mStart) -gt 0.15 -or [Math]::Abs([double]$want.endSec - $mEnd) -gt 0.15 -or [Math]::Abs([double]$sample.keyMomentSec - $keyMoment) -gt 0.15) {
      Write-Warning ("{0} timings moved. Set muffle {1} to {2} s and keyMomentSec {3} in eval/clips.json and src/lib/samples/catalog.ts." -f $id, (Format-Num $mStart 1), (Format-Num $mEnd 1), (Format-Num $keyMoment 1))
      $problems++
    }
    Copy-Item -LiteralPath $outPath -Destination (Join-Path $DevDir "$id.wav") -Force
  }

  $Timings.clips[$id] = $record
  $made++
  $firstLine = if ($lineSpans.Count -gt 0) { Format-Num $lineSpans[0].start 1 } else { 'none' }
  $lastLine = if ($lineSpans.Count -gt 0) { Format-Num $lineSpans[$lineSpans.Count - 1].end 1 } else { 'none' }
  Write-Host ("{0,-24} {1,5} s  speech {2} to {3} s  noise {4}" -f $id, (Format-Num $info.seconds 1), $firstLine, $lastLine, $noiseKind)
}

$json = $Timings | ConvertTo-Json -Depth 8
[IO.File]::WriteAllText((Join-Path $EvalDir 'timings.json'), $json, (New-Object System.Text.UTF8Encoding($false)))
$Synth.Dispose()
if (-not $KeepTemp) { Remove-Item -LiteralPath $Temp -Recurse -Force -ErrorAction SilentlyContinue }
else { Write-Host "Kept temp files in $Temp" }

Write-Host "Made $made clips in $EvalDir, samples copied to $DevDir."
if ($problems -gt 0) {
  Write-Warning "$problems clips need attention, see the warnings above."
  exit 1
}
