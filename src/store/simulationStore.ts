// =============================================================================
// Simulation Store — scan loop controller + power-flow state
// =============================================================================

import { create } from "zustand";
import type { Routine, Rung, ScanResult, TagDefinition } from "../model/types";
import { executeScan, buildTagMap } from "../model/simulate";
import { useProjectStore } from "./projectStore";

export type SimMode = "stopped" | "running" | "single-scan";

export interface SimulationState {
  mode: SimMode;
  /** Result of the last scan — used by canvas for power-flow colouring */
  scanResult: ScanResult;
  /** How many scans have completed */
  scanCount: number;
  /** Scan interval in ms (default 100ms = 10Hz) */
  scanIntervalMs: number;
  /** Actual elapsed task time used for timers during the last scan */
  lastScanDeltaMs: number;
  /** Last scan duration in ms (for diagnostics) */
  lastScanDurationMs: number;
  /** Number of times scan duration exceeded the configured task period */
  taskOverrunCount: number;
  /** Internal timestamp used to calculate real elapsed scan delta */
  lastScanStartedAtMs: number | null;

  start: () => void;
  stop: () => void;
  singleScan: () => void;
  setScanInterval: (ms: number) => void;

  /** Called internally by the loop — not for UI use */
  _tick: () => void;
}

// Internal loop handle
let _loopHandle: ReturnType<typeof setTimeout> | null = null;

function _clearLoop(): void {
  if (_loopHandle !== null) {
    clearTimeout(_loopHandle);
    _loopHandle = null;
  }
}

function _scheduleNextScan(delayMs: number, get: () => SimulationState): void {
  _clearLoop();
  _loopHandle = setTimeout(() => {
    get()._tick();
  }, Math.max(0, delayMs));
}

export const useSimulationStore = create<SimulationState>()((set, get) => ({
  mode: "stopped",
  scanResult: new Map(),
  scanCount: 0,
  scanIntervalMs: 100,
  lastScanDeltaMs: 0,
  lastScanDurationMs: 0,
  taskOverrunCount: 0,
  lastScanStartedAtMs: null,

  start: () => {
    if (get().mode === "running") return;
    set({ mode: "running", lastScanStartedAtMs: performance.now() });
    _scheduleNextScan(0, get);
  },

  stop: () => {
    _clearLoop();
    set({ mode: "stopped", scanResult: new Map(), lastScanStartedAtMs: null });
  },

  singleScan: () => {
    _clearLoop();
    set({ mode: "single-scan" });
    get()._tick();
    set({ mode: "stopped", scanResult: new Map(), lastScanStartedAtMs: null });
  },

  setScanInterval: (ms) => {
    const clamped = Math.max(10, Math.min(5000, Math.round(ms)));
    set({ scanIntervalMs: clamped });
    // If running, reschedule without allowing overlapping scans.
    if (get().mode === "running") {
      _scheduleNextScan(clamped, get);
    }
  },

  _tick: () => {
    const simBefore = get();
    const scanStartedAt = performance.now();
    const { activeRoutineId, project } = useProjectStore.getState();
    if (!activeRoutineId) return;

    // Studio-style execution: opening a routine in the editor does not make it
    // scan. The first routine in the active program is the entry routine; other
    // routines execute only when called by JSR.
    let entryRoutine = null;
    for (const prog of project.programs) {
      const r = prog.routines.find((r) => r.id === activeRoutineId);
      if (r) {
        entryRoutine = prog.routines[0] ?? null;
        break;
      }
    }
    if (!entryRoutine) return;

    const t0 = performance.now();
    // In Run, timers advance by actual elapsed task time. Single Scan uses
    // one configured task period so stepping stays deterministic.
    const deltaMs = simBefore.mode === "running" && simBefore.lastScanStartedAtMs !== null
      ? Math.max(1, Math.min(scanStartedAt - simBefore.lastScanStartedAtMs, 60_000))
      : simBefore.scanIntervalMs;

    // Build a mutable tag map for this scan
    // Note: immer-managed tags are frozen, so we deep-copy them
    const tagsCopy: TagDefinition[] = JSON.parse(JSON.stringify(project.tags));
    const tagMap = buildTagMap(tagsCopy);

    // Execute scan against the currently accepted online-edit image. Pending
    // changed/deleted rungs keep scanning their saved original until accepted.
    const acceptedEntryRoutine = buildAcceptedRoutine(entryRoutine);
    const acceptedRoutines = project.programs
      .flatMap(program => program.routines)
      .map(buildAcceptedRoutine);

    const result = executeScan(
      acceptedEntryRoutine,
      tagMap,
      deltaMs,
      acceptedRoutines
    );

    // Write back tag values that changed
    // (We update the project store directly; immer handles immutability)
    const ps = useProjectStore.getState();
    for (const updatedTag of tagsCopy) {
      const original = project.tags.find((t) => t.name === updatedTag.name);
      if (!original) continue;

      // Check if anything changed
      const changed =
        updatedTag.value !== original.value ||
        JSON.stringify(updatedTag.timerData) !== JSON.stringify(original.timerData) ||
        JSON.stringify(updatedTag.counterData) !== JSON.stringify(original.counterData);

      if (changed) {
        if (updatedTag.dataType === "BOOL") {
          ps.setTagValue(updatedTag.name, updatedTag.value);
        } else if (updatedTag.dataType === "DINT" || updatedTag.dataType === "INT" || updatedTag.dataType === "REAL") {
          // Scalar or array numeric tag — write value directly
          ps.setTagValue(updatedTag.name, updatedTag.value);
        } else {
          // TIMER / COUNTER — sync structured data
          _syncTagData(updatedTag);
        }
      }
    }

    const t1 = performance.now();
    const scanDurationMs = +(t1 - t0).toFixed(2);
    const intervalMs = get().scanIntervalMs;
    const overrun = scanDurationMs > intervalMs;

    set((s) => ({
      scanResult: result,
      scanCount: s.scanCount + 1,
      lastScanDeltaMs: +deltaMs.toFixed(2),
      lastScanDurationMs: scanDurationMs,
      lastScanStartedAtMs: scanStartedAt,
      taskOverrunCount: overrun ? s.taskOverrunCount + 1 : s.taskOverrunCount,
    }));

    if (simBefore.mode === "running" && get().mode === "running") {
      _scheduleNextScan(Math.max(0, intervalMs - scanDurationMs), get);
    }
  },
}));

function buildAcceptedRoutine(routine: Routine): Routine {
  return {
    ...routine,
    rungs: routine.rungs.flatMap((rung) => acceptedRung(rung)),
  };
}

function acceptedRung(rung: Rung): Rung[] {
  if (!rung.onlineEditStatus) return [rung];
  if (!rung.onlineEditOriginal) return [];
  return [{
    ...rung,
    comment: rung.onlineEditOriginal.comment,
    nodes: rung.onlineEditOriginal.nodes,
    disabled: rung.onlineEditOriginal.disabled,
    onlineEditStatus: undefined,
    onlineEditOriginal: undefined,
  }];
}

// Internal helper to sync timer/counter structured data back to the project store
function _syncTagData(updatedTag: TagDefinition): void {
  useProjectStore.setState((state) => {
    const tag = state.project.tags.find((t) => t.name === updatedTag.name);
    if (!tag) return;
    if (updatedTag.dataType === "TIMER" && updatedTag.timerData) {
      tag.timerData = { ...updatedTag.timerData };
    }
    if (updatedTag.dataType === "COUNTER" && updatedTag.counterData) {
      tag.counterData = { ...updatedTag.counterData };
    }
  });
}
