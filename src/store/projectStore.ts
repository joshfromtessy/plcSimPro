// =============================================================================
// Project Store — routines, rungs, model mutations
// =============================================================================
// ALL mutations go through validateInsert / validateDelete first.
// If invalid, the mutation is rejected and an error is stored in lastError.
// =============================================================================

import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import type {
  PlcProject,
  Routine,
  RoutineLanguage,
  Rung,
  SeriesNode,
  InstructionNode,
  BranchNode,
  InstructionType,
  InsertPosition,
  DeleteTarget,
  TagDefinition,
  TagDataType,
  TagValue,
  ValidationResult,
  TimerParams,
  CounterParams,
  CompareParams,
  MoveParams,
  CopyParams,
  BitShiftParams,
  MathParams,
  JsrParams,
  InstructionParams,
} from "../model/types";

import {
  genId,
  applyInsert,
  applyDelete,
  findRung,
  updateRung,
  deleteRung as astDeleteRung,
  wrapInEmptyBranch,
  findContainingBranch,
  findNodeInSeries,
  cloneNodeWithNewIds,
  cloneNode,
  locateNodeInRung,
} from "../model/ast";

import {
  validateInsert,
  validateDelete,
  validateTagAssign,
} from "../model/validate";

import {
  defaultTimerData,
  defaultCounterData,
} from "../model/simulate";

type ProjectHistorySnapshot = {
  project: PlcProject;
  activeRoutineId: string | null;
};

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

function makeInstruction(type: InstructionType): InstructionNode {
  let params: InstructionParams = {};
  if (type === "TON" || type === "TOF" || type === "RTO") {
    params = { preset: 1000, accum: 0 } satisfies TimerParams;
  } else if (type === "CTU" || type === "CTD") {
    params = { preset: 10, accum: 0 } satisfies CounterParams;
  } else if (type === "LIM") {
    params = { sourceA: "", sourceB: "", sourceC: "" } satisfies CompareParams;
  } else if (["EQU","NEQ","LES","LEQ","GRT","GEQ"].includes(type)) {
    params = { sourceA: "", sourceB: "" } satisfies CompareParams;
  } else if (type === "MOV") {
    params = { source: "", dest: "" } satisfies MoveParams;
  } else if (type === "MVM") {
    params = { source: "", dest: "", mask: "0xFFFFFFFF" } satisfies MoveParams;
  } else if (type === "COP" || type === "CPS") {
    params = { source: "", dest: "", length: "1" } satisfies CopyParams;
  } else if (type === "BSL" || type === "BSR") {
    params = { array: "", source: "", length: "32" } satisfies BitShiftParams;
  } else if (["ADD","SUB","MUL","DIV","MOD"].includes(type)) {
    params = { sourceA: "", sourceB: "", dest: "" } satisfies MathParams;
  } else if (["NEG","ABS","SQR","CLR"].includes(type)) {
    params = { sourceA: "", dest: "" } satisfies MathParams;
  } else if (type === "JSR") {
    params = { routineName: "" } satisfies JsrParams;
  }
  return {
    kind: "instruction",
    id: genId("inst"),
    type,
    tagName: "",
    params,
  };
}

function makeRung(comment = ""): Rung {
  return { id: genId("rung"), comment, nodes: [] };
}

function makeRoutine(name: string, language: RoutineLanguage = "LAD"): Routine {
  return {
    id: genId("routine"),
    name,
    language,
    rungs: [],
    structuredText: language === "ST" ? "(* Structured Text routine *)\n" : undefined,
  };
}

function makeDefaultProject(): PlcProject {
  const now = new Date().toISOString();
  return {
    id: genId("proj"),
    name: "Untitled Project",
    programs: [
      {
        id: genId("prog"),
        name: "MainProgram",
        routines: [makeRoutine("MainRoutine")],
      },
    ],
    tags: [],
    createdAt: now,
    modifiedAt: now,
  };
}

// ---------------------------------------------------------------------------
// Store shape
// ---------------------------------------------------------------------------

export interface ProjectState {
  project: PlcProject;
  /** The routine currently open in the editor */
  activeRoutineId: string | null;
  /** Last validation error (shown in status bar) */
  lastError: string | null;
  /** True while rung edits should be staged as online edits. */
  onlineEditActive: boolean;
  undoStack: ProjectHistorySnapshot[];
  redoStack: ProjectHistorySnapshot[];

  // ── Project
  setProjectName: (name: string) => void;
  newProject: () => void;
  loadProject: (data: PlcProject) => void;
  undo: () => void;
  redo: () => void;
  /** Move a rung before or after another rung. afterRungId=null means move to top. */
  moveRung: (routineId: string, rungId: string, afterRungId: string | null) => void;
  setOnlineEditActive: (active: boolean) => void;
  beginOnlineEditRung: (routineId: string, rungId: string) => void;
  acceptOnlineEdits: () => void;
  cancelOnlineEdits: () => void;

  // ── Routines
  setActiveRoutine: (id: string) => void;
  addRoutine: (programId: string, name: string, language?: RoutineLanguage) => void;
  renameRoutine: (routineId: string, name: string) => void;
  deleteRoutine: (routineId: string) => void;
  setStructuredText: (routineId: string, source: string) => void;

  // ── Rungs
  addRung: (routineId: string, comment?: string) => void;
  deleteRung: (routineId: string, rungId: string) => void;
  setRungComment: (routineId: string, rungId: string, comment: string) => void;
  setRungDisabled: (routineId: string, rungId: string, disabled: boolean) => void;

