// English app chrome (ux-spec 2-7 says chrome stays English in the MVP). Card labels in the card
// language come from src/lib/card/strings.ts instead. Every string here passes copyRuleProblems
// (copy.test.ts checks it), so edit freely but keep the rules. No colons, semicolons, dashes as
// separators or slashes between words.
import type { CardLang, LiveRoute, Source, WindowSec } from "../card/schema";
import type { CaptureErrorCode, CaptureSourceKind } from "../audio/types";

export const LANG_NAMES: Readonly<Record<CardLang, string>> = { en: "English", ja: "日本語", zh: "中文" };
export const LANG_SHORT: Readonly<Record<CardLang, string>> = { en: "EN", ja: "日本語", zh: "中文" };

/** 30 s, 1 min, 2 min. */
export function windowLabel(windowSec: WindowSec): string {
  if (windowSec === 60) return "1 min";
  if (windowSec === 120) return "2 min";
  return "30 s";
}

/** 30 seconds, 1 minute, 2 minutes, for accessible names. */
export function windowWords(windowSec: WindowSec): string {
  if (windowSec === 60) return "1 minute";
  if (windowSec === 120) return "2 minutes";
  return "30 seconds";
}

export const SOURCE_LABELS: Readonly<Record<Source, string>> = {
  mic: "Microphone",
  tab: "Tab audio",
  system: "System audio",
  sample: "Sample conversation",
};

/** What the source step tiles say. */
export const SOURCE_TILES: Readonly<Record<Exclude<Source, "sample">, { title: string; detail: string }>> = {
  mic: { title: "People in the room", detail: "Lectures, in-person meetings, networking" },
  tab: { title: "A tab in this browser", detail: "Meet, Teams on the web, YouTube, streams" },
  system: { title: "Apps on this computer", detail: "Zoom and Teams desktop apps" },
};

const SOURCE_NOUNS: Readonly<Record<Source, string>> = {
  mic: "the microphone",
  tab: "the meeting tab",
  system: "system audio",
  sample: "the sample",
};

const QUIET_TIPS: Readonly<Record<Source, string>> = {
  mic: "Is the mic muted, or too far away?",
  tab: "Right tab? Is it muted?",
  system: "Is Zoom's speaker on Same as System?",
  sample: "The clip may be quiet here.",
};

export const CAPTURE_ERROR_COPY: Readonly<Record<CaptureErrorCode, string>> = {
  insecure_context: "Catch Up needs a secure page (https) to hear audio.",
  unsupported: "This browser can't capture that source. Try People in the room, or Chrome or Edge on a computer.",
  permission_denied:
    "Microphone blocked, or sharing was cancelled. Open the site settings next to the address bar, allow the microphone, then try again.",
  share_cancelled: "Sharing was cancelled. Nothing was captured.",
  no_audio_in_share:
    "The share came back without sound. Pick the tab again and turn on Also share tab audio, or pick Entire screen and turn on Share system audio.",
  device_error: "Couldn't open that audio source. Check that it is plugged in and not used by another app.",
  sample_failed: "That sample couldn't play. Try another one.",
};

