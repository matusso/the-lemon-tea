import { create } from "zustand";

export type Mode = "command" | "lab" | "intel" | "strategy" | "research";
export type CameraMode = "top" | "iso" | "orbit" | "follow" | "corner";
export type Overlay = "none" | "delta" | "speed" | "throttle" | "brake";

export interface LapPick {
  sessionId: string | null;
  driverNumber: number | null;
  lapNumber: number | null; // null = fastest
}

interface UiState {
  mode: Mode;
  year: number | null;
  meetingId: string | null;
  sessionId: string | null;
  driverA: number | null;
  driverB: number | null;
  pinned: number[];
  /** Lap-distance cursor shared by charts, track map and 3D circuit (metres on the comparison reference lap). */
  cursorDistance: number | null;
  camera: CameraMode;
  focusCorner: number | null;
  overlay: Overlay;
  elevationExaggeration: number;
  lapA: LapPick;
  lapB: LapPick;
  set: (p: Partial<UiState>) => void;
  selectDriver: (n: number, asB: boolean) => void;
  togglePin: (n: number) => void;
}

function readPersist(): Partial<UiState> {
  try {
    return JSON.parse(localStorage.getItem("lt:ui") ?? "{}");
  } catch {
    return {};
  }
}

const persisted = readPersist();

export const useUi = create<UiState>((set, get) => ({
  mode: (persisted.mode as Mode) ?? "command",
  year: persisted.year ?? null,
  meetingId: persisted.meetingId ?? null,
  sessionId: persisted.sessionId ?? null,
  driverA: null,
  driverB: null,
  pinned: [],
  cursorDistance: null,
  camera: "iso",
  focusCorner: null,
  overlay: "delta",
  elevationExaggeration: 1,
  lapA: { sessionId: null, driverNumber: null, lapNumber: null },
  lapB: { sessionId: null, driverNumber: null, lapNumber: null },
  set: (p) => set(p),
  selectDriver: (n, asB) => {
    const s = get();
    if (asB) set({ driverB: s.driverB === n ? null : n });
    else set({ driverA: s.driverA === n ? null : n, driverB: s.driverB === n ? null : s.driverB });
  },
  togglePin: (n) => set({ pinned: get().pinned.includes(n) ? get().pinned.filter((x) => x !== n) : [...get().pinned, n] }),
}));

useUi.subscribe((s) => {
  try {
    localStorage.setItem("lt:ui", JSON.stringify({ mode: s.mode, year: s.year, meetingId: s.meetingId, sessionId: s.sessionId }));
  } catch {
    // storage unavailable (private mode): selection simply isn't remembered
  }
});