  // ── Instructions
  insertInstruction: (
    routineId: string,
    position: InsertPosition,
    type: InstructionType
  ) => ValidationResult;

  deleteNode: (
    routineId: string,
    target: DeleteTarget
  ) => ValidationResult;

  moveNode: (
    routineId: string,
    sourceRungId: string,
    nodeId: string,
    destination: InsertPosition
  ) => ValidationResult;

  copyNode: (
    routineId: string,
    sourceRungId: string,
    nodeId: string,
    destination: InsertPosition
  ) => ValidationResult;

  /** Wrap a single instruction node in a 2-leg branch (second leg starts empty) */
  wrapNodeInBranch: (
    routineId: string,
    rungId: string,
    nodeId: string
  ) => ValidationResult;

  /** Append an empty parallel leg to an existing branch */
  addBranchLeg: (
    routineId: string,
    rungId: string,
    branchId: string
  ) => ValidationResult;

  /**
   * Pull the immediate neighbour of a branch in the parent series into
   * the specified branch leg.
   *  direction "next"  → absorb the instruction after the branch into the leg
   *  direction "prev"  → absorb the instruction before the branch into the leg
   */
  absorbNext: (
    routineId: string,
    rungId: string,
    branchId: string,
    legId: string,
    direction: "next" | "prev"
  ) => ValidationResult;

  /**
   * Eject the first or last instruction from a branch leg back into the
   * parent series immediately after (or before) the branch.
   *  side "last"  → eject last node in leg, place it after the branch
   *  side "first" → eject first node in leg, place it before the branch
   */
  ejectFromLeg: (
    routineId: string,
    rungId: string,
    branchId: string,
    legId: string,
    side: "first" | "last"
  ) => ValidationResult;

  assignTag: (
    routineId: string,
    rungId: string,
    nodeId: string,
    tagName: string
  ) => ValidationResult;

  /** Update preset/presetTag on a timer or counter instruction */
  setInstructionParams: (
    routineId: string,
    rungId: string,
    nodeId: string,
    patch: Partial<TimerParams & CounterParams & CompareParams & MoveParams & CopyParams & BitShiftParams & MathParams & JsrParams>
  ) => void;

  // ── Node comment
  setNodeComment: (routineId: string, rungId: string, nodeId: string, comment: string) => void;

  // ── Tags
  addTag: (name: string, dataType: TagDataType, description?: string, size?: number) => void;
  deleteTag: (tagId: string) => void;
  setTagValue: (tagName: string, value: TagValue) => void;
  /** Write a single element of an array tag (DINT/INT) by zero-based index. */
  setTagElementValue: (tagName: string, idx: number, value: number) => void;
  /** Set or clear a single bit of a DINT/INT scalar or array element. */
  setTagBit: (tagName: string, idx: number | undefined, bit: number, value: boolean) => void;
  setTagName: (tagId: string, newName: string) => void;
  setTagDescription: (tagId: string, description: string) => void;

  clearError: () => void;
}

// ---------------------------------------------------------------------------
// Store implementation
// ---------------------------------------------------------------------------