export const UI = {
  appName: "Catch Up",
  promise: "Catch Up keeps the last 2 minutes of sound in memory, and nothing leaves your device until you press.",
  tagline: "Missed something? Press once.",
  builtWith: "Built with Muse Spark Open",
  footerAudio: "Audio stays in this tab's memory and is sent only when you press.",
  footerAudioApp: "Audio stays in this app's memory and is sent only when you press.",
  aiCanBeWrong: "Cards are written by AI and can be wrong.",
  adultsOnly: "Catch Up is for people 18 and over.",
  howAudioHandled: "How your audio is handled",

  // Header and chrome
  cardsIn: "Cards in",
  cardLanguage: "Card language",
  floatOnTop: "Float on top",
  settings: "Settings",
  menu: "Menu",
  close: "Close",
  done: "Done",
  gotIt: "Got it",
  backToTab: "Back to tab",
  bringBack: "Bring the panel back",
  fullView: "Full view",
  compactView: "Compact panel",
  hidePanel: "Hide panel",
  mock: "MOCK",
  sample: "SAMPLE",
  devMockBanner: "Development only. Mock cards, no model was called.",

  // Status row
  notListening: "Not listening",
  listening: "Listening",
  starting: "Starting",
  pausedCleared: "Paused, memory cleared",
  interrupted: "Listening stopped while the screen was off. Memory cleared.",
  notSaved: "not saved",
  inMemory: "in memory",
  soundOk: "Sound OK",
  levelCheck: "Talk or play something. Bars moving? You're set.",
  changeSource: "Change source",

  // Memory bar
  memoryBarLabel: "Memory, last 2 minutes",
  memoryEmpty: "Memory is empty",

  // Action bar
  howMuch: "How much to send",
  startListening: "Start listening",
  resume: "Resume",
  reconnect: "Reconnect",
  tryAgain: "Try again",
  chooseAgain: "Choose again",
  catchUp: "Catch up",
  cancel: "Cancel",
  pause: "Pause",
  escHint: "Esc",
  consentFirst: "Tick People here know first.",
  warmingReason: "Catch Up needs at least 5 seconds of sound first.",

  // Consent row
  tellPeople: "Tell people first",
  showHeadsUp: "Show heads-up",
  hideHeadsUp: "Hide heads-up",
  copyForChat: "Copy for chat",
  consentLabel: "People here know I'm using Catch Up",
  headphonesNote: "Using a screen reader? Wear headphones, because app audio also picks up your reader's voice.",

  // Source step
  sourceTitle: "What should Catch Up hear?",
  sourceHelp: "One source at a time. Your last choice is picked.",
  pickerTabGuide: "In the browser's picker, choose the tab with your meeting, then turn on Also share tab audio.",
  pickerSystemGuide: "In the browser's picker, choose Entire screen, then turn on Share system audio.",
  zoomTip: "In Zoom, leave the speaker on Same as System so Catch Up can hear it.",
  appSystemNote: "The Windows app hears this computer's audio directly, with no picker.",
  needsChrome: "Tab and app audio need Chrome or Edge on a computer.",
  phoneOnlyRoom: "Phones can only hear the room.",
  hintLabel: "Names or topics to expect",
  hintHelp: "Optional, for this session only. It fixes spellings and never adds facts. Sent only with a press.",
  hintPlaceholder: "Dr. Rivera, BIO-110, cell membranes",

  // Empty and landing
  trySample: "Try a sample conversation",
  sampleHelp: "A short recorded conversation plays. Part of it is muffled, like zoning out. Then press Catch up.",
  noSamples: "Sample conversations aren't on this server yet.",
  useReal: "Use it on a real conversation",
  play: "Play",
  muffled: "Muffled to simulate zoning out. Catch Up hears the clean audio.",
  nowPress: "Now press Catch up.",
  sampleEnded: "The clip ended. Catch up still works for 2 minutes.",
  emptyListening: "No cards yet. When you lose the thread, press Catch up.",
  emptyListeningAgain: "When you lose the thread, press Catch up.",
  howItWorks: "How it works",
  steps: [
    "Start listening. Catch Up keeps the last 2 minutes in memory and saves nothing.",
    "Lost the thread? Press Catch up, or Ctrl+Alt+C.",
    "Get a card. Were you asked something, a line you can say, and what you missed.",
  ],
  phoneKeepOn: "Keep this screen on and Catch Up in front. Phones stop listening when locked.",
  pipHint: "Float it so you can press it during your call.",
  pipOneWindow: "Chrome allows one floating window, so opening this can close Meet's or YouTube's.",
  pipUnsupported: "Float on top needs Chrome or Edge on a computer. Keep this window beside your call, or use the Windows app.",
  pipOpenNote: "The panel is floating. Press Catch up there, or use Ctrl+Alt+C here.",
  pipClosedNote: "The floating panel closed. Chrome allows one floating window, so another site's may have replaced it.",
  floatAgain: "Float again",

  // Health and route notices
  livePaused: "Live cards are paused right now.",
  samplesSaved: "Samples show saved real cards.",
  tryLater: "Try again later.",
  liveNotSetUp: "Live cards aren't set up on this server yet.",
  unavailable: "Audio capture isn't ready in this build yet.",

  // Press refusals
  notListeningPress: "Start listening first, then press Catch up.",
  nothingHeld: "That clip was cleared after 2 minutes. Press Catch up for a new one.",

  // Progress
  gettingClip: "Getting the clip",
  stillWorking: "Still working",
  stillWorkingDetail: "Some cards take longer. Esc cancels.",

  // Silent gate and errors
  checkSource: "Check source",
  sendAnyway: "Send anyway",
  nothingLeft: "Nothing left this device.",
  clipLeftOnce: "The clip left this device for this request only.",
  reload: "Reload",

  // Card
  copyCard: "Copy card",
  copyLine: "Copy line",
  copied: "Copied",
  copyFailed: "Couldn't copy",
  furtherBack: "Further back",
  startsMidThought: "This clip starts mid-thought.",
  unformatted: "Unformatted",
  unformattedNote: "The answer couldn't be read as a card, so this is its raw text.",
  savedResult: "Saved result",
  transcript: "Transcript",
  latestCard: "Latest card",
  retry: "Retry",
  factsLabel: "Facts",
  sampleProgress: "Sample progress",
  backToApp: "Back to Catch Up",
  asideLabel: "Source and this session",

  // History
  thisSession: "This session",
  noCatches: "No catches yet.",
  exportMd: "Export .md",
  clear: "Clear",
  keep: "Keep",
  exported: "Exported",
  historyNote: "Cards stay in this tab only. Export is the only way to save them.",

  // Setup sheet
  setupTitle: "Missed something? Press once.",
  setupLines: [
    "Holds the last 2 minutes in memory and saves nothing.",
    "Sends only the slice you choose, only when you press, to Meta's Muse Spark Open on Baseten (Meta Model API as a backup).",
    "Gives you a short card in your language and a line you can say to check.",
  ],
  meetingLang: "People around you usually speak",
  namesLabel: "What do people call you?",
  namesHelp: "Optional, up to 3 forms. So Catch Up can tell when someone asks you. Stays on this device, sent only with a press.",
  continue: "Continue",

  // Settings
  defaultWindow: "Default window",
  textSize: "Text size",
  advanced: "Advanced",
  route: "Route",
  routeAuto: "Auto",
  routeOpen: "Open weights only",
  routeMeta: "Meta API only",
  routeAutoHelp: "Muse Spark Open on Baseten first, then Meta Model API once if that fails.",
  routeOpenHelp: "Muse Spark Open on Baseten only. The backup route stays off.",
  routeMetaHelp: "Muse Voice Transcribe, then Muse Spark, on Meta Model API.",
  routeMissing: "Not set up on this server",
  showTiming: "Show timing details",
  hotkey: "Hotkey",
  hotkeyHelp: "Works from any app while Catch Up runs.",
  settingsSaved: "Settings stay on this device only.",
} as const;

