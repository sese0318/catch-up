import { describe, expect, it } from "vitest";
import { randomId } from "./ids";
import { MUFFLE, planMuffle, sampleStateAt } from "./sample";
import { captureErrorCode, displayMediaOptions, micConstraints } from "./sources";
import { NO_SUPPORT, detectSupport, isPhoneUA, isWebKitOnlyUA, readBrowserSupport, type SupportInput } from "./support";
import { CaptureError } from "./types";

const UA = {
  winChrome:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36",
  winEdge:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0",
  macChrome:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36",
  macSafari:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Safari/605.1.15",
  winFirefox: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:150.0) Gecko/20100101 Firefox/150.0",
  iphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1",
  iphoneChrome:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/156.0.0.0 Mobile/15E148 Safari/604.1",
  ipad: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Safari/605.1.15",
  android:
    "Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Mobile Safari/537.36",
  electron:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) catch-up-desktop/0.1.0 Chrome/156.0.8078.75 Electron/45.2.1 Safari/537.36",
};

function input(userAgent: string, patch: Partial<SupportInput> = {}): SupportInput {
  return {
    secureContext: true,
    hasAudioWorklet: true,
    hasGetUserMedia: true,
    hasGetDisplayMedia: true,
    userAgent,
    maxTouchPoints: 0,
    platform: "",
    desktopApp: false,
    ...patch,
  };
}

describe("capture support", () => {
  it("offers tab and system audio on Windows Chrome and Edge", () => {
    for (const ua of [UA.winChrome, UA.winEdge]) {
      expect(detectSupport(input(ua, { platform: "Windows" }))).toEqual({
        secureContext: true,
        audioWorklet: true,
        mic: true,
        tab: true,
        system: true,
        desktopApp: false,
        phone: false,
        nativeRate: false,
      });
    }
  });

  it("offers tab audio but not system audio on macOS Chrome", () => {
    expect(detectSupport(input(UA.macChrome, { platform: "macOS" }))).toMatchObject({ tab: true, system: false, nativeRate: false });
  });

  it("keeps Safari and Firefox to the mic, and runs WebKit at its native rate", () => {
    expect(detectSupport(input(UA.macSafari))).toMatchObject({ mic: true, tab: false, system: false, nativeRate: true });
    expect(detectSupport(input(UA.winFirefox, { platform: "Windows" }))).toMatchObject({
      mic: true,
      tab: false,
      system: false,
      nativeRate: false,
    });
  });

  it("treats phones and iPads as phones with the mic only", () => {
    expect(detectSupport(input(UA.iphone, { hasGetDisplayMedia: false, maxTouchPoints: 5 }))).toMatchObject({
      phone: true,
      nativeRate: true,
      tab: false,
      system: false,
    });
    expect(detectSupport(input(UA.iphoneChrome, { maxTouchPoints: 5 }))).toMatchObject({ phone: true, nativeRate: true, tab: false });
    expect(isPhoneUA(UA.ipad, 5)).toBe(true);
    expect(isWebKitOnlyUA(UA.ipad, 5)).toBe(true);
    expect(isPhoneUA(UA.macSafari, 0)).toBe(false);
    expect(detectSupport(input(UA.android, { hasGetDisplayMedia: false, maxTouchPoints: 5 }))).toMatchObject({
      phone: true,
      nativeRate: false,
      tab: false,
    });
  });

  it("gives the Windows app system audio and no tab picker", () => {
    expect(detectSupport(input(UA.electron, { desktopApp: true, platform: "Win32" }))).toMatchObject({
      desktopApp: true,
      system: true,
      tab: false,
    });
  });

  it("offers nothing on an insecure page or during server rendering", () => {
    expect(detectSupport(input(UA.winChrome, { secureContext: false }))).toMatchObject({
      secureContext: false,
      audioWorklet: false,
      mic: false,
      tab: false,
      system: false,
    });
    expect(readBrowserSupport(false)).toEqual(NO_SUPPORT);
  });
});

describe("source requests", () => {
  it("asks for one raw mic channel", () => {
    expect(micConstraints({})).toEqual({
      audio: { channelCount: { ideal: 1 }, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      video: false,
    });
  });

  it("asks for a tab or a screen with live 1 fps video", () => {
    const tab = displayMediaOptions("tab", { restrictOwnAudio: false, controller: "c" });
    expect(tab.video).toEqual({ displaySurface: "browser", frameRate: { max: 1 }, width: { max: 640 } });
    expect(tab.controller).toBe("c");
    expect(tab.audio).not.toHaveProperty("restrictOwnAudio");
    const system = displayMediaOptions("system", { restrictOwnAudio: true });
    expect(system.video.displaySurface).toBe("monitor");
    expect(system.audio.restrictOwnAudio).toBe(true);
    expect(system).not.toHaveProperty("controller");
    expect(JSON.stringify(system)).not.toMatch(/"exact"|"min"/); // TypeError in getDisplayMedia
  });

  it("maps browser failures to capture codes", () => {
    const err = (name: string) => Object.assign(new Error(name), { name });
    expect(captureErrorCode(err("NotAllowedError"), "mic", true)).toBe("permission_denied");
    expect(captureErrorCode(err("NotAllowedError"), "tab", true)).toBe("share_cancelled");
    expect(captureErrorCode(err("InvalidStateError"), "system", true)).toBe("share_cancelled");
    expect(captureErrorCode(err("NotFoundError"), "mic", true)).toBe("device_error");
    expect(captureErrorCode(err("NotReadableError"), "system", true)).toBe("device_error");
    expect(captureErrorCode(err("TypeError"), "tab", true)).toBe("unsupported");
    expect(captureErrorCode(err("NotAllowedError"), "mic", false)).toBe("insecure_context");
    expect(captureErrorCode(new Error("404"), "sample", true)).toBe("sample_failed");
    expect(captureErrorCode(new CaptureError("no_audio_in_share"), "tab", true)).toBe("no_audio_in_share");
  });
});

describe("sample muffle", () => {
  it("plans the ramps inside the clip", () => {
    expect(planMuffle({ startSec: 2, endSec: 6 }, 10)).toEqual({ startSec: 2, fullSec: 2.3, releaseSec: 5.7, endSec: 6 });
    expect(planMuffle({ startSec: 8, endSec: 14 }, 10)).toEqual({ startSec: 8, fullSec: 8.3, releaseSec: 9.7, endSec: 10 });
    expect(planMuffle({ startSec: 3, endSec: 3.2 }, 10)?.fullSec).toBeCloseTo(3.1, 6);
    expect(planMuffle({ startSec: 5, endSec: 4 }, 10)).toBeNull();
    expect(planMuffle(undefined, 10)).toBeNull();
    expect(MUFFLE.gain).toBeLessThan(1);
  });

  it("says when the clip is muffled and when the key moment passed", () => {
    const spec = { muffle: { startSec: 2, endSec: 6 }, keyMomentSec: 5 };
    expect(sampleStateAt(spec, 1)).toEqual({ muffled: false, keyMomentPassed: false });
    expect(sampleStateAt(spec, 2)).toEqual({ muffled: true, keyMomentPassed: false });
    expect(sampleStateAt(spec, 5.5)).toEqual({ muffled: true, keyMomentPassed: true });
    expect(sampleStateAt(spec, 6)).toEqual({ muffled: false, keyMomentPassed: true });
    expect(sampleStateAt({}, 9)).toEqual({ muffled: false, keyMomentPassed: false });
  });
});

describe("ids", () => {
  it("are base64url and match the session pattern", () => {
    const ids = new Set(Array.from({ length: 200 }, () => randomId(16)));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{16}$/);
  });
});