export const useProjectStore = create<ProjectState>()(
  immer((set, get) => {
    const defaultProject = makeDefaultProject();

    return {
      project: defaultProject,
      activeRoutineId:
        defaultProject.programs[0]?.routines[0]?.id ?? null,
      lastError: null,
      onlineEditActive: false,
      undoStack: [],
      redoStack: [],

      // ── Project ──────────────────────────────────────────────────────────

      setProjectName: (name) =>
        set((s) => {
          pushUndo(s);
          s.project.name = name;
        }),

      newProject: () =>
        set((s) => {
          pushUndo(s);
          const p = makeDefaultProject();
          s.project = p;
          s.activeRoutineId = p.programs[0]?.routines[0]?.id ?? null;
          s.lastError = null;
          s.onlineEditActive = false;
        }),

      loadProject: (data) =>
        set((s) => {
          pushUndo(s);
          // Strip runtime-only _startMs from timerData so it doesn't pollute state
          const cleaned = {
            ...data,
            programs: data.programs.map(program => ({
              ...program,
              routines: program.routines.map(routine => ({
                ...routine,
                language: routine.language ?? "LAD",
                rungs: routine.rungs ?? [],
                structuredText: routine.language === "ST" ? routine.structuredText ?? "" : routine.structuredText,
              })),
            })),
            tags: data.tags.map(tag => {
              const t = { ...tag };
              if (t.timerData) {
                const { en, tt, dn, preset, accum } = t.timerData;
                t.timerData = { en, tt, dn, preset, accum };
              }
              if (t.counterData) {
                const { cu, cd, dn, ov, un, preset, accum } = t.counterData;
                t.counterData = { cu, cd, dn, ov, un, preset, accum };
              }
              return t;
            }),
          };
          s.project = cleaned;
          s.activeRoutineId = cleaned.programs[0]?.routines[0]?.id ?? null;
          s.lastError = null;
          s.onlineEditActive = false;
        }),

      undo: () =>
        set((s) => {
          const prev = s.undoStack.pop();
          if (!prev) return;
          s.redoStack.push(snapshotProjectState(s));
          s.project = cloneProject(prev.project);
          s.activeRoutineId = prev.activeRoutineId;
          s.lastError = null;
        }),

      redo: () =>
        set((s) => {
          const next = s.redoStack.pop();
          if (!next) return;
          s.undoStack.push(snapshotProjectState(s));
          s.project = cloneProject(next.project);
          s.activeRoutineId = next.activeRoutineId;
          s.lastError = null;
        }),

      setOnlineEditActive: (active) =>
        set((s) => {
          s.onlineEditActive = active;
        }),

      beginOnlineEditRung: (routineId, rungId) =>
        set((s) => {
          const rung = findRungInProject(s.project, routineId, rungId);
          if (!rung || rung.onlineEditStatus) return;
          pushUndo(s);
          markRungOnlineEdit(rung);
          s.lastError = null;
        }),

      acceptOnlineEdits: () =>
        set((s) => {
          pushUndo(s);
          for (const program of s.project.programs) {
            for (const routine of program.routines) {
              routine.rungs = routine.rungs.filter((rung) => rung.onlineEditStatus !== "pending-delete");
              for (const rung of routine.rungs) {
                if (!rung.onlineEditStatus) continue;
                delete rung.onlineEditStatus;
                delete rung.onlineEditOriginal;
              }
            }
          }
          s.lastError = null;
        }),

      cancelOnlineEdits: () =>
        set((s) => {
          pushUndo(s);
          for (const program of s.project.programs) {
            for (const routine of program.routines) {
              routine.rungs = routine.rungs.filter((rung) => {
                return !(rung.onlineEditStatus === "pending" && !rung.onlineEditOriginal);
              });
              for (const rung of routine.rungs) {
                if (!rung.onlineEditStatus) continue;
                const original = rung.onlineEditOriginal;
                if (original) {
                  rung.comment = original.comment;
                  rung.nodes = cloneSeriesNodes(original.nodes);
                  rung.disabled = original.disabled;
                }
                delete rung.onlineEditStatus;
                delete rung.onlineEditOriginal;
              }
            }
          }
          s.lastError = null;
        }),

      moveRung: (routineId, rungId, afterRungId) =>
        set((s) => {
          const routine = findRoutine(s.project, routineId);
          if (!routine) return;
          const idx = routine.rungs.findIndex(r => r.id === rungId);
          if (idx < 0) return;
          pushUndo(s);
          const [rung] = routine.rungs.splice(idx, 1);
          if (afterRungId === null) {
            routine.rungs.unshift(rung);
          } else {
            const targetIdx = routine.rungs.findIndex(r => r.id === afterRungId);
            routine.rungs.splice(targetIdx < 0 ? routine.rungs.length : targetIdx + 1, 0, rung);
          }
        }),

      // ── Routines ─────────────────────────────────────────────────────────

      setActiveRoutine: (id) =>
        set((s) => { s.activeRoutineId = id; }),

      addRoutine: (programId, name, language = "LAD") =>
        set((s) => {
          const prog = s.project.programs.find((p) => p.id === programId);
          if (prog) {
            pushUndo(s);
            const r = makeRoutine(name, language);
            prog.routines.push(r);
            s.activeRoutineId = r.id;
          }
        }),

      renameRoutine: (routineId, name) =>
        set((s) => {
          const trimmed = name.trim();
          if (!trimmed) return;
          const routine = findRoutine(s.project, routineId);
          if (routine) {
            pushUndo(s);
            routine.name = trimmed;
          }
        }),

      deleteRoutine: (routineId) =>
        set((s) => {
          for (const program of s.project.programs) {
            const idx = program.routines.findIndex((routine) => routine.id === routineId);
            if (idx === -1) continue;
            if (program.routines.length <= 1) {
              s.lastError = "A program must keep at least one routine";
              return;
            }
            pushUndo(s);
            program.routines.splice(idx, 1);
            if (s.activeRoutineId === routineId) {
              const nextRoutine = program.routines[Math.min(idx, program.routines.length - 1)];
              s.activeRoutineId = nextRoutine?.id ?? s.project.programs
                .flatMap((p) => p.routines)
                .at(0)?.id ?? null;
            }
            s.lastError = null;
            return;
          }
        }),

      setStructuredText: (routineId, source) =>
        set((s) => {
          const routine = findRoutine(s.project, routineId);
          if (!routine || routine.language !== "ST") return;
          pushUndo(s);
          routine.structuredText = source;
          s.lastError = null;
        }),

      // ── Rungs ─────────────────────────────────────────────────────────────

      addRung: (routineId, comment = "") =>
        set((s) => {
          const routine = findRoutine(s.project, routineId);
          if (routine) {
            pushUndo(s);
            const rung = makeRung(comment);
            if (s.onlineEditActive) rung.onlineEditStatus = "pending";
            routine.rungs.push(rung);
          }
        }),

      deleteRung: (routineId, rungId) =>
        set((s) => {
          const routine = findRoutine(s.project, routineId);
          if (routine) {
            const rung = routine.rungs.find((r) => r.id === rungId);
            if (!rung) return;
            pushUndo(s);
            if (s.onlineEditActive && rung) {
              markRungOnlineEdit(rung, "pending-delete");
            } else {
              routine.rungs = routine.rungs.filter((r) => r.id !== rungId);
            }
          }
        }),

      setRungComment: (routineId, rungId, comment) =>
        set((s) => {
          const rung = findRungInProject(s.project, routineId, rungId);
          if (rung) {
            pushUndo(s);
            rung.comment = comment;
          }
        }),

      setNodeComment: (routineId, rungId, nodeId, comment) =>
        set((s) => {
          const rung = findRungInProject(s.project, routineId, rungId);
          if (!rung) return;
          pushUndo(s);
          const node = findNodeInSeries(rung.nodes, nodeId);
          if (node?.kind === "instruction") node.comment = comment || undefined;
        }),

      setRungDisabled: (routineId, rungId, disabled) =>
        set((s) => {
          const rung = findRungInProject(s.project, routineId, rungId);
          if (rung) {
            pushUndo(s);
            if (s.onlineEditActive) markRungOnlineEdit(rung);
            rung.disabled = disabled;
          }
        }),

      // ── Instructions ──────────────────────────────────────────────────────

      insertInstruction: (routineId, position, type) => {
        // Determine the rungId from the position
        const rungId = "rungId" in position ? position.rungId : null;
        if (!rungId && position.kind !== "rung-append") {
          const e = { valid: false as const, reason: "Position has no rungId" };
          set((s) => { s.lastError = e.reason; });
          return e;
        }

        // Get current rung state for validation
        const state = get();
        let currentRung: Rung | null = null;
        if (rungId) {
          const routine = findRoutineFromState(state, routineId);
          currentRung = routine ? findRung(routine, rungId) ?? null : null;
        }

        if (position.kind === "rung-append") {
          set((s) => {
            const routine = findRoutine(s.project, routineId);
            if (routine) {
              pushUndo(s);
              const newRung = makeRung();
              const newNode = makeInstruction(type);
              if (s.onlineEditActive) newRung.onlineEditStatus = "pending";
              newRung.nodes.push(newNode);
              routine.rungs.push(newRung);
            }
          });
          return { valid: true };
        }

        if (!currentRung) {
          const e = { valid: false as const, reason: `Rung '${rungId}' not found` };
          set((s) => { s.lastError = e.reason; });
          return e;
        }

        // Validate
        const result = validateInsert(currentRung, position, type);
        if (!result.valid) {
          set((s) => { s.lastError = result.reason; });
          return result;
        }

        // Compute the updated rung from plain objects (outside Immer draft)
        const newNode = makeInstruction(type);
        const rungForEdit = state.onlineEditActive ? withOnlineEditSnapshot(currentRung) : currentRung;
        const updatedRung = applyInsert(rungForEdit, position, newNode);

        set((s) => {
          const routine = findRoutine(s.project, routineId);
          if (!routine) return;
          pushUndo(s);
          const rungIdx = routine.rungs.findIndex((r) => r.id === rungId);
          if (rungIdx !== -1) routine.rungs[rungIdx] = updatedRung;
          s.lastError = null;
        });

        return { valid: true };
      },

      deleteNode: (routineId, target) => {
        if (target.kind === "rung") {
          set((s) => {
          const routine = findRoutine(s.project, routineId);
          if (routine) {
            const rung = routine.rungs.find((r) => r.id === target.rungId);
            if (!rung) return;
            pushUndo(s);
            if (s.onlineEditActive && rung) {
                markRungOnlineEdit(rung, "pending-delete");
              } else {
                routine.rungs = routine.rungs.filter((r) => r.id !== target.rungId);
              }
            }
            s.lastError = null;
          });
          return { valid: true };
        }

        const state = get();
        const routine = findRoutineFromState(state, routineId);
        const rungId = target.rungId;
        const rung = routine ? findRung(routine, rungId) ?? null : null;

        if (!rung) {
          const e = { valid: false as const, reason: `Rung '${rungId}' not found` };
          set((s) => { s.lastError = e.reason; });
          return e;
        }

        const result = validateDelete(rung, target);
        if (!result.valid) {
          set((s) => { s.lastError = result.reason; });
          return result;
        }

        // Compute the updated rung from plain objects (outside Immer draft)
        const rungForEdit = state.onlineEditActive ? withOnlineEditSnapshot(rung) : rung;
        const updatedRung = applyDelete(rungForEdit, target);

        set((s) => {
          const routine = findRoutine(s.project, routineId);
          if (!routine) return;
          pushUndo(s);
          const idx = routine.rungs.findIndex((r) => r.id === rungId);
          if (idx !== -1) routine.rungs[idx] = updatedRung;
          s.lastError = null;
        });

        return { valid: true };
      },

      moveNode: (routineId, sourceRungId, nodeId, destination) => {
        // No-op if dropped back on itself
        const destRungId = (destination as any).rungId as string | undefined;
        if (!destRungId) return { valid: false, reason: "Invalid destination" };

        const siblingId = (destination as any).siblingId as string | undefined;
        if (siblingId === nodeId) return { valid: true }; // dropped on itself

        // ── Compute all new rung states from the CURRENT PLAIN state ───────────
        // We deliberately call get() here (outside Immer's set()) so that
        // applyDelete / applyInsert operate on plain objects, not draft proxies.
        // Mixing Immer draft proxies with spread-based pure functions produces
        // objects whose nodes still contain live proxies, corrupting the state
        // when Immer finalises the draft.
        const state = get();
        const routine = findRoutineFromState(state, routineId);
        if (!routine) {
          const e = { valid: false as const, reason: "Routine not found" };
          set((s) => { s.lastError = e.reason; });
          return e;
        }

        const srcRung = findRung(routine, sourceRungId);
        if (!srcRung) {
          const e = { valid: false as const, reason: "Source rung not found" };
          set((s) => { s.lastError = e.reason; });
          return e;
        }

        const srcNode = findNodeInSeries(srcRung.nodes, nodeId);
        if (!srcNode) {
          const e = { valid: false as const, reason: "Node not found in source rung" };
          set((s) => { s.lastError = e.reason; });
          return e;
        }

        // 1. Delete node from source rung (plain objects, no draft)
        let srcRungAfterDelete: Rung;
        try {
          srcRungAfterDelete = applyDelete(srcRung, { kind: "node", rungId: sourceRungId, nodeId });
        } catch (err) {
          const e = { valid: false as const, reason: `Delete failed: ${err}` };
          set((s) => { s.lastError = e.reason; });
          return e;
        }

        // 2. Deep-clone the source node with fresh IDs (works for both
        //    instruction nodes and entire branch blocks)
        const newNode = cloneNodeWithNewIds(srcNode);

        // 3. Insert into destination rung.
        //    If moving within the same rung, insert into the post-delete version
        //    so index offsets are already accounted for.
        const rungForInsert = sourceRungId === destRungId
          ? srcRungAfterDelete
          : findRung(routine, destRungId);
        if (!rungForInsert) {
          const e = { valid: false as const, reason: "Destination rung not found" };
          set((s) => { s.lastError = e.reason; });
          return e;
        }

        let destRungFinal: Rung;
        try {
          destRungFinal = applyInsert(rungForInsert, destination, newNode);
        } catch (err) {
          const e = { valid: false as const, reason: `Insert failed: ${err}` };
          set((s) => { s.lastError = e.reason; });
          return e;
        }

        // 4. Apply the computed plain-object results atomically
        set((s) => {
          const r = findRoutine(s.project, routineId);
          if (!r) return;
          pushUndo(s);

          if (s.onlineEditActive) {
            const srcLive = r.rungs.find((rg) => rg.id === sourceRungId);
            const dstLive = r.rungs.find((rg) => rg.id === destRungId);
            if (sourceRungId === destRungId) {
              destRungFinal = withExistingOnlineEdit(destRungFinal, srcLive);
            } else {
              srcRungAfterDelete = withExistingOnlineEdit(srcRungAfterDelete, srcLive);
              destRungFinal = withExistingOnlineEdit(destRungFinal, dstLive);
            }
          }

          if (sourceRungId === destRungId) {
            // Same rung — just write the combined result
            const idx = r.rungs.findIndex((rg) => rg.id === sourceRungId);
            if (idx !== -1) r.rungs[idx] = destRungFinal;
          } else {
            // Different rungs — update each independently
            const srcIdx = r.rungs.findIndex((rg) => rg.id === sourceRungId);
            const dstIdx = r.rungs.findIndex((rg) => rg.id === destRungId);
            if (srcIdx !== -1) r.rungs[srcIdx] = srcRungAfterDelete;
            if (dstIdx !== -1) r.rungs[dstIdx] = destRungFinal;
          }

          s.lastError = null;
        });

        return { valid: true };
      },

      copyNode: (routineId, sourceRungId, nodeId, destination) => {
        const destRungId = (destination as any).rungId as string | undefined;
        if (!destRungId) return { valid: false, reason: "Invalid destination" };

        const state = get();
        const routine = findRoutineFromState(state, routineId);
        if (!routine) {
          const e = { valid: false as const, reason: "Routine not found" };
          set((s) => { s.lastError = e.reason; });
          return e;
        }

        const srcRung = findRung(routine, sourceRungId);
        const destRung = findRung(routine, destRungId);
        if (!srcRung || !destRung) {
          const e = { valid: false as const, reason: "Rung not found" };
          set((s) => { s.lastError = e.reason; });
          return e;
        }

        const srcNode = findNodeInSeries(srcRung.nodes, nodeId);
        if (!srcNode) {
          const e = { valid: false as const, reason: "Node not found" };
          set((s) => { s.lastError = e.reason; });
          return e;
        }

        const typeForValidation = srcNode.kind === "instruction" ? srcNode.type : "XIC";
        const result = validateInsert(destRung, destination, typeForValidation);
        if (!result.valid) {
          set((s) => { s.lastError = result.reason; });
          return result;
        }

        const newNode = cloneNodeWithNewIds(srcNode);
        const rungForEdit = state.onlineEditActive ? withOnlineEditSnapshot(destRung) : destRung;
        const updatedRung = applyInsert(rungForEdit, destination, newNode);

        set((s) => {
          const r = findRoutine(s.project, routineId);
          if (!r) return;
          pushUndo(s);
          const idx = r.rungs.findIndex((rg) => rg.id === destRungId);
          if (idx !== -1) r.rungs[idx] = updatedRung;
          s.lastError = null;
        });

        return { valid: true };
      },

      wrapNodeInBranch: (routineId, rungId, nodeId) => {
        const state = get();
        const routine = findRoutineFromState(state, routineId);
        if (!routine) return { valid: false, reason: "Routine not found" };
        const rung = findRung(routine, rungId);
        if (!rung) return { valid: false, reason: "Rung not found" };

        const newNodes = wrapInEmptyBranch(rung.nodes, nodeId);
        if (!newNodes) return { valid: false, reason: "Node not found in rung" };

        const updatedRung: Rung = { ...(state.onlineEditActive ? withOnlineEditSnapshot(rung) : rung), nodes: newNodes };
        set((s) => {
          const r = findRoutine(s.project, routineId);
          if (!r) return;
          pushUndo(s);
          const idx = r.rungs.findIndex((rg) => rg.id === rungId);
          if (idx !== -1) r.rungs[idx] = updatedRung;
          s.lastError = null;
        });
        return { valid: true };
      },

      addBranchLeg: (routineId, rungId, branchId) => {
        const state = get();
        const routine = findRoutineFromState(state, routineId);
        if (!routine) return { valid: false, reason: "Routine not found" };
        const rung = findRung(routine, rungId);
        if (!rung) return { valid: false, reason: "Rung not found" };

        // branch-add-leg ignores the newNode — it just appends an empty leg
        const dummy = makeInstruction("XIC");
        const updatedRung = applyInsert(
          state.onlineEditActive ? withOnlineEditSnapshot(rung) : rung,
          { kind: "branch-add-leg", rungId, branchId },
          dummy
        );
        set((s) => {
          const r = findRoutine(s.project, routineId);
          if (!r) return;
          pushUndo(s);
          const idx = r.rungs.findIndex((rg) => rg.id === rungId);
          if (idx !== -1) r.rungs[idx] = updatedRung;
          s.lastError = null;
        });
        return { valid: true };
      },

      absorbNext: (routineId, rungId, branchId, legId, direction) => {
        const state = get();
        const routine = findRoutineFromState(state, routineId);
        if (!routine) return { valid: false, reason: "Routine not found" };
        const rung = findRung(routine, rungId);
        if (!rung) return { valid: false, reason: "Rung not found" };

        // Locate which series list contains the branch and at which index
        const loc = locateNodeInRung(rung, branchId);
        if (!loc) return { valid: false, reason: "Branch not found" };

        const targetIdx = direction === "next" ? loc.index + 1 : loc.index - 1;
        if (targetIdx < 0 || targetIdx >= loc.list.length) {
          return { valid: false, reason: `No instruction ${direction === "next" ? "after" : "before"} branch` };
        }

        const nodeToAbsorb = cloneNode(loc.list[targetIdx]);  // plain clone, same id

        // Step 1: remove the neighbour from wherever it sits in the rung
        let updated = applyDelete(
          state.onlineEditActive ? withOnlineEditSnapshot(rung) : rung,
          { kind: "node", rungId, nodeId: nodeToAbsorb.id }
        );

        // Step 2: append (or prepend) it to the target leg
        if (direction === "next") {
          updated = applyInsert(updated, { kind: "branch-leg-append", rungId, branchId, legId }, nodeToAbsorb);
        } else {
          // prepend: insert before first node in the leg, or append if empty
          const branch = findNodeInSeries(updated.nodes, branchId);
          const leg = (branch as any)?.legs?.find((l: any) => l.id === legId);
          if (leg && leg.nodes.length > 0) {
            updated = applyInsert(updated, {
              kind: "branch-leg-before", rungId, branchId, legId,
              siblingId: leg.nodes[0].id,
            }, nodeToAbsorb);
          } else {
            updated = applyInsert(updated, { kind: "branch-leg-append", rungId, branchId, legId }, nodeToAbsorb);
          }
        }

        set((s) => {
          const r = findRoutine(s.project, routineId);
          if (!r) return;
          pushUndo(s);
          const idx = r.rungs.findIndex(rg => rg.id === rungId);
          if (idx !== -1) r.rungs[idx] = updated;
          s.lastError = null;
        });
        return { valid: true };
      },

      ejectFromLeg: (routineId, rungId, branchId, legId, side) => {
        const state = get();
        const routine = findRoutineFromState(state, routineId);
        if (!routine) return { valid: false, reason: "Routine not found" };
        const rung = findRung(routine, rungId);
        if (!rung) return { valid: false, reason: "Rung not found" };

        // Find the branch and the target leg
        const branchNode = findNodeInSeries(rung.nodes, branchId);
        if (!branchNode || branchNode.kind !== "branch") return { valid: false, reason: "Branch not found" };
        const leg = branchNode.legs.find(l => l.id === legId);
        if (!leg || leg.nodes.length === 0) return { valid: false, reason: "Leg is empty" };

        const ejected = cloneNode(
          side === "last" ? leg.nodes[leg.nodes.length - 1] : leg.nodes[0]
        );

        // Step 1: remove the node from the leg
        let updated = applyDelete(
          state.onlineEditActive ? withOnlineEditSnapshot(rung) : rung,
          { kind: "node", rungId, nodeId: ejected.id }
        );

        // Step 2: insert it adjacent to the branch in the parent series
        if (side === "last") {
          updated = applyInsert(updated, { kind: "series-after", rungId, siblingId: branchId }, ejected);
        } else {
          updated = applyInsert(updated, { kind: "series-before", rungId, siblingId: branchId }, ejected);
        }

        set((s) => {
          const r = findRoutine(s.project, routineId);
          if (!r) return;
          pushUndo(s);
          const idx = r.rungs.findIndex(rg => rg.id === rungId);
          if (idx !== -1) r.rungs[idx] = updated;
          s.lastError = null;
        });
        return { valid: true };
      },

      setInstructionParams: (routineId, rungId, nodeId, patch) =>
        set((s) => {
          const routine = findRoutine(s.project, routineId);
          if (!routine) return;
          const rung = findRung(routine, rungId);
          if (!rung) return;
          pushUndo(s);
          if (s.onlineEditActive) markRungOnlineEdit(rung);
          const node = findInstructionNode(rung.nodes, nodeId);
          patchNodeParams(rung.nodes, nodeId, patch);
          if (patch.preset !== undefined && patch.presetTag === "" && node?.tagName) {
            const tag = s.project.tags.find(t => t.name === node.tagName);
            if (tag?.dataType === "TIMER" && tag.timerData) tag.timerData.preset = Math.max(0, patch.preset | 0);
            if (tag?.dataType === "COUNTER" && tag.counterData) tag.counterData.preset = patch.preset | 0;
          }
        }),

      assignTag: (routineId, rungId, nodeId, tagName) => {
        const state = get();
        const routine = findRoutineFromState(state, routineId);
        const rung = routine ? findRung(routine, rungId) ?? null : null;

        if (!rung) {
          const e = { valid: false as const, reason: `Rung '${rungId}' not found` };
          set((s) => { s.lastError = e.reason; });
          return e;
        }

        const result = validateTagAssign(rung, nodeId, tagName);
        if (!result.valid) {
          set((s) => { s.lastError = result.reason; });
          return result;
        }

        set((s) => {
          const routine = findRoutine(s.project, routineId);
          if (!routine) return;
          const rung = findRung(routine, rungId);
          if (!rung) return;
          pushUndo(s);
          if (s.onlineEditActive) markRungOnlineEdit(rung);
          const idx = routine.rungs.findIndex((r) => r.id === rungId);
          if (idx === -1) return;
          // Deep-set tagName on the node
          setNodeTagName(routine.rungs[idx].nodes, nodeId, tagName);
          // Auto-create the tag as BOOL if it doesn't exist yet.
          // Skip auto-create for:
          //  1. Dot-notation refs to TIMER/COUNTER members ("MyTimer.DN")
          //  2. DINT/INT array element or bit refs ("MyArr[2]", "MyArr[2].5", "MyDint.5")
          //     where the base tag already exists as DINT or INT.
          const skipAutoCreate = isStructuredRef(tagName, s.project.tags);
          if (!skipAutoCreate && !s.project.tags.find((t) => t.name === tagName)) {
            s.project.tags.push({
              id: genId("tag"),
              name: tagName,
              dataType: "BOOL",
              value: false,
            });
          }
          s.lastError = null;
        });

        return { valid: true };
      },

      // ── Tags ──────────────────────────────────────────────────────────────

      addTag: (name, dataType, description, size) =>
        set((s) => {
          // Don't allow duplicate names
          if (s.project.tags.find((t) => t.name === name)) return;
          pushUndo(s);
          const isArray = size !== undefined && size > 1;
          const tag: TagDefinition = {
            id: genId("tag"),
            name,
            dataType,
            value: dataType === "BOOL"
              ? false
              : isArray
                ? new Array<number>(size).fill(0)
                : 0,
            description,
            size: isArray ? size : undefined,
          };
          if (dataType === "TIMER") tag.timerData = defaultTimerData();
          if (dataType === "COUNTER") tag.counterData = defaultCounterData();
          s.project.tags.push(tag);
        }),

      deleteTag: (tagId) =>
        set((s) => {
          if (!s.project.tags.find((t) => t.id === tagId)) return;
          pushUndo(s);
          s.project.tags = s.project.tags.filter((t) => t.id !== tagId);
        }),

      setTagValue: (tagName, value) =>
        set((s) => {
          const tag = s.project.tags.find((t) => t.name === tagName);
          if (tag) tag.value = value;
        }),

      setTagElementValue: (tagName, idx, value) =>
        set((s) => {
          const tag = s.project.tags.find((t) => t.name === tagName);
          if (!tag) return;
          if (Array.isArray(tag.value)) {
            (tag.value as number[])[idx] = value | 0;
          } else if (idx === 0) {
            tag.value = value | 0;
          }
        }),

      setTagBit: (tagName, idx, bit, value) =>
        set((s) => {
          const tag = s.project.tags.find((t) => t.name === tagName);
          if (!tag || (tag.dataType !== "DINT" && tag.dataType !== "INT")) return;
          const arr = Array.isArray(tag.value) ? (tag.value as number[]) : null;
          const i = idx ?? 0;
          const word = arr ? (arr[i] ?? 0) : (tag.value as number);
          const b = bit & 31;
          const next = (value ? (word | (1 << b)) : (word & ~(1 << b))) | 0;
          if (arr) {
            arr[i] = next;
          } else {
            tag.value = next;
          }
        }),

      setTagName: (tagId, newName) =>
        set((s) => {
          const tag = s.project.tags.find((t) => t.id === tagId);
          if (tag) {
            pushUndo(s);
            tag.name = newName;
          }
        }),

      setTagDescription: (tagId, description) =>
        set((s) => {
          const tag = s.project.tags.find((t) => t.id === tagId);
          if (tag) {
            pushUndo(s);
            tag.description = description || undefined;
          }
        }),

      clearError: () => set((s) => { s.lastError = null; }),
    };
  })
);