/** Words in the drawing of the browser's share picker. */
export const PICKER = {
  heading: "Choose what to share",
  tabs: ["Chrome tab", "Window", "Entire screen"],
  tabItem: "Your meeting tab",
  screenItem: "Screen 1",
  tabSwitch: "Also share tab audio",
  systemSwitch: "Share system audio",
  share: "Share",
  tabTitle: "The browser's share picker with the Chrome tab list open and the Also share tab audio switch turned on.",
  systemTitle: "The browser's share picker with Entire screen chosen and the Share system audio switch turned on.",
} as const;

/** The How your audio is handled sheet and the privacy page (ux-spec 5 Privacy UX). */
export const PRIVACY = {
  title: "How your audio is handled",
  intro: "Catch Up keeps the last 2 minutes of sound in memory, and nothing leaves your device until you press.",
  sections: [
    {
      title: "What stays on this device",
      items: [
        "Up to 2 minutes of sound, in memory only and never on disk. Pause wipes it at once, and so does closing the tab or the app.",
        "After a press, the clip stays in memory for 2 minutes so Further back and the language chips can reuse it. Then it is zeroed.",
        "Cards stay in this tab until you close it. Export is the only way to save them, and only when you click it.",
        "Settings (languages, names, window, text size) are the only thing Catch Up keeps on this device.",
      ],
    },
    {
      title: "What leaves, and when",
      items: [
        "Only when you press, and only the slice the memory bar lights up, 30 seconds unless you pick more.",
        "With it go the card language, the language people around you speak, the source you picked, your local time and time zone, and a random id for this tab (the main route passes it to Baseten so your presses reach the same server). Your name forms and the session hint go too, if you set them.",
        "If no one spoke in that slice, nothing is sent unless you choose Send anyway.",
        "Every card ends with a receipt that says what was sent, to which route and model, and when.",
      ],
    },
    {
      title: "Who hears it",
      items: [
        "Main route. Muse Spark Open on Baseten (meta-models/muse-spark-open-1026) hears the clip directly. Baseten documents zero data retention for synchronous requests like these.",
        "Backup route. Muse Voice Transcribe and Muse Spark on Meta Model API (muse-voice-transcribe-1.0 and muse-spark-1.3). Meta can retain content under its terms. Set Route to Open weights only in Settings to turn the backup off.",
      ],
    },
    {
      title: "What Catch Up's server keeps",
      items: [
        "It streams each card straight back and stores no audio, transcripts or card text.",
        "Its logs hold the time, route, model, window, byte size, stage timings and status of each press. Never audio, transcripts, card text, names, hints, IP addresses or keys.",
        "No analytics, no accounts and no cookies.",
      ],
    },
    {
      title: "Use it openly",
      items: [
        "Tell people you use Catch Up, and follow local rules. The heads-up line is there to paste or say.",
        "In class, ask the instructor or the disability office first.",
        "The panel always shows up in screen shares.",
      ],
    },
    {
      title: "Limits",
      items: [
        "Cards are written by AI and can be wrong. The line to say is AI-suggested and only restates or confirms.",
        "Catch Up is for people 18 and over.",
        "Catch Up is an accessibility and language tool, not a medical device. It never reads emotions or identifies anyone by voice.",
      ],
    },
  ],
  links: [
    { label: "Baseten security and data retention", href: "https://docs.baseten.co/observability/security" },
    { label: "Meta Model API terms of service", href: "https://dev.meta.ai/legal/terms-of-service" },
    { label: "Muse Model License", href: "https://huggingface.co/meta-models/Muse-Spark-Open-816B-A42B/blob/main/LICENSE.md" },
  ],
  linksTitle: "Data terms",
  builtWith: "Built with Muse Spark Open",
} as const;

