// Feature and platform checks for the source step (browser-audio.md 1.1, 3.1 and 5). The detect
// function is pure so it can be tested with plain user agent strings.
import type { CaptureSupport } from "./types";

export interface SupportInput {
  secureContext: boolean;
  hasAudioWorklet: boolean;
  hasGetUserMedia: boolean;
  hasGetDisplayMedia: boolean;
  userAgent: string;
  maxTouchPoints: number;
  platform: string; // navigator.userAgentData.platform or navigator.platform
  desktopApp: boolean; // window.catchUpDesktop exists
}

export const NO_SUPPORT: CaptureSupport = {
  secureContext: false,
  audioWorklet: false,
  mic: false,
  tab: false,
  system: false,
  desktopApp: false,
  phone: false,
  nativeRate: false,
};

/** Phones and tablets. iPadOS reports Macintosh, so touch points tell it apart. */
export function isPhoneUA(userAgent: string, maxTouchPoints: number): boolean {
  return /Android|iPhone|iPad|iPod/i.test(userAgent) || (maxTouchPoints > 1 && /Macintosh/.test(userAgent));
}

/**
 * Safari and every browser on iPhone and iPad (all WebKit). These run the AudioContext at its
 * native rate and resample at press time, because of WebKit bugs 251350 and 244203.
 */
export function isWebKitOnlyUA(userAgent: string, maxTouchPoints: number): boolean {
  const ios = /iPhone|iPad|iPod/.test(userAgent) || (maxTouchPoints > 1 && /Macintosh/.test(userAgent));
  const desktopSafari =
    /AppleWebKit/.test(userAgent) && /Safari\//.test(userAgent) && !/Chrome\/|Chromium\/|Edg\/|Firefox\//.test(userAgent);
  return ios || desktopSafari;
}

/** Desktop Chrome, Edge and other Chromium browsers, the only ones that return display audio. */
export function isDesktopChromiumUA(userAgent: string, maxTouchPoints: number): boolean {
  if (isPhoneUA(userAgent, maxTouchPoints)) return false;
  return /Chrome\/|Chromium\/|Edg\//.test(userAgent) && !/Firefox\//.test(userAgent);
}

export function detectSupport(input: SupportInput): CaptureSupport {
  const secure = input.secureContext;
  const phone = isPhoneUA(input.userAgent, input.maxTouchPoints);
  const chromium = isDesktopChromiumUA(input.userAgent, input.maxTouchPoints);
  const windowsOrChromeOS = /Windows|CrOS/.test(input.userAgent) || /^Win|Windows|Chrome OS|ChromeOS/i.test(input.platform);
  const display = secure && input.hasGetDisplayMedia;
  return {
    secureContext: secure,
    audioWorklet: secure && input.hasAudioWorklet,
    mic: secure && input.hasGetUserMedia,
    tab: display && chromium && !input.desktopApp,
    system: (secure && input.desktopApp) || (display && chromium && windowsOrChromeOS),
    desktopApp: input.desktopApp,
    phone,
    nativeRate: isWebKitOnlyUA(input.userAgent, input.maxTouchPoints),
  };
}

/** Reads the live browser. Returns NO_SUPPORT during server rendering. */
export function readBrowserSupport(desktopApp: boolean): CaptureSupport {
  if (typeof window === "undefined" || typeof navigator === "undefined") return NO_SUPPORT;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const media = nav.mediaDevices as (MediaDevices & { getDisplayMedia?: unknown }) | undefined;
  return detectSupport({
    secureContext: window.isSecureContext === true,
    hasAudioWorklet: typeof AudioWorkletNode !== "undefined",
    hasGetUserMedia: typeof media?.getUserMedia === "function",
    hasGetDisplayMedia: typeof media?.getDisplayMedia === "function",
    userAgent: nav.userAgent ?? "",
    maxTouchPoints: nav.maxTouchPoints ?? 0,
    platform: nav.userAgentData?.platform ?? nav.platform ?? "",
    desktopApp,
  });
}