// ---------------------------------------------------------------------------
// Internal helpers (not exported — kept close to store)
// ---------------------------------------------------------------------------

function findRoutine(project: PlcProject, routineId: string): Routine | undefined {
  for (const prog of project.programs) {
    const r = prog.routines.find((r) => r.id === routineId);
    if (r) return r;
  }
  return undefined;
}

function cloneProject(project: PlcProject): PlcProject {
  return JSON.parse(JSON.stringify(project)) as PlcProject;
}

function snapshotProjectState(state: Pick<ProjectState, "project" | "activeRoutineId">): ProjectHistorySnapshot {
  return {
    project: cloneProject(state.project),
    activeRoutineId: state.activeRoutineId,
  };
}

function pushUndo(state: ProjectState): void {
  state.undoStack.push(snapshotProjectState(state));
  if (state.undoStack.length > 100) state.undoStack.shift();
  state.redoStack = [];
}

function findRoutineFromState(
  state: ProjectState,
  routineId: string
): Routine | undefined {
  return findRoutine(state.project, routineId);
}

function findRungInProject(
  project: PlcProject,
  routineId: string,
  rungId: string
): Rung | undefined {
  const routine = findRoutine(project, routineId);
  if (!routine) return undefined;
  return findRung(routine, rungId);
}