export function switchToLabel(title: string): string {
  return `Switch to ${title}`;
}

export const NAME_PLACEHOLDERS = ["Your name", "A nickname", "Your name in another script"] as const;

export function nameFormLabel(n: number): string {
  return `Name form ${n}`;
}

export function sourceNoun(source: CaptureSourceKind | null): string {
  return source ? SOURCE_NOUNS[source] : "the source";
}

export function listeningLabel(source: CaptureSourceKind): string {
  return `Listening · ${SOURCE_LABELS[source]}`;
}

/** Accessible name of the source chip in the status row. Starts with the visible words. */
export function sourceChipName(label: string): string {
  return `${label}, change source`;
}

export function sourceLostLabel(source: CaptureSourceKind | null): string {
  return `Stopped hearing ${sourceNoun(source)}.`;
}

export function quietHint(source: CaptureSourceKind): string {
  return `Not hearing anything from ${SOURCE_LABELS[source]}. ${QUIET_TIPS[source]} Catch up still works.`;
}

export function memoryLabel(clock: string): string {
  return `${clock} in memory`;
}

export function collectingLabel(secondsLeft: number): string {
  return `Collecting sound (${Math.max(1, secondsLeft)} s)`;
}

export function catchUpName(windowSec: WindowSec): string {
  return `Catch up, send the last ${windowWords(windowSec)}`;
}

export function sendsLast(windowSec: WindowSec): string {
  return `Sends the last ${windowLabel(windowSec)}`;
}

export function hotkeyHint(accelerator: string, global: boolean): string {
  return global ? `${accelerator} from any app` : `${accelerator} on this page`;
}

export function hotkeyTaken(accelerator: string): string {
  return `${accelerator} is taken by another app. Pick another hotkey in Settings.`;
}

