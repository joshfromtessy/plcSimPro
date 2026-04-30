// =============================================================================
// Simulation Store — scan loop controller + power-flow state
// =============================================================================

import { create } from "zustand";
import type { ScanResult, TagDefinition } from "../model/types";
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
  /** Last scan duration in ms (for diagnostics) */
  lastScanDurationMs: number;

  start: () => void;
  stop: () => void;
  singleScan: () => void;
  setScanInterval: (ms: number) => void;

  /** Called internally by the loop — not for UI use */
  _tick: () => void;
}

// Internal loop handle
let _loopHandle: ReturnType<typeof setInterval> | null = null;

export const useSimulationStore = create<SimulationState>()((set, get) => ({
  mode: "stopped",
  scanResult: new Map(),
  scanCount: 0,
  scanIntervalMs: 100,
  lastScanDurationMs: 0,

  start: () => {
    if (get().mode === "running") return;
    set({ mode: "running" });
    const intervalMs = get().scanIntervalMs;
    _loopHandle = setInterval(() => get()._tick(), intervalMs);
  },

  stop: () => {
    if (_loopHandle !== null) {
      clearInterval(_loopHandle);
      _loopHandle = null;
    }
    set({ mode: "stopped" });
  },

  singleScan: () => {
    if (_loopHandle !== null) {
      clearInterval(_loopHandle);
      _loopHandle = null;
    }
    set({ mode: "single-scan" });
    get()._tick();
    set({ mode: "stopped" });
  },

  setScanInterval: (ms) => {
    set({ scanIntervalMs: ms });
    // If running, restart the loop with new interval
    if (get().mode === "running") {
      if (_loopHandle !== null) clearInterval(_loopHandle);
      _loopHandle = setInterval(() => get()._tick(), ms);
    }
  },

  _tick: () => {
    const { activeRoutineId, project } = useProjectStore.getState();
    if (!activeRoutineId) return;

    // Find the active routine
    let activeRoutine = null;
    for (const prog of project.programs) {
      const r = prog.routines.find((r) => r.id === activeRoutineId);
      if (r) { activeRoutine = r; break; }
    }
    if (!activeRoutine) return;

    const t0 = performance.now();
    // Pass the configured scan interval as deltaMs so timers accumulate
    // exactly that many ms per scan — predictable and spec-correct.
    const deltaMs = get().scanIntervalMs;

    // Build a mutable tag map for this scan
    // Note: immer-managed tags are frozen, so we deep-copy them
    const tagsCopy: TagDefinition[] = JSON.parse(JSON.stringify(project.tags));
    const tagMap = buildTagMap(tagsCopy);

    // Execute scan
    const result = executeScan(activeRoutine, tagMap, deltaMs);

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

    set((s) => ({
      scanResult: result,
      scanCount: s.scanCount + 1,
      lastScanDurationMs: +(t1 - t0).toFixed(2),
    }));
  },
}));

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