function findInstructionNode(
  nodes: SeriesNode[],
  nodeId: string
): InstructionNode | undefined {
  for (const node of nodes) {
    if (node.kind === "instruction" && node.id === nodeId) return node;
    if (node.kind === "branch") {
      for (const leg of node.legs) {
        const found = findInstructionNode(leg.nodes, nodeId);
        if (found) return found;
      }
    }
  }
  return undefined;
}

function cloneSeriesNodes(nodes: SeriesNode[]): SeriesNode[] {
  return JSON.parse(JSON.stringify(nodes)) as SeriesNode[];
}

function snapshotRung(rung: Rung): NonNullable<Rung["onlineEditOriginal"]> {
  return {
    comment: rung.comment,
    nodes: cloneSeriesNodes(rung.nodes),
    disabled: rung.disabled,
  };
}

function markRungOnlineEdit(rung: Rung, status: Rung["onlineEditStatus"] = "pending"): void {
  if (!rung.onlineEditStatus) {
    rung.onlineEditOriginal = snapshotRung(rung);
  }
  rung.onlineEditStatus = status;
}

function withOnlineEditSnapshot(rung: Rung): Rung {
  if (rung.onlineEditStatus) return rung;
  return {
    ...rung,
    onlineEditStatus: "pending",
    onlineEditOriginal: snapshotRung(rung),
  };
}

