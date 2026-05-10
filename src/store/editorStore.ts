// =============================================================================
// Editor Store — selection, hover, drag state, active tool
// =============================================================================
// Purely UI state — no ladder logic lives here.
// =============================================================================

import { create } from "zustand";
import type { InstructionType, InsertPosition } from "../model/types";

export type SelectionTarget =
  | { kind: "node";   rungId: string; nodeId: string }
  | { kind: "rung";   rungId: string }
  | { kind: "leg";    rungId: string; branchId: string; legId: string }
  | null;

export type HoverTarget =
  | { kind: "node"; nodeId: string }
  | { kind: "dropzone"; position: InsertPosition; valid: boolean }
  | null;

export interface DragState {
  active: boolean;
  /** The instruction type being dragged from the palette */
  instructionType: InstructionType | null;
  /** Current hover dropzone during drag */
  hoverPosition: InsertPosition | null;
  /** Whether the current hover position is valid */
  hoverValid: boolean;
}

export interface EditorState {
  selection: SelectionTarget;
  hover: HoverTarget;
  drag: DragState;
  /** Which routine is being shown in the tree (may differ from active routine) */
  expandedRoutineIds: Set<string>;
  /** Whether instruction comments are shown on the canvas */
  showNodeComments: boolean;
  /** Whether rung comments are shown on the canvas */
  showRungComments: boolean;

  setSelection: (target: SelectionTarget) => void;
  clearSelection: () => void;
  setHover: (target: HoverTarget) => void;

  startDrag: (type: InstructionType) => void;
  updateDragHover: (position: InsertPosition | null, valid: boolean) => void;
  endDrag: () => void;

  toggleRoutineExpanded: (id: string) => void;
  toggleNodeComments: () => void;
  toggleRungComments: () => void;
}

export const useEditorStore = create<EditorState>()((set) => ({
  selection: null,
  hover: null,
  drag: {
    active: false,
    instructionType: null,
    hoverPosition: null,
    hoverValid: false,
  },
  expandedRoutineIds: new Set(),
  showNodeComments: true,
  showRungComments: true,

  setSelection: (target) => set({ selection: target }),
  clearSelection: () => set({ selection: null }),

  setHover: (target) => set({ hover: target }),

  startDrag: (type) =>
    set({
      drag: {
        active: true,
        instructionType: type,
        hoverPosition: null,
        hoverValid: false,
      },
    }),

  updateDragHover: (position, valid) =>
    set((s) => ({
      drag: { ...s.drag, hoverPosition: position, hoverValid: valid },
    })),

  endDrag: () =>
    set({
      drag: {
        active: false,
        instructionType: null,
        hoverPosition: null,
        hoverValid: false,
      },
    }),

  toggleRoutineExpanded: (id) =>
    set((s) => {
      const next = new Set(s.expandedRoutineIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { expandedRoutineIds: next };
    }),

  toggleNodeComments: () => set((s) => ({ showNodeComments: !s.showNodeComments })),
  toggleRungComments: () => set((s) => ({ showRungComments: !s.showRungComments })),
}));