export function earlierLabel(count: number): string {
  return `Earlier (${count})`;
}

export function sendingLabel(sentSec: number): string {
  return `Sending ${Math.round(sentSec)} s`;
}

export function partialLabel(sentSec: number): string {
  return `Last ${Math.round(sentSec)} s, all I had`;
}

export function silentLabel(windowSec: WindowSec): string {
  return `No one spoke in the last ${windowLabel(windowSec)}. Nothing was sent.`;
}

export function warmingNotice(secondsLeft: number): string {
  return `Collecting sound. Ready in ${Math.max(1, secondsLeft)} s.`;
}

/** The button that sends the held clip to the other live route, named by where it goes. */
export function otherRouteLabel(route: LiveRoute): string {
  return route === "meta_api" ? "Send to Meta Model API" : "Send to Muse Spark Open";
}

/** What a refused press says in the panel, and to screen readers through the live region. */
export function noticeText(kind: "not_listening" | "warming_up" | "nothing_held" | "unavailable", secondsLeft = 1): string {
  switch (kind) {
    case "not_listening":
      return UI.notListeningPress;
    case "warming_up":
      return warmingNotice(secondsLeft);
    case "nothing_held":
      return UI.nothingHeld;
    default:
      return UI.unavailable;
  }
}

export function retryAfterLabel(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  return `Try again in about ${minutes} min.`;
}

export function cardHeading(clock: string): string {
  return `Catch-up at ${clock}`;
}

export function cardWindow(windowSec: WindowSec, sentSec: number): string {
  if (sentSec + 0.5 < windowSec) return `last ${Math.round(sentSec)} s`;
  return `last ${windowLabel(windowSec)}`;
}

export function furtherBackLabel(next: WindowSec): string {
  return `Further back, send ${windowLabel(next)}`;
}

export function nextCardIn(lang: CardLang): string {
  return `Next card in ${LANG_NAMES[lang]}`;
}

/** For example Saved result from Muse Spark Open, run Nov 3. The label comes from routeLabelOf. */
export function savedRunLabel(routeLabel: string, runDate: string): string {
  return `${routeLabel}, run ${runDate}`;
}

export function playingLabel(title: string): string {
  return `Playing ${title}`;
}

export function clearCount(count: number): string {
  return count === 1 ? "Clear 1 card" : `Clear ${count} cards`;
}

export function historyRowLabel(chip: string, clock: string, windowText: string): string {
  return `${chip}, ${clock}, ${windowText}`;
}

export function textSizeLabel(size: number): string {
  return `${size}%`;
}

export function timingLine(parts: { total: number; firstToken?: number; upload?: number }): string {
  const s = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
  const bits = [`Card in ${s(parts.total)}`];
  if (parts.firstToken !== undefined) bits.push(`first answer token at ${s(parts.firstToken)}`);
  if (parts.upload !== undefined) bits.push(`upload ${s(parts.upload)}`);
  return `${bits.join(", ")}.`;
}

/** Spoken before each fact for screen readers. */
export const FACT_KIND_NAMES = {
  name: "Name",
  date: "Date",
  number: "Number",
  place: "Place",
  term: "Term",
  task: "Task",
} as const;

/** History state chips (English chrome). The card itself uses the card language. */
export const ASK_CHIPS = {
  you: "Asked you",
  mentioned: "Mentioned",
  room: "Room",
  none: "Nothing asked",
} as const;

/** Every fixed English string, for the copy rules test. */
export function allStaticCopy(): string[] {
  const out: string[] = [];
  const walk = (value: unknown) => {
    if (typeof value === "string") out.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  walk(UI);
  walk(SOURCE_LABELS);
  walk(SOURCE_TILES);
  walk(SOURCE_NOUNS);
  walk(QUIET_TIPS);
  walk(CAPTURE_ERROR_COPY);
  walk(ASK_CHIPS);
  walk(FACT_KIND_NAMES);
  walk(PICKER);
  walk(NAME_PLACEHOLDERS);
  walk(PRIVACY.title);
  walk(PRIVACY.intro);
  walk(PRIVACY.sections);
  walk(PRIVACY.links.map((l) => l.label));
  walk(PRIVACY.linksTitle);
  return out;
}