function withExistingOnlineEdit(updated: Rung, live?: Rung): Rung {
  if (updated.onlineEditStatus) return updated;
  if (live?.onlineEditStatus) {
    return {
      ...updated,
      onlineEditStatus: live.onlineEditStatus,
      onlineEditOriginal: live.onlineEditOriginal,
    };
  }
  return withOnlineEditSnapshot(updated);
}

function patchNodeParams(
  nodes: SeriesNode[],
  nodeId: string,
  patch: Partial<TimerParams & CounterParams & CompareParams & MoveParams & CopyParams & BitShiftParams & MathParams & JsrParams>
): boolean {
  for (const node of nodes) {
    if (node.kind === "instruction" && node.id === nodeId) {
      node.params = { ...node.params, ...patch } as InstructionParams;
      // Explicitly clear presetTag when set to empty string
      if (patch.presetTag === "") delete (node.params as any).presetTag;
      return true;
    }
    if (node.kind === "branch") {
      for (const leg of node.legs) {
        if (patchNodeParams(leg.nodes, nodeId, patch)) return true;
      }
    }
  }
  return false;
}

/**
 * Returns true if `tagName` is a structured reference whose base tag already
 * exists — meaning no separate auto-created tag is needed.
 * Covers: "Base.member" (TIMER/COUNTER), "Base.bitN" (DINT/INT),
 *         "Base[n]" (DINT/INT array element), "Base[n].bitN".
 */
