"use client";
// React hooks over the external stores. Every hook has a server snapshot, so prerendering and
// hydration see the same first frame and the client catches up right after.
import { useSyncExternalStore } from "react";
import { getController, type ControllerSnapshot, type LevelView, type SessionController } from "./controller";
import { getSettingsStore, type SettingsState, type SettingsStore } from "./settings";
import { clock1000, clock250, phoneQuery, reducedMotionQuery, wideQuery } from "./stores";

const noopSubscribe = () => () => undefined;
const zero = () => 0;

export function useController(): SessionController {
  return getController();
}

export function useSession(): ControllerSnapshot {
  const c = getController();
  return useSyncExternalStore(c.subscribe, c.getSnapshot, c.getServerSnapshot);
}

export function useLevel(): LevelView {
  const c = getController();
  return useSyncExternalStore(c.subscribeLevel, c.getLevel, c.getServerLevel);
}

export function useSettingsStore(): SettingsStore {
  return getSettingsStore();
}

export function useSettings(): SettingsState {
  const s = getSettingsStore();
  return useSyncExternalStore(s.subscribe, s.getSnapshot, s.getServerSnapshot);
}

/** Epoch ms that ticks while active (4 times a second when fast). 0 while inactive and on the server. */
export function useNow(active: boolean, fast = false): number {
  const clock = fast ? clock250 : clock1000;
  return useSyncExternalStore(
    active ? clock.subscribe : noopSubscribe,
    active ? clock.getSnapshot : zero,
    clock.getServerSnapshot,
  );
}

export function useIsPhone(): boolean {
  return useSyncExternalStore(phoneQuery.subscribe, phoneQuery.getSnapshot, phoneQuery.getServerSnapshot);
}

export function useIsWide(): boolean {
  return useSyncExternalStore(wideQuery.subscribe, wideQuery.getSnapshot, wideQuery.getServerSnapshot);
}

export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    reducedMotionQuery.subscribe,
    reducedMotionQuery.getSnapshot,
    reducedMotionQuery.getServerSnapshot,
  );
}