function isStructuredRef(tagName: string, tags: TagDefinition[]): boolean {
  const arrayBitRe = /^([A-Za-z_]\w*)\[(\d+)\]\.(\w+)$/;
  const arrayRe    = /^([A-Za-z_]\w*)\[(\d+)\]$/;
  const dotRe      = /^([A-Za-z_]\w*)\.(\w+)$/;

  let base: string | undefined;
  let hasIndex = false;

  let m: RegExpMatchArray | null;
  if ((m = tagName.match(arrayBitRe))) { base = m[1]; hasIndex = true; }
  else if ((m = tagName.match(arrayRe))) { base = m[1]; hasIndex = true; }
  else if ((m = tagName.match(dotRe))) { base = m[1]; }

  if (!base) return false;

  const baseTag = tags.find(t => t.name === base);
  if (!baseTag) return false;

  // TIMER/COUNTER named member refs
  if (baseTag.dataType === "TIMER" || baseTag.dataType === "COUNTER") return true;

  // DINT/INT bit or array refs
  if (baseTag.dataType === "DINT" || baseTag.dataType === "INT") return true;

  return false;
}

function setNodeTagName(
  nodes: SeriesNode[],
  nodeId: string,
  tagName: string
): boolean {
  for (const node of nodes) {
    if (node.kind === "instruction" && node.id === nodeId) {
      node.tagName = tagName;
      return true;
    }
    if (node.kind === "branch") {
      for (const leg of node.legs) {
        if (setNodeTagName(leg.nodes, nodeId, tagName)) return true;
      }
    }
  }
  return false;
}
