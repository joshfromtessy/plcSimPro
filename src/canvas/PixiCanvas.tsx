// =============================================================================
// PixiCanvas â€” React component that owns the Pixi Application
// =============================================================================

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Application } from "pixi.js";
import { useProjectStore } from "../store/projectStore";
import { useSimulationStore } from "../store/simulationStore";
import { useEditorStore } from "../store/editorStore";
import { clearDraggedTagPayload, getDraggedTagPayload, type DraggedTagPayload } from "../store/dragPayload";
import { LadderRenderer } from "./renderer";
import type { InstructionType, InsertPosition, Rung, TagDataType, TimerParams, CounterParams, CompareParams, MoveParams, CopyParams, BitShiftParams, MathParams, JsrParams } from "../model/types";
import {
  findContainingBranch, isBranch,
  applyInsert, applyDelete,
  locateNodeInRung, cloneNode, findNodeInSeries,
} from "../model/ast";
import "./PixiCanvas.css";

type TagEditorState = {
  rungId: string;
  nodeId: string;
  x: number;
  y: number;
};

type AsciiEditorState = {
  rungId: string;
  x: number;
  y: number;
};

type TagDropPreview = {
  rowIndex: number;
  rowCount: number;
  label: string;
  valid: boolean;
};

interface PixiCanvasProps {
  theme: "dark" | "light";
}

export function PixiCanvas({ theme }: PixiCanvasProps) {
  const canvasRef   = useRef<HTMLDivElement>(null);
  const outerRef    = useRef<HTMLDivElement>(null);
  const appRef      = useRef<Application | null>(null);
  const rendererRef = useRef<LadderRenderer | null>(null);
  const rafRef      = useRef<number>(0);

  // Always-current render callback â€” never closes over stale state
  const renderRef = useRef<() => void>(() => {});

  const {
    project, activeRoutineId,
    insertInstruction, addRung, moveNode, moveRung,
    wrapNodeInBranch, addBranchLeg,
    absorbNext, ejectFromLeg,
    assignTag, setInstructionParams,
    setNodeComment, setRungComment,
    beginOnlineEditRung, replaceRungWithAscii,
  } = useProjectStore();
  const { scanResult, mode } = useSimulationStore();
  const { selection, drag, showNodeComments, showRungComments, toggleNodeComments, toggleRungComments } = useEditorStore();
  const [tagEditor, setTagEditor] = useState<TagEditorState | null>(null);
  const [complexEditor, setComplexEditor] = useState<TagEditorState | null>(null);
  const [compareMovEditor, setCompareMovEditor] = useState<TagEditorState | null>(null);
  const [rungCommentEditor, setRungCommentEditor] = useState<TagEditorState | null>(null);
  const [asciiEditor, setAsciiEditor] = useState<AsciiEditorState | null>(null);

  // Stores the current drag-over drop position â€” use a ref to avoid re-renders
  const dropTargetRef  = useRef<InsertPosition | null>(null);
  const copiedNodeRef  = useRef<{ routineId: string; rungId: string; nodeId: string } | null>(null);
  // Stores the node being dragged from the canvas (null = dragging from palette)
  const dragNodeRef    = useRef<{ rungId: string; nodeId: string } | null>(null);
  // Stores the rung being dragged for reordering
  const rungDragRef    = useRef<{ rungId: string } | null>(null);
  // Stores the branch rail being dragged to extend/shrink the branch span
  const railDragRef    = useRef<{ rungId: string; branchId: string; side: "left" | "right" } | null>(null);
  // Pointer-capture state for live rail drag
  const pointerRailRef = useRef<{
    rungId: string;
    branchId: string;
    leg0Id: string;
    side: "left" | "right";
    pointerId: number;
    initialRailAbsX: number;
    adjacentMids: number[];
    legMids: number[];
  } | null>(null);
  // Preview rungs substituted into the renderer during pointer rail drag
  const previewRungRef = useRef<Map<string, Rung>>(new Map());
  // Commit function built in onMove and called in onUp â€” encodes N absorbs/ejects
  const pendingCommitRef = useRef<(() => void) | null>(null);

  const routine = activeRoutineId
    ? project.programs.flatMap(p => p.routines).find(r => r.id === activeRoutineId)
    : null;
  const canvasBackground = theme === "light" ? "#f3f4f8" : "#18181e";

  // Build a tag-value map for XIO/XIC colouring (updated every render)
  const tagValues = new Map<string, boolean>(
    project.tags.map(t => [t.name, Boolean(t.value)])
  );

  renderRef.current = () => {
    const lr  = rendererRef.current;
    const app = appRef.current;
    if (!lr || !app || !routine) return;
    syncPixiBackground(app, theme);
    lr.setThemeColors(getRendererColors(theme));
    lr.setTagData(project.tags);
    const w = canvasRef.current?.clientWidth ?? app.renderer.width;
    const viewportH = canvasRef.current?.clientHeight ?? app.renderer.height;
    if (w === 0) return;
    const selectedNodeId = selection?.kind === "node" ? selection.nodeId : null;
    const selectedRungId = selection?.kind === "rung" ? selection.rungId : null;
    lr.setSelection(selectedNodeId, selectedRungId);
    lr.setCommentVisibility(showNodeComments, showRungComments);

    // During a pointer rail drag, substitute the preview rung so the canvas
    // shows the branch live-resizing in real time (no store mutation yet).
    const preview = previewRungRef.current;
    const rungs = preview.size > 0
      ? routine.rungs.map(r => preview.get(r.id) ?? r)
      : routine.rungs;

    const { h: contentH, w: contentW } = lr.render(rungs, scanResult, w, tagValues, viewportH);
    if (contentH > 0) {
      const newW = Math.max(w, contentW);
      const newH = Math.max(contentH, viewportH);
      app.renderer.resize(newW, newH);
      // If content is wider than container, fix the pixel width; otherwise stay fluid
      app.canvas.style.width = newW > w ? `${newW}px` : "100%";
      app.canvas.style.height = `${newH}px`;
      app.canvas.style.backgroundColor = canvasBackground;
      app.canvas.style.visibility = rungs.length === 0 ? "hidden" : "visible";
    }

    // Teal tint + branch highlight on the rung being live-previewed
    if (pointerRailRef.current) {
      const { rungId, branchId, side } = pointerRailRef.current;
      lr.showPreviewTint(rungId);
      lr.showBranchDragActive(rungId, branchId, side);
    } else {
      lr.clearPreviewTint();
    }
  };

  // â”€â”€ Mount Pixi once â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  useEffect(() => {
    const container = canvasRef.current;
    if (!container) return;

    const app = new Application();
    app.init({
      background: getCanvasBackground(theme).hex,
      backgroundAlpha: 0,
      antialias: true,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
      width:  container.clientWidth  || 800,
      height: container.clientHeight || 600,
    }).then(() => {
      container.appendChild(app.canvas);
      app.canvas.style.display = "block";
      app.canvas.style.position = "absolute";
      app.canvas.style.top = "0";
      app.canvas.style.left = "0";
      app.canvas.style.width   = "100%";

      const lr = new LadderRenderer(app);

      lr.onNodeClick = (rungId, nodeId, legId) => {
        if (legId) {
          useEditorStore.getState().setSelection({ kind: "leg", rungId, branchId: nodeId, legId });
        } else {
          useEditorStore.getState().setSelection({ kind: "node", rungId, nodeId });
        }
      };
      lr.onRungClick = (rungId) => {
        useEditorStore.getState().setSelection({ kind: "rung", rungId });
      };

      lr.onRungDelete = (rungId) => {
        const { activeRoutineId, deleteRung } = useProjectStore.getState();
        if (activeRoutineId && confirmDeleteRung()) {
          deleteRung(activeRoutineId, rungId);
          useEditorStore.getState().clearSelection();
        }
      };

      appRef.current    = app;
      rendererRef.current = lr;
      renderRef.current();
    });

    const ro = new ResizeObserver(() => {
      const c = canvasRef.current;
      if (!appRef.current || !c || c.clientWidth === 0) return;
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => renderRef.current());
    });
    ro.observe(container);

    return () => {
      ro.disconnect();
      cancelAnimationFrame(rafRef.current);
      rendererRef.current?.destroy();
      appRef.current?.destroy(true);
      appRef.current    = null;
      rendererRef.current = null;
    };
  }, []);

  // Re-render on any state change
  useEffect(() => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => renderRef.current());
  }, [routine?.rungs, scanResult, selection, tagValues.size, showNodeComments, showRungComments]);

  useEffect(() => {
    const container = canvasRef.current;
    if (!container) return;
    container.scrollTop = 0;
    container.scrollLeft = 0;
  }, [activeRoutineId]);

  useEffect(() => {
    if (routine?.rungs.length === 1) {
      canvasRef.current?.scrollTo({ top: 0, left: 0 });
    }
  }, [routine?.rungs.length]);

  // Theme changes arrive through CSS variables on the parent app root.
  useLayoutEffect(() => {
    syncPixiBackground(appRef.current, theme);
    cancelAnimationFrame(rafRef.current);
    renderRef.current();
  }, [theme]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const isSpace = e.key === " " || e.key === "Spacebar" || e.code === "Space";
      const active = document.activeElement;
      if (
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        active instanceof HTMLSelectElement ||
        active?.hasAttribute("contenteditable")
      ) {
        return;
      }

      if (e.key === "Escape") {
        setTagEditor(null);
        setCompareMovEditor(null);
        useEditorStore.getState().clearSelection();
        return;
      }

      const { selection, clearSelection } = useEditorStore.getState();
      const { activeRoutineId, project, deleteNode, deleteRung, setTagValue, copyNode, undo, redo } = useProjectStore.getState();
      if (!activeRoutineId) return;

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        redo();
        return;
      }

      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) {
        e.preventDefault();
        const direction = e.key.replace("Arrow", "").toLowerCase() as "left" | "right" | "up" | "down";
        const target = rendererRef.current?.getKeyboardNavigationTarget(
          selection?.kind === "node" || selection?.kind === "rung" ? selection : null,
          direction
        );
        if (target) useEditorStore.getState().setSelection(target);
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c") {
        if (selection?.kind !== "node") return;
        e.preventDefault();
        copiedNodeRef.current = { routineId: activeRoutineId, rungId: selection.rungId, nodeId: selection.nodeId };
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") {
        const copied = copiedNodeRef.current;
        if (!copied) return;
        e.preventDefault();
        const routine = project.programs.flatMap(p => p.routines).find(r => r.id === activeRoutineId);
        if (!routine) return;

        let position: InsertPosition;
        if (selection?.kind === "node") {
          position = { kind: "series-after", rungId: selection.rungId, siblingId: selection.nodeId };
        } else if (selection?.kind === "leg") {
          position = {
            kind: "branch-leg-append",
            rungId: selection.rungId,
            branchId: selection.branchId,
            legId: selection.legId,
          };
        } else if (selection?.kind === "rung") {
          position = { kind: "series-append", rungId: selection.rungId };
        } else {
          position = routine.rungs.length > 0
            ? { kind: "series-append", rungId: routine.rungs[routine.rungs.length - 1].id }
            : { kind: "rung-append" };
        }

        const simMode = useSimulationStore.getState().mode;
        if (simMode === "running") {
          if (position.kind === "rung-append") {
            useProjectStore.setState({ lastError: "Double-click a rung gutter to start online edit before pasting in Run." });
            return;
          }
          const targetRung = routine.rungs.find(r => r.id === position.rungId);
          if (!targetRung?.onlineEditStatus || targetRung.onlineEditStatus === "pending-delete") {
            useProjectStore.setState({ lastError: "Double-click the rung gutter to start online edit before pasting in Run." });
            return;
          }
        }

        copyNode(activeRoutineId, copied.rungId, copied.nodeId, position);
        return;
      }

      if (!selection) return;

      if (isSpace) {
        if (selection.kind !== "node") return;
        const routine = project.programs
          .flatMap(p => p.routines)
          .find(r => r.id === activeRoutineId);
        const rung = routine?.rungs.find(r => r.id === selection.rungId);
        const node = rung ? findNodeById(rung.nodes, selection.nodeId) : null;
        const tag = node?.kind === "instruction"
          ? project.tags.find(t => t.name === node.tagName)
          : null;
        if (tag?.dataType !== "BOOL") return;

        e.preventDefault();
        setTagValue(tag.name, !(tag.value as boolean));
        return;
      }

      if (e.key !== "Delete") return;

      if (selection.kind === "node") {
        deleteNode(activeRoutineId, {
          kind: "node",
          rungId: selection.rungId,
          nodeId: selection.nodeId,
        });
        clearSelection();
      } else if (selection.kind === "leg") {
        deleteNode(activeRoutineId, {
          kind: "leg",
          rungId: selection.rungId,
          branchId: selection.branchId,
          legId: selection.legId,
        });
        clearSelection();
      } else if (selection.kind === "rung") {
        if (confirmDeleteRung()) {
          deleteRung(activeRoutineId, selection.rungId);
          clearSelection();
        }
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  // â”€â”€ Event handlers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  function getCanvasCoords(e: { clientX: number; clientY: number }) {
    const wrap = canvasRef.current;
    if (!wrap) return null;
    const rect = wrap.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top + wrap.scrollTop,
    };
  }

  function handlePointerDown(e: React.PointerEvent) {
    const lr = rendererRef.current;
    const wrap = canvasRef.current;
    if (!lr || !wrap) return;
    const active = document.activeElement;
    if (
      active instanceof HTMLInputElement ||
      active instanceof HTMLTextAreaElement ||
      active instanceof HTMLSelectElement ||
      active?.hasAttribute("contenteditable")
    ) {
      if (active instanceof HTMLElement) active.blur();
    }
    const coords = getCanvasCoords(e);
    if (!coords) return;
    const hit = lr.hitTestNode(coords.x, coords.y);

    railDragRef.current = null;
    dragNodeRef.current = null;
    rungDragRef.current = null;
    pointerRailRef.current = null;

    if (e.detail >= 2) {
      const editRungId = lr.hitTestOnlineEditGutter(coords.x, coords.y);
      if (editRungId && routine) {
        e.preventDefault();
        wrap.draggable = false;
        beginOnlineEditRung(routine.id, editRungId);
        useEditorStore.getState().setSelection({ kind: "rung", rungId: editRungId });
        setTagEditor(null);
        setComplexEditor(null);
        setCompareMovEditor(null);
        setRungCommentEditor(null);
        return;
      }
    }

    if (hit?.rail) {
      // â”€â”€ Pointer-capture rail drag â€” gives us live pointermove at full rate â”€â”€
      e.preventDefault(); // blocks the HTML5 drag chain for rails
      const branchLayout = lr.getBranchLayout(hit.rungId, hit.nodeId);
      const initialRailAbsX = branchLayout
        ? lr.RUNG_NUMBER_W + (hit.rail === "right" ? branchLayout.rightRailX : branchLayout.leftRailX)
        : coords.x;

      // Resolve leg0 from the current store (not a stale closure)
      const { project, activeRoutineId: routineId } = useProjectStore.getState();
      const currentRung = routineId
        ? project.programs.flatMap(p => p.routines)
            .find(r => r.id === routineId)
            ?.rungs.find(r => r.id === hit.rungId)
        : null;
      const branchNode = currentRung ? findNodeById(currentRung.nodes, hit.nodeId) : null;
      const leg0Id = branchNode?.kind === "branch" ? branchNode.legs[0]?.id : null;

      if (leg0Id) {
        const adjacentMids = lr.getAdjacentSeriesXMids(hit.rungId, hit.nodeId, hit.rail);
        const legMids = lr.getLegNodeXMids(hit.rungId, hit.nodeId, leg0Id, hit.rail);

        wrap.setPointerCapture(e.pointerId);
        rendererRef.current?.clearRailHover();
        rendererRef.current?.clearLegHover();
        const railState = {
          rungId: hit.rungId,
          branchId: hit.nodeId,
          leg0Id,
          side: hit.rail as "left" | "right",
          pointerId: e.pointerId,
          initialRailAbsX,
          adjacentMids,
          legMids,
        };
        pointerRailRef.current = railState;

        // â”€â”€ Native listeners so pointer capture reliably fires â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        const onMove = (ev: PointerEvent) => {
          if (ev.pointerId !== railState.pointerId) return;
          const { project: p, activeRoutineId: rid } = useProjectStore.getState();
          const liveRung = rid
            ? p.programs.flatMap(prog => prog.routines)
                .find(r => r.id === rid)
                ?.rungs.find(r => r.id === railState.rungId)
            : null;
          if (!liveRung) return;

          const rect   = wrap.getBoundingClientRect();
          const cx     = ev.clientX - rect.left;
          const delta  = cx - railState.initialRailAbsX;

          // Dead zone â€” plain click never commits
          if (Math.abs(delta) < 6) {
            previewRungRef.current.delete(railState.rungId);
            pendingCommitRef.current = null;
            cancelAnimationFrame(rafRef.current);
            rafRef.current = requestAnimationFrame(() => renderRef.current());
            return;
          }

          const outward  = railState.side === "right" ? delta > 0 : delta < 0;
          const direction = railState.side === "right" ? "next" as const : "prev" as const;
          const ejectSide = railState.side === "right" ? "last" as const : "first" as const;

          let previewRung: Rung | null = null;
          let commitFn: (() => void) | null = null;

          if (outward) {
            // Count how many adjacent series nodes the cursor has passed
            let count = 0;
            for (const mid of railState.adjacentMids) {
              if (railState.side === "right" ? cx > mid : cx < mid) count++;
              else break;
            }
            if (count > 0) {
              let r: Rung | null = liveRung;
              for (let i = 0; i < count && r; i++) {
                r = computeAbsorbPreview(r, railState.branchId, railState.leg0Id, direction);
              }
              if (r) {
                previewRung = r;
                const n = count;
                commitFn = () => {
                  const { absorbNext: doAbsorb, activeRoutineId: r2 } = useProjectStore.getState();
                  if (r2) {
                    for (let i = 0; i < n; i++) {
                      doAbsorb(r2, railState.rungId, railState.branchId, railState.leg0Id, direction);
                    }
                  }
                };
              }
            }
          } else {
            // Count how many leg nodes the cursor has passed inward from the rail edge
            let count = 0;
            for (const mid of railState.legMids) {
              if (railState.side === "right" ? cx < mid : cx > mid) count++;
              else break;
            }
            if (count > 0) {
              let r: Rung | null = liveRung;
              for (let i = 0; i < count && r; i++) {
                r = computeEjectPreview(r, railState.branchId, railState.leg0Id, ejectSide);
              }
              if (r) {
                previewRung = r;
                const n = count;
                commitFn = () => {
                  const { ejectFromLeg: doEject, activeRoutineId: r2 } = useProjectStore.getState();
                  if (r2) {
                    for (let i = 0; i < n; i++) {
                      doEject(r2, railState.rungId, railState.branchId, railState.leg0Id, ejectSide);
                    }
                  }
                };
              }
            }
          }

          if (previewRung) {
            previewRungRef.current.set(railState.rungId, previewRung);
            pendingCommitRef.current = commitFn;
          } else {
            previewRungRef.current.delete(railState.rungId);
            pendingCommitRef.current = null;
          }

          cancelAnimationFrame(rafRef.current);
          rafRef.current = requestAnimationFrame(() => renderRef.current());
        };

        const onUp = (ev: PointerEvent) => {
          if (ev.pointerId !== railState.pointerId) return;
          wrap.removeEventListener("pointermove", onMove);
          wrap.removeEventListener("pointerup", onUp);
          wrap.removeEventListener("pointercancel", onUp);

          // Commit exactly what was previewed (N absorbs or ejects)
          pendingCommitRef.current?.();
          pendingCommitRef.current = null;

          // Clear preview state
          previewRungRef.current.clear();
          pointerRailRef.current = null;
          rendererRef.current?.clearPreviewTint();
          rendererRef.current?.clearExtendTarget();
          rendererRef.current?.clearLegHover();
          cancelAnimationFrame(rafRef.current);
          rafRef.current = requestAnimationFrame(() => renderRef.current());
        };

        wrap.addEventListener("pointermove", onMove);
        wrap.addEventListener("pointerup", onUp);
        wrap.addEventListener("pointercancel", onUp);
      }
      wrap.draggable = false;
    } else if (hit) {
      // Regular node → HTML5 drag for reordering (unchanged behaviour)
      dragNodeRef.current = { rungId: hit.rungId, nodeId: hit.nodeId };
      wrap.draggable = true;
    } else {
      // Check if the pointer is in the gutter — start a rung reorder drag.
      // Exclude the × delete icon zone so a delete click never triggers a drag.
      if (coords.x < lr.RUNG_NUMBER_W) {
        const gutterRungId = lr.hitTestGutter(coords.x, coords.y);
        if (gutterRungId) {
          rungDragRef.current = { rungId: gutterRungId };
          wrap.draggable = true;
        } else {
          wrap.draggable = false;
        }
      } else {
        wrap.draggable = false;
      }
    }
  }

  /** Update cursor + hover highlights when moving over rails or legs */
  function handlePointerMove(e: React.PointerEvent) {
    if (pointerRailRef.current) return; // native listeners handle the active drag
    const lr = rendererRef.current;
    const wrap = canvasRef.current;
    if (!lr || !wrap) return;
    const coords = getCanvasCoords(e);
    if (!coords) return;

    const hit = lr.hitTestNode(coords.x, coords.y);
    if (hit?.rail) {
      // Branch rail â€” show drag affordance, clear everything else
      wrap.style.cursor = "ew-resize";
      lr.clearLegHover();
      lr.showRailHover(hit.rungId, hit.nodeId, hit.rail);
    } else {
      wrap.style.cursor = "";
      lr.clearRailHover();
      if (hit) {
        // Regular instruction (or branch body) hover â€” subtle tint
        lr.showInstructionHover(hit.rungId, hit.nodeId);
      } else {
        // May be inside a branch leg interior
        const legHit = lr.hitTestLeg(coords.x, coords.y);
        if (legHit) {
          lr.showLegHover(legHit.rungId, legHit.branchId, legHit.legId);
        } else {
          lr.clearLegHover();
        }
      }
    }
  }

  function handlePointerLeave() {
    rendererRef.current?.clearLegHover();
    rendererRef.current?.clearRailHover();
  }

  function handleDragStart(e: React.DragEvent) {
    if ((e.target as HTMLElement | null)?.closest(".tag-quick-edit")) {
      return;
    }

    // Rung reorder drag — initiated from the gutter number column
    const rungDrag = rungDragRef.current;
    if (rungDrag) {
      e.dataTransfer.setData("application/plc-rung-move", rungDrag.rungId);
      e.dataTransfer.effectAllowed = "move";
      const ghost = document.createElement("div");
      ghost.textContent = "⠿ RUNG";
      ghost.style.cssText = [
        "position:fixed", "top:-200px", "left:-200px",
        "background:#1a2a3a", "color:#f0a030",
        "padding:3px 10px", "border-radius:3px",
        "font:bold 11px/1.6 Consolas,monospace",
        "border:1px solid #f0a030", "letter-spacing:1px",
        "pointer-events:none",
      ].join(";");
      document.body.appendChild(ghost);
      e.dataTransfer.setDragImage(ghost, ghost.offsetWidth / 2, 12);
      requestAnimationFrame(() => { if (document.body.contains(ghost)) document.body.removeChild(ghost); });
      return;
    }

    // Rail-extend drag: dragging a branch rail to absorb adjacent instructions
    const rail = railDragRef.current;
    if (rail) {
      e.dataTransfer.setData("application/plc-rail-extend", JSON.stringify(rail));
      e.dataTransfer.effectAllowed = "move";
      const label = rail.side === "right" ? "EXTEND â†’" : "â† EXTEND";
      const ghost = document.createElement("div");
      ghost.textContent = label;
      ghost.style.cssText = [
        "position:fixed", "top:-200px", "left:-200px",
        "background:#0d2a22", "color:#00d4aa",
        "padding:3px 10px", "border-radius:3px",
        "font:bold 11px/1.6 Consolas,monospace",
        "border:1px solid #00d4aa", "letter-spacing:1px",
        "pointer-events:none",
      ].join(";");
      document.body.appendChild(ghost);
      e.dataTransfer.setDragImage(ghost, ghost.offsetWidth / 2, 12);
      requestAnimationFrame(() => { if (document.body.contains(ghost)) document.body.removeChild(ghost); });
      return;
    }

    const pending = dragNodeRef.current;
    if (!pending) { e.preventDefault(); return; }
    setTagEditor(null);
    setComplexEditor(null);
    setCompareMovEditor(null);
    setRungCommentEditor(null);
    e.dataTransfer.setData("application/plc-move", JSON.stringify(pending));
    e.dataTransfer.effectAllowed = "move";

    // Replace the default "screenshot of the whole div" ghost with a small
    // pill showing the instruction mnemonic.  The ghost must be in the DOM
    // when setDragImage() is called, so we append it, call the API, then
    // remove it on the next tick.
    const rung = routine?.rungs.find(r => r.id === pending.rungId);
    const hitNode = findNodeById(rung?.nodes ?? [], pending.nodeId);
    const instrType = hitNode?.type ?? (hitNode?.kind === "branch" ? "BRANCH" : "INST");

    const ghost = document.createElement("div");
    ghost.textContent = instrType;
    ghost.style.cssText = [
      "position:fixed",
      "top:-200px",
      "left:-200px",
      "background:#1a2a4a",
      "color:#4a8cff",
      "padding:3px 10px",
      "border-radius:3px",
      "font:bold 11px/1.6 Consolas,monospace",
      "border:1px solid #4a8cff",
      "letter-spacing:1px",
      "pointer-events:none",
    ].join(";");
    document.body.appendChild(ghost);
    e.dataTransfer.setDragImage(ghost, ghost.offsetWidth / 2, 12);
    requestAnimationFrame(() => {
      if (document.body.contains(ghost)) document.body.removeChild(ghost);
    });
  }

  function handleDragEnd() {
    dragNodeRef.current = null;
    railDragRef.current = null;
    rungDragRef.current = null;
    if (canvasRef.current) canvasRef.current.draggable = false;
    rendererRef.current?.clearDropZone();
    rendererRef.current?.clearDropAnchors();
    rendererRef.current?.clearExtendTarget();
    rendererRef.current?.clearLegHover();
    rendererRef.current?.clearRungDropLine();
    clearDraggedTagPayload();
  }

  function getDropInfo(e: React.DragEvent, dragType?: InstructionType) {
    const wrap = canvasRef.current;
    const lr   = rendererRef.current;
    if (!wrap || !lr) return null;
    const rect = wrap.getBoundingClientRect();
    const canvasX = e.clientX - rect.left;
    const canvasY = e.clientY - rect.top + wrap.scrollTop;
    return lr.queryDropTarget(canvasX, canvasY, dragType);
  }

  function rungAllowsRunEdit(rungId: string): boolean {
    if (mode !== "running") return true;
    const rung = routine?.rungs.find(r => r.id === rungId);
    return !!rung?.onlineEditStatus && rung.onlineEditStatus !== "pending-delete";
  }

  function positionAllowsRunEdit(position: InsertPosition): boolean {
    if (mode !== "running") return true;
    if (position.kind === "rung-append") return false;
    return rungAllowsRunEdit(position.rungId);
  }

  function blockRunEdit(message = "Double-click the rung gutter to start online edit before changing logic in Run."): void {
    useProjectStore.setState({ lastError: message });
  }

  function handleDragOver(e: React.DragEvent) {
    const isRungMove    = e.dataTransfer.types.includes("application/plc-rung-move");
    const isNodeMove    = e.dataTransfer.types.includes("application/plc-move");
    const isRailExtend  = e.dataTransfer.types.includes("application/plc-rail-extend");
    const isBranchWrap  = e.dataTransfer.types.includes("application/plc-branch-wrap");
    const isAddLeg      = e.dataTransfer.types.includes("application/plc-add-leg");
    const isTagDrop     = e.dataTransfer.types.includes("application/plc-tag");
    const isInstruction = drag.active || e.dataTransfer.types.includes("application/plc-instruction");
    if (!isRungMove && !isNodeMove && !isRailExtend && !isBranchWrap && !isAddLeg && !isTagDrop && !isInstruction) {
      return;
    }

    e.preventDefault();
    e.dataTransfer.dropEffect = (isRungMove || isNodeMove || isRailExtend) ? "move" : "copy";

    if (isTagDrop) {
      const coords = getCanvasCoords(e);
      const hit = coords ? rendererRef.current?.hitTestNode(coords.x, coords.y) : null;
      const tag = readDraggedTag(e);
      const rung = hit && routine ? routine.rungs.find(r => r.id === hit.rungId) : null;
      const node = hit && rung ? findNodeById(rung.nodes, hit.nodeId) : null;
      if (coords && hit && tag && node?.kind === "instruction") {
        const preview = getTagDropPreview(tag, hit.rungId, node, coords.y);
        if (preview.rowCount === 1 && preview.label === "Tag") {
          rendererRef.current?.showInstructionTagHover(hit.rungId, hit.nodeId, preview.valid);
        } else {
          rendererRef.current?.showInstructionFieldHover(
            hit.rungId,
            hit.nodeId,
            preview.rowIndex,
            preview.rowCount,
            preview.valid,
            preview.label
          );
        }
      } else {
        rendererRef.current?.clearLegHover();
      }
      rendererRef.current?.clearDropZone();
      rendererRef.current?.clearDropAnchors();
      rendererRef.current?.clearExtendTarget();
      return;
    }

    // ── Rung reorder ─────────────────────────────────────────────────────────
    if (isRungMove) {
      if (mode === "running") {
        e.dataTransfer.dropEffect = "none";
        rendererRef.current?.clearRungDropLine();
        return;
      }
      const coords = getCanvasCoords(e);
      if (coords) {
        const drop = rendererRef.current?.queryRungDropY(coords.y);
        if (drop) rendererRef.current?.showRungDropLine(drop.lineY);
      }
      rendererRef.current?.clearDropZone();
      rendererRef.current?.clearDropAnchors();
      rendererRef.current?.clearExtendTarget();
      return;
    }

    if (isRailExtend && railDragRef.current) {
      const { rungId, branchId, side } = railDragRef.current;
      if (!rungAllowsRunEdit(rungId)) {
        e.dataTransfer.dropEffect = "none";
        rendererRef.current?.clearExtendTarget();
        return;
      }
      const rung = routine?.rungs.find(r => r.id === rungId);
      const coords = getCanvasCoords(e);
      const lr = rendererRef.current;

      // Determine absorb vs eject by comparing cursor X to the rail position
      const branchLayout = lr?.getBranchLayout(rungId, branchId);
      const railAbsX = branchLayout
        ? (lr!.RUNG_NUMBER_W + (side === "right" ? branchLayout.rightRailX : branchLayout.leftRailX))
        : null;

      const draggingOutward = railAbsX === null || (
        side === "right" ? (coords?.x ?? 0) > railAbsX
                         : (coords?.x ?? 0) < railAbsX
      );

      if (draggingOutward) {
        // Absorb: teal highlight on next/prev adjacent instruction
        const adjacentId = findAdjacentNodeId(rung?.nodes ?? [], branchId, side);
        lr?.showExtendTarget(rungId, adjacentId, "absorb");
      } else {
        // Eject: amber highlight on last/first instruction in leg 0
        const branchNode = findNodeById(rung?.nodes ?? [], branchId);
        const leg0 = branchNode?.kind === "branch" ? branchNode.legs[0] : null;
        const ejectNodeId = leg0 && leg0.nodes.length > 0
          ? (side === "right" ? leg0.nodes[leg0.nodes.length - 1].id : leg0.nodes[0].id)
          : null;
        lr?.showExtendTarget(rungId, ejectNodeId, "eject");
      }

      lr?.clearDropZone();
      lr?.clearDropAnchors();
      return;
    }

    if (isBranchWrap) {
      const coords = getCanvasCoords(e);
      const hit = coords ? rendererRef.current?.hitTestNode(coords.x, coords.y) : null;
      const target = hit && routine
        ? findNodeById(routine.rungs.find(r => r.id === hit.rungId)?.nodes ?? [], hit.nodeId)
        : null;
      if (hit && !rungAllowsRunEdit(hit.rungId)) {
        e.dataTransfer.dropEffect = "none";
        rendererRef.current?.clearDropZone();
        rendererRef.current?.clearDropAnchors();
        rendererRef.current?.clearExtendTarget();
        rendererRef.current?.clearLegHover();
        return;
      }
      rendererRef.current?.clearDropZone();
      rendererRef.current?.clearDropAnchors();
      rendererRef.current?.clearExtendTarget();
      if (hit && target?.kind === "instruction") {
        rendererRef.current?.showInstructionHover(hit.rungId, hit.nodeId);
      } else {
        rendererRef.current?.clearLegHover();
      }
      return;
    }

    if (isAddLeg) {
      const coords = getCanvasCoords(e);
      const hit = coords ? rendererRef.current?.hitTestNode(coords.x, coords.y) : null;
      const rung = hit && routine ? routine.rungs.find(r => r.id === hit.rungId) : null;
      const branchId = hit && rung ? resolveBranchTarget(rung, hit.nodeId) : null;
      if (hit && !rungAllowsRunEdit(hit.rungId)) {
        e.dataTransfer.dropEffect = "none";
        rendererRef.current?.clearDropZone();
        rendererRef.current?.clearDropAnchors();
        rendererRef.current?.clearExtendTarget();
        rendererRef.current?.clearLegHover();
        return;
      }
      rendererRef.current?.clearDropZone();
      rendererRef.current?.clearDropAnchors();
      rendererRef.current?.clearExtendTarget();
      if (hit && branchId) {
        rendererRef.current?.showInstructionHover(hit.rungId, branchId);
      } else {
        rendererRef.current?.clearLegHover();
      }
      return;
    }

    const paletteType = drag.active
      ? drag.instructionType
      : e.dataTransfer.getData("application/plc-instruction") as InstructionType | "";
    const info = getDropInfo(e, paletteType || undefined);
    if (info?.position && !positionAllowsRunEdit(info.position)) {
      e.dataTransfer.dropEffect = "none";
      dropTargetRef.current = null;
      rendererRef.current?.clearDropAnchors();
      rendererRef.current?.clearDropZone();
      rendererRef.current?.clearExtendTarget();
      return;
    }
    dropTargetRef.current = info?.position ?? null;
    rendererRef.current?.showDropAnchors(paletteType || undefined);
    rendererRef.current?.showDropZone(info);
    rendererRef.current?.clearExtendTarget();
  }

  function handleDragLeave(e: React.DragEvent) {
    // dragleave fires when the cursor enters a CHILD element (e.g. the Pixi
    // <canvas>). Only clear indicators when the cursor actually exits the wrapper.
    const wrap = canvasRef.current;
    if (wrap && wrap.contains(e.relatedTarget as Node)) return;
    dropTargetRef.current = null;
    rendererRef.current?.clearDropZone();
    rendererRef.current?.clearDropAnchors();
    rendererRef.current?.clearExtendTarget();
    rendererRef.current?.clearLegHover();
    rendererRef.current?.clearRungDropLine();
  }

  function handleDrop(e: React.DragEvent) {
    const isKnownPlcDrop =
      drag.active ||
      e.dataTransfer.types.includes("application/plc-rung-move") ||
      e.dataTransfer.types.includes("application/plc-move") ||
      e.dataTransfer.types.includes("application/plc-rail-extend") ||
      e.dataTransfer.types.includes("application/plc-branch-wrap") ||
      e.dataTransfer.types.includes("application/plc-add-leg") ||
      e.dataTransfer.types.includes("application/plc-tag") ||
      e.dataTransfer.types.includes("application/plc-instruction");
    if (!isKnownPlcDrop) return;

    e.preventDefault();
    rendererRef.current?.clearDropZone();
    rendererRef.current?.clearDropAnchors();
    rendererRef.current?.clearExtendTarget();
    rendererRef.current?.clearRungDropLine();
    dragNodeRef.current = null;
    railDragRef.current = null;
    rungDragRef.current = null;
    if (canvasRef.current) canvasRef.current.draggable = false;
    clearDraggedTagPayload();

    if (!routine) return;

    const tagRaw = e.dataTransfer.getData("application/plc-tag");
    if (tagRaw) {
      const coords = getCanvasCoords(e);
      const hit = coords ? rendererRef.current?.hitTestNode(coords.x, coords.y) : null;
      const rung = hit ? routine.rungs.find(r => r.id === hit.rungId) : null;
      const node = hit && rung ? findNodeById(rung.nodes, hit.nodeId) : null;
      if (coords && hit && rung && node?.kind === "instruction") {
        try {
          const tag = JSON.parse(tagRaw) as DraggedTagPayload;
          applyDraggedTagToInstruction(tag, routine.id, hit.rungId, node, coords.y);
        } catch {
          // Ignore malformed drag payloads from outside the app.
        }
      }
      return;
    }

    // ── Rung reorder ─────────────────────────────────────────────────────────
    const rungMoveId = e.dataTransfer.getData("application/plc-rung-move");
    if (rungMoveId) {
      if (mode === "running") {
        blockRunEdit("Rung reorder is disabled in Run mode.");
        return;
      }
      const coords = getCanvasCoords(e);
      if (coords) {
        const drop = rendererRef.current?.queryRungDropY(coords.y);
        if (drop) {
          // Don't move if dropping on itself (insertAfterRungId equals the rung being moved,
          // or the rung would stay in the same relative position)
          const isSame = drop.insertAfterRungId === rungMoveId;
          const isJustBelow = (() => {
            const idx = routine.rungs.findIndex(r => r.id === rungMoveId);
            const afterIdx = routine.rungs.findIndex(r => r.id === drop.insertAfterRungId);
            return afterIdx === idx - 1; // dropping back before itself = no-op
          })();
          if (!isSame && !isJustBelow) {
            moveRung(routine.id, rungMoveId, drop.insertAfterRungId);
          }
        }
      }
      return;
    }

    const addLegRaw = e.dataTransfer.getData("application/plc-add-leg");
    if (addLegRaw) {
      const coords = getCanvasCoords(e);
      const hit = coords ? rendererRef.current?.hitTestNode(coords.x, coords.y) : null;
      const rung = hit ? routine.rungs.find(r => r.id === hit.rungId) : null;
      const branchId = hit && rung ? resolveBranchTarget(rung, hit.nodeId) : null;
      if (hit && !rungAllowsRunEdit(hit.rungId)) {
        blockRunEdit();
        return;
      }
      if (hit && branchId) {
        addBranchLeg(routine.id, hit.rungId, branchId);
      }
      return;
    }

    const branchWrapRaw = e.dataTransfer.getData("application/plc-branch-wrap");
    if (branchWrapRaw) {
      const coords = getCanvasCoords(e);
      const hit = coords ? rendererRef.current?.hitTestNode(coords.x, coords.y) : null;
      const rung = hit ? routine.rungs.find(r => r.id === hit.rungId) : null;
      const target = hit && rung ? findNodeById(rung.nodes, hit.nodeId) : null;
      if (hit && !rungAllowsRunEdit(hit.rungId)) {
        blockRunEdit();
        return;
      }
      if (hit && target?.kind === "instruction") {
        wrapNodeInBranch(routine.id, hit.rungId, hit.nodeId);
      }
      return;
    }

    // â”€â”€ Branch rail extend/shrink â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const railRaw = e.dataTransfer.getData("application/plc-rail-extend");
    if (railRaw) {
      const src: { rungId: string; branchId: string; side: "left" | "right" } = JSON.parse(railRaw);
      if (!rungAllowsRunEdit(src.rungId)) {
        blockRunEdit();
        return;
      }
      const rung = routine.rungs.find(r => r.id === src.rungId);
      const branchNode = findNodeById(rung?.nodes ?? [], src.branchId);
      const leg0Id = branchNode?.kind === "branch" ? branchNode.legs[0]?.id : null;
      if (!leg0Id) return;

      // Determine absorb (outward) vs eject (inward) by comparing drop X to rail X
      const coords = getCanvasCoords(e);
      const branchLayout = rendererRef.current?.getBranchLayout(src.rungId, src.branchId);
      const railAbsX = branchLayout
        ? (rendererRef.current!.RUNG_NUMBER_W + (src.side === "right"
            ? branchLayout.rightRailX
            : branchLayout.leftRailX))
        : null;

      const droppedOutward = railAbsX === null || (
        src.side === "right" ? (coords?.x ?? 0) > railAbsX
                              : (coords?.x ?? 0) < railAbsX
      );

      if (droppedOutward) {
        absorbNext(routine.id, src.rungId, src.branchId, leg0Id,
          src.side === "right" ? "next" : "prev");
      } else {
        ejectFromLeg(routine.id, src.rungId, src.branchId, leg0Id,
          src.side === "right" ? "last" : "first");
      }
      return;
    }

    const type = (drag.active
      ? drag.instructionType
      : e.dataTransfer.getData("application/plc-instruction")) as InstructionType;
    const info = getDropInfo(e, type || undefined);
    const fallback: InsertPosition = routine.rungs.length > 0
      ? { kind: "series-append", rungId: routine.rungs[routine.rungs.length - 1].id }
      : { kind: "rung-append" };
    const position = info?.position ?? fallback;
    if (!positionAllowsRunEdit(position)) {
      blockRunEdit();
      dropTargetRef.current = null;
      return;
    }

    // â”€â”€ Moving an existing canvas node â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const moveRaw = e.dataTransfer.getData("application/plc-move");
    if (moveRaw) {
      const src: { rungId: string; nodeId: string } = JSON.parse(moveRaw);
      if (!rungAllowsRunEdit(src.rungId)) {
        blockRunEdit();
        dropTargetRef.current = null;
        return;
      }
      moveNode(routine.id, src.rungId, src.nodeId, position);
      dropTargetRef.current = null;
      return;
    }

    // â”€â”€ Inserting a new instruction from the palette â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (!type) return;
    dropTargetRef.current = null;
    insertInstruction(routine.id, position, type);
  }

  function handleClick(e: React.MouseEvent) {
    if (mode === "running") return;
    const coords = getCanvasCoords(e);
    if (!coords || !routine) return;
    if (rendererRef.current?.hitTestRungDeleteButton(coords.x, coords.y)) return;
    const hitGutterRungId = rendererRef.current?.hitTestOnlineEditGutter(coords.x, coords.y);
    if (!hitGutterRungId) return;

    const wrapRect = canvasRef.current?.getBoundingClientRect();
    const x = wrapRect ? e.clientX - wrapRect.left : e.clientX;
    const y = wrapRect ? e.clientY - wrapRect.top + (canvasRef.current?.scrollTop ?? 0) : e.clientY;
    useEditorStore.getState().setSelection({ kind: "rung", rungId: hitGutterRungId });
    setAsciiEditor({ rungId: hitGutterRungId, x, y });
    setTagEditor(null);
    setComplexEditor(null);
    setCompareMovEditor(null);
    setRungCommentEditor(null);
  }

  function handleDoubleClick(e: React.MouseEvent) {
    const coords = getCanvasCoords(e);
    if (!coords) return;
    const wrapRect = canvasRef.current?.getBoundingClientRect();
    const editorX = wrapRect ? e.clientX - wrapRect.left : e.clientX;
    const editorY = wrapRect ? e.clientY - wrapRect.top + (canvasRef.current?.scrollTop ?? 0) : e.clientY;

    const hitGutterRungId = rendererRef.current?.hitTestOnlineEditGutter(coords.x, coords.y);
    if (hitGutterRungId && routine && mode === "running") {
      beginOnlineEditRung(routine.id, hitGutterRungId);
      useEditorStore.getState().setSelection({ kind: "rung", rungId: hitGutterRungId });
      setTagEditor(null);
      setComplexEditor(null);
      setCompareMovEditor(null);
      setRungCommentEditor(null);
      setAsciiEditor(null);
      return;
    }

    const hit = rendererRef.current?.hitTestNode(coords.x, coords.y);
    const rung = hit ? routine?.rungs.find(r => r.id === hit.rungId) : null;
    const node = hit && rung ? findNodeById(rung.nodes, hit.nodeId) : null;

    if (hit && node?.kind === "instruction") {
      const editorState: TagEditorState = getEditorAnchor(hit.rungId, hit.nodeId) ?? {
        rungId: hit.rungId,
        nodeId: hit.nodeId,
        x: editorX,
        y: editorY,
      };
      useEditorStore.getState().setSelection({ kind: "node", rungId: hit.rungId, nodeId: hit.nodeId });
      if (node.type === "NOP") {
        setTagEditor(null);
        setComplexEditor(null);
        setCompareMovEditor(null);
        setRungCommentEditor(null);
        setAsciiEditor(null);
        return;
      }
      const isTimerCounter = ["TON","TOF","RTO","CTU","CTD"].includes(node.type);
      const isCompareMov   = COMPARE_MOVE_TYPES.has(node.type);
      if (isTimerCounter) {
        setComplexEditor(editorState);
        setTagEditor(null);
        setCompareMovEditor(null);
        setRungCommentEditor(null);
        setAsciiEditor(null);
      } else if (isCompareMov) {
        setCompareMovEditor(editorState);
        setTagEditor(null);
        setComplexEditor(null);
        setRungCommentEditor(null);
        setAsciiEditor(null);
      } else {
        setTagEditor(editorState);
        setComplexEditor(null);
        setCompareMovEditor(null);
        setRungCommentEditor(null);
        setAsciiEditor(null);
      }
      return;
    }

    // No instruction hit: double-clicking rung body opens the comment editor.
    const hitRungId = rendererRef.current?.hitTestRungBody(coords.x, coords.y);
    if (hitRungId) {
      setRungCommentEditor({ rungId: hitRungId, nodeId: "", x: editorX, y: editorY });
      setTagEditor(null);
      setComplexEditor(null);
      setCompareMovEditor(null);
      setAsciiEditor(null);
    }
  }

  function getEditorAnchor(rungId: string, nodeId: string): TagEditorState | null {
    const layout = rendererRef.current?.getInstructionLayout(rungId, nodeId);
    const bounds = rendererRef.current?.getRungBounds(rungId);
    const wrap = canvasRef.current;
    if (!layout || !bounds || !wrap) return null;

    const panelW = 320;
    const panelH = 220;
    const pad = 10;
    const scrollTop = wrap.scrollTop;
    const viewportW = wrap.clientWidth;
    const viewportH = wrap.clientHeight;
    const nodeLeft = rendererRef.current!.RUNG_NUMBER_W + layout.x;
    const nodeRight = nodeLeft + layout.w;
    const nodeTop = bounds.y + layout.y;
    const nodeMidY = bounds.y + layout.wireY;

    let x = nodeRight + pad;
    if (x + panelW > viewportW - pad) {
      x = Math.max(pad, nodeLeft - panelW - pad);
    }

    let y = nodeMidY - 18;
    const visibleBottom = scrollTop + viewportH - pad;
    if (y + panelH > visibleBottom) {
      y = Math.max(scrollTop + pad, visibleBottom - panelH);
    }
    if (y < scrollTop + pad) y = scrollTop + pad;

    return { rungId, nodeId, x, y };
  }

  function handleAddRung() {
    if (!routine) return;
    addRung(routine.id);
  }

  // â”€â”€ Render â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  function applyDraggedTagToInstruction(
    tag: DraggedTagPayload,
    routineId: string,
    rungId: string,
    node: ReturnType<typeof findNodeById> & { kind: "instruction" },
    canvasY: number
  ) {
    const type = node.type;
    const isBool = tag.dataType === "BOOL";
    const isNumeric = tag.dataType === "BOOL" || tag.dataType === "DINT" || tag.dataType === "INT" || tag.dataType === "REAL";

    if (["XIC","XIO","OSR","OSF","ONS","OTE","OTL","OTU"].includes(type)) {
      if (isBool) assignTag(routineId, rungId, node.id, tag.name);
      return;
    }

    if (["TON","TOF","RTO"].includes(type)) {
      if (tag.dataType === "TIMER") assignTag(routineId, rungId, node.id, tag.name);
      return;
    }

    if (["CTU","CTD"].includes(type)) {
      if (tag.dataType === "COUNTER") assignTag(routineId, rungId, node.id, tag.name);
      return;
    }

    if (type === "RES") {
      if (tag.dataType === "TIMER" || tag.dataType === "COUNTER") assignTag(routineId, rungId, node.id, tag.name);
      return;
    }

    if (!isNumeric) return;

    const layout = rendererRef.current?.getInstructionLayout(rungId, node.id);
    const bounds = rendererRef.current?.getRungBounds(rungId);
    if (!layout || !bounds) return;

    const relToWire = canvasY - bounds.y - layout.wireY;

    if (type === "LIM") {
      const field = relToWire < 21 ? "sourceA" : relToWire < 35 ? "sourceB" : "sourceC";
      setInstructionParams(routineId, rungId, node.id, { [field]: tag.name });
      return;
    }

    if (["EQU","NEQ","LES","LEQ","GRT","GEQ"].includes(type)) {
      setInstructionParams(routineId, rungId, node.id, { [relToWire < 27 ? "sourceA" : "sourceB"]: tag.name });
      return;
    }

    if (type === "MOV") {
      setInstructionParams(routineId, rungId, node.id, { [relToWire < 27 ? "source" : "dest"]: tag.name });
      return;
    }

    if (type === "MVM") {
      const field = relToWire < 21 ? "source" : relToWire < 35 ? "mask" : "dest";
      setInstructionParams(routineId, rungId, node.id, { [field]: tag.name });
      return;
    }

    if (type === "COP" || type === "CPS") {
      const field = relToWire < 21 ? "source" : relToWire < 35 ? "dest" : "length";
      setInstructionParams(routineId, rungId, node.id, { [field]: tag.name });
      return;
    }

    if (type === "BSL" || type === "BSR") {
      const field = relToWire < 21 ? "array" : relToWire < 35 ? "source" : "length";
      setInstructionParams(routineId, rungId, node.id, { [field]: tag.name });
      return;
    }

    if (["ADD","SUB","MUL","DIV","MOD"].includes(type)) {
      const field = relToWire < 21 ? "sourceA" : relToWire < 35 ? "sourceB" : "dest";
      setInstructionParams(routineId, rungId, node.id, { [field]: tag.name });
      return;
    }

    if (["NEG","ABS","SQR"].includes(type)) {
      setInstructionParams(routineId, rungId, node.id, { [relToWire < 27 ? "sourceA" : "dest"]: tag.name });
      return;
    }

    if (type === "CLR") setInstructionParams(routineId, rungId, node.id, { dest: tag.name });
  }

  function readDraggedTag(e: React.DragEvent): DraggedTagPayload | null {
    const raw = e.dataTransfer.getData("application/plc-tag");
    if (!raw) return getDraggedTagPayload();
    try {
      return JSON.parse(raw) as DraggedTagPayload;
    } catch {
      return getDraggedTagPayload();
    }
  }

  function getTagDropPreview(
    tag: DraggedTagPayload,
    rungId: string,
    node: ReturnType<typeof findNodeById> & { kind: "instruction" },
    canvasY: number
  ): TagDropPreview {
    const type = node.type;
    const isBool = tag.dataType === "BOOL";
    const isNumeric = tag.dataType === "BOOL" || tag.dataType === "DINT" || tag.dataType === "INT" || tag.dataType === "REAL";
    const simple = (label: string, valid: boolean): TagDropPreview => ({ rowIndex: 0, rowCount: 1, label, valid });

    if (["XIC","XIO","OSR","OSF","ONS","OTE","OTL","OTU"].includes(type)) {
      return simple("Tag", isBool);
    }
    if (["TON","TOF","RTO"].includes(type)) return simple("Timer", tag.dataType === "TIMER");
    if (["CTU","CTD"].includes(type)) return simple("Counter", tag.dataType === "COUNTER");
    if (type === "RES") return simple("Timer/Counter", tag.dataType === "TIMER" || tag.dataType === "COUNTER");

    const layout = rendererRef.current?.getInstructionLayout(rungId, node.id);
    const bounds = rendererRef.current?.getRungBounds(rungId);
    if (!layout || !bounds) return simple("No drop", false);
    const relToWire = canvasY - bounds.y - layout.wireY;

    if (type === "LIM") {
      const rowIndex = relToWire < 21 ? 0 : relToWire < 35 ? 1 : 2;
      return { rowIndex, rowCount: 3, label: ["Low", "Test", "High"][rowIndex], valid: isNumeric };
    }
    if (["EQU","NEQ","LES","LEQ","GRT","GEQ"].includes(type)) {
      const rowIndex = relToWire < 27 ? 0 : 1;
      return { rowIndex, rowCount: 2, label: rowIndex === 0 ? "SrcA" : "SrcB", valid: isNumeric };
    }
    if (type === "MOV") {
      const rowIndex = relToWire < 27 ? 0 : 1;
      return { rowIndex, rowCount: 2, label: rowIndex === 0 ? "Src" : "Dst", valid: isNumeric };
    }
    if (type === "MVM") {
      const rowIndex = relToWire < 21 ? 0 : relToWire < 35 ? 1 : 2;
      return { rowIndex, rowCount: 3, label: ["Src", "Msk", "Dst"][rowIndex], valid: isNumeric };
    }
    if (type === "COP" || type === "CPS") {
      const rowIndex = relToWire < 21 ? 0 : relToWire < 35 ? 1 : 2;
      return { rowIndex, rowCount: 3, label: ["Src", "Dst", "Len"][rowIndex], valid: isNumeric };
    }
    if (type === "BSL" || type === "BSR") {
      const rowIndex = relToWire < 21 ? 0 : relToWire < 35 ? 1 : 2;
      const valid = rowIndex === 0
        ? tag.dataType === "DINT" || tag.dataType === "INT"
        : isNumeric;
      return { rowIndex, rowCount: 3, label: ["Array", "Src", "Len"][rowIndex], valid };
    }
    if (["ADD","SUB","MUL","DIV","MOD"].includes(type)) {
      const rowIndex = relToWire < 21 ? 0 : relToWire < 35 ? 1 : 2;
      return { rowIndex, rowCount: 3, label: ["SrcA", "SrcB", "Dst"][rowIndex], valid: isNumeric };
    }
    if (["NEG","ABS","SQR"].includes(type)) {
      const rowIndex = relToWire < 27 ? 0 : 1;
      return { rowIndex, rowCount: 2, label: rowIndex === 0 ? "Src" : "Dst", valid: isNumeric };
    }
    if (type === "CLR") return { rowIndex: 0, rowCount: 1, label: "Dst", valid: isNumeric };
    return simple("No drop", false);
  }

  if (!routine) {
    return <div className="pixi-canvas-wrap pixi-canvas-wrap--empty">No routine selected</div>;
  }

  return (
    <div
      className={`pixi-canvas-outer pixi-canvas-outer--${theme}`}
      ref={outerRef}
      style={{ backgroundColor: canvasBackground }}
    >
      <div className="pixi-routine-header">
        <span className="pixi-routine-name">{routine.name}</span>
        <span className="pixi-rung-count">
          {routine.rungs.length} rung{routine.rungs.length !== 1 ? "s" : ""}
        </span>
        <button
          className={`pixi-comment-toggle ${showRungComments ? "pixi-comment-toggle--on" : ""}`}
          onClick={toggleRungComments}
          title={showRungComments ? "Hide rung comments" : "Show rung comments"}
        >
          {showRungComments ? "// Rung" : "// Rung"}
        </button>
        <button
          className={`pixi-comment-toggle ${showNodeComments ? "pixi-comment-toggle--on" : ""}`}
          onClick={toggleNodeComments}
          title={showNodeComments ? "Hide instruction comments" : "Show instruction comments"}
        >
          {showNodeComments ? "// Inst" : "// Inst"}
        </button>
        <button className="pixi-add-rung-btn" onClick={handleAddRung}>+ Rung</button>
      </div>

      <div
        ref={canvasRef}
        className={`pixi-canvas-wrap pixi-canvas-wrap--${theme}`}
        style={{ backgroundColor: canvasBackground }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerLeave={handlePointerLeave}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
      >
        {routine.rungs.length === 0 && (
          <div className="pixi-empty-hint">
            Click <strong>+ Rung</strong> to add a rung
          </div>
        )}

        {tagEditor && (
          <TagQuickEdit
            editor={tagEditor}
            routineId={routine.id}
            onClose={() => setTagEditor(null)}
          />
        )}

        {complexEditor && (
          <ComplexParamEditor
            editor={complexEditor}
            routineId={routine.id}
            onClose={() => setComplexEditor(null)}
          />
        )}

        {compareMovEditor && (
          <CompareMovEditor
            editor={compareMovEditor}
            routineId={routine.id}
            onClose={() => setCompareMovEditor(null)}
          />
        )}

        {rungCommentEditor && (
          <RungCommentEditor
            editor={rungCommentEditor}
            routineId={routine.id}
            onClose={() => setRungCommentEditor(null)}
          />
        )}

        {asciiEditor && (
          <AsciiRungEditor
            editor={asciiEditor}
            onApply={(text) => replaceRungWithAscii(routine.id, asciiEditor.rungId, text)}
            onClose={() => setAsciiEditor(null)}
          />
        )}
      </div>

      {selection?.kind === "leg" && (
        <LegBar
          rungId={selection.rungId}
          branchId={selection.branchId}
          legId={selection.legId}
          routineId={routine.id}
        />
      )}

      {selection?.kind === "rung" && (
        <RungBar
          rungId={selection.rungId}
          routineId={routine.id}
          canDelete={routine.rungs.length > 0}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pointer tag editor
// ---------------------------------------------------------------------------

function AsciiRungEditor({ editor, onApply, onClose }: {
  editor: AsciiEditorState;
  onApply: (text: string) => { valid: boolean; reason?: string };
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [source, setSource] = useState("");

  useEffect(() => {
    function handlePointerDown(e: PointerEvent) {
      if (!panelRef.current?.contains(e.target as Node)) onClose();
    }
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [onClose]);

  function apply() {
    const result = onApply(source);
    if (result.valid) onClose();
  }

  return (
    <div
      ref={panelRef}
      className="ascii-rung-edit"
      style={{ left: editor.x, top: editor.y }}
      onPointerDown={e => e.stopPropagation()}
      onClick={e => e.stopPropagation()}
    >
      <div className="tag-quick-edit-head">
        <span>ASCII Rung</span>
        <button type="button" onClick={onClose}>x</button>
      </div>
      <textarea
        className="ascii-rung-edit-input"
        autoFocus
        spellCheck={false}
        value={source}
        onChange={e => setSource(e.target.value)}
        onKeyDown={e => {
          if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
            e.preventDefault();
            apply();
          }
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
      />
      <button
        type="button"
        className="tag-quick-edit-apply"
        onClick={apply}
      >
        Apply
      </button>
    </div>
  );
}

function TagQuickEdit({ editor, routineId, onClose }: {
  editor: TagEditorState;
  routineId: string;
  onClose: () => void;
}) {
  const { project, addTag, assignTag, setTagDescription } = useProjectStore();
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const routine = project.programs.flatMap(p => p.routines).find(r => r.id === routineId);
  const rung = routine?.rungs.find(r => r.id === editor.rungId);
  const node = rung ? findNodeById(rung.nodes, editor.nodeId) : null;
  const instructionType = node?.kind === "instruction" ? node.type : null;
  const existingTagName = node?.kind === "instruction" ? node.tagName : "";

  // Description lives on the tag, not the instruction node
  const existingTag = project.tags.find(t => t.name === existingTagName);
  const existingDesc = existingTag?.description ?? "";
  const [name, setName] = useState(existingTagName);
  const [comment, setComment] = useState(existingDesc);
  const [dataType, setDataType] = useState<TagDataType>(() =>
    defaultDataTypeForInstruction(instructionType)
  );
  const [activeIndex, setActiveIndex] = useState(0);

  const trimmed = name.trim();
  const lower = trimmed.toLowerCase();

  // Expand TIMER/COUNTER/DINT/INT tags to include their sub-element entries.
  // These virtual entries let the user type "MyTimer.DN" or "MyArr[2].5" etc.;
  // the simulator resolves them at scan time — no separate tag entry is created.
  const TIMER_BITS   = ["DN", "TT", "EN"] as const;
  const COUNTER_BITS = ["DN", "CU", "CD", "OV", "UN"] as const;
  type FlatTag = { id: string; name: string; dataType: TagDataType };
  const expandedTags: FlatTag[] = [];
  for (const tag of project.tags) {
    expandedTags.push(tag);
    if (tag.dataType === "TIMER") {
      for (const bit of TIMER_BITS) {
        expandedTags.push({ id: `${tag.id}.${bit}`, name: `${tag.name}.${bit}`, dataType: "BOOL" });
      }
    } else if (tag.dataType === "COUNTER") {
      for (const bit of COUNTER_BITS) {
        expandedTags.push({ id: `${tag.id}.${bit}`, name: `${tag.name}.${bit}`, dataType: "BOOL" });
      }
    } else if (tag.dataType === "DINT" || tag.dataType === "INT") {
      const isArray = Array.isArray(tag.value);
      const arrSize = isArray ? (tag.value as number[]).length : 0;
      const maxBit  = tag.dataType === "DINT" ? 31 : 15;

      if (isArray) {
        // Array: expand element refs and bit refs per element
        // Limit to first 8 elements in autocomplete to keep the list manageable.
        const previewLen = Math.min(arrSize, 8);
        for (let i = 0; i < previewLen; i++) {
          expandedTags.push({
            id: `${tag.id}[${i}]`,
            name: `${tag.name}[${i}]`,
            dataType: tag.dataType,
          });
          for (let b = 0; b <= maxBit; b++) {
            expandedTags.push({
              id: `${tag.id}[${i}].${b}`,
              name: `${tag.name}[${i}].${b}`,
              dataType: "BOOL",
            });
          }
        }
      } else {
        // Scalar DINT/INT: expand bit refs (.0 – .31 or .15)
        for (let b = 0; b <= maxBit; b++) {
          expandedTags.push({
            id: `${tag.id}.${b}`,
            name: `${tag.name}.${b}`,
            dataType: "BOOL",
          });
        }
      }
    }
  }

  const matches = lower
    ? expandedTags.filter(t => t.name.toLowerCase().includes(lower)).slice(0, 8)
    : expandedTags.slice(0, 8);
  const exact = expandedTags.find(t => t.name.toLowerCase() === lower) ?? null;
  const canCreate = Boolean(trimmed && !exact);
  const rowCount = matches.length + (canCreate ? 1 : 0);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    setName(existingTagName);
    setComment(existingDesc);
    setDataType(defaultDataTypeForInstruction(instructionType));
  }, [editor.nodeId, existingTagName, existingDesc, instructionType]);

  useEffect(() => {
    setActiveIndex(canCreate ? matches.length : 0);
  }, [trimmed, canCreate, matches.length]);

  // When the typed name matches an existing tag, sync the description field
  // so the user sees the current description and doesn't accidentally clear it.
  useEffect(() => {
    const matched = project.tags.find(t => t.name.toLowerCase() === trimmed.toLowerCase());
    if (matched) setComment(matched.description ?? "");
  }, [trimmed]);

  useEffect(() => {
    function handlePointerDown(e: PointerEvent) {
      if (!panelRef.current?.contains(e.target as Node)) onClose();
    }
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [onClose]);

  if (!instructionType) return null;

  function commit(tagName: string, create: boolean) {
    const nextName = tagName.trim();
    if (!nextName) return;
    const desc = comment.trim();
    if (create && !project.tags.find(t => t.name === nextName)) {
      // Pass description directly into addTag so it's set from the start
      addTag(nextName, dataType, desc || undefined);
    } else {
      // Only update description if the user actually changed it from what the tag already has
      const existing = project.tags.find(t => t.name === nextName);
      if (existing && desc !== (existing.description ?? "")) {
        setTagDescription(existing.id, desc);
      }
    }
    const result = assignTag(routineId, editor.rungId, editor.nodeId, nextName);
    if (result.valid) onClose();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (rowCount > 0) setActiveIndex(i => (i + 1) % rowCount);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (rowCount > 0) setActiveIndex(i => (i - 1 + rowCount) % rowCount);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (activeIndex < matches.length) {
        commit(matches[activeIndex].name, false);
      } else {
        commit(trimmed, canCreate);
      }
    }
  }

  return (
    <div
      ref={panelRef}
      className="tag-quick-edit"
      style={{ left: editor.x, top: editor.y }}
      onPointerDown={e => e.stopPropagation()}
    >
      <div className="tag-quick-edit-head">
        <span>{instructionType}</span>
        <button type="button" onClick={onClose}>x</button>
      </div>
      <input
        ref={inputRef}
        className="tag-quick-edit-input"
        value={name}
        placeholder="Tag name"
        onChange={e => setName(e.target.value)}
        onKeyDown={handleKeyDown}
      />
      <input
        className="tag-quick-edit-input tag-quick-edit-comment"
        value={comment}
        placeholder="Tag description (shown above instruction)"
        onChange={e => setComment(e.target.value)}
        onKeyDown={e => {
          if (e.key === "Escape") { e.preventDefault(); onClose(); }
          if (e.key === "Enter")  { e.preventDefault(); if (trimmed) commit(trimmed, canCreate); }
        }}
      />
      <div className="tag-quick-edit-list">
        {matches.map((tag, idx) => (
          <button
            key={tag.id}
            type="button"
            className={idx === activeIndex ? "active" : ""}
            onClick={() => {
              // Populate description from the selected tag before committing
              const fullTag = project.tags.find(t => t.name === tag.name);
              if (fullTag?.description) setComment(fullTag.description);
              commit(tag.name, false);
            }}
          >
            <span>{tag.name}</span>
            <em>{tag.dataType}</em>
          </button>
        ))}
        {canCreate && (
          <button
            type="button"
            className={activeIndex === matches.length ? "active create" : "create"}
            onClick={() => commit(trimmed, true)}
          >
            <span>Create {trimmed}</span>
            <em>{dataType}</em>
          </button>
        )}
        {!rowCount && (
          <div className="tag-quick-edit-empty">Type a tag name</div>
        )}
      </div>
      {canCreate && (
        <label className="tag-quick-edit-type">
          <span>Data type</span>
          <select
            value={dataType}
            onChange={e => setDataType(e.target.value as TagDataType)}
          >
            <option value="BOOL">BOOL</option>
            <option value="DINT">DINT</option>
            <option value="INT">INT</option>
            <option value="REAL">REAL</option>
            <option value="TIMER">TIMER</option>
            <option value="COUNTER">COUNTER</option>
          </select>
        </label>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Complex param editor — timer / counter instructions
// ---------------------------------------------------------------------------

function ComplexParamEditor({ editor, routineId, onClose }: {
  editor: TagEditorState;
  routineId: string;
  onClose: () => void;
}) {
  const { project, addTag, assignTag, setInstructionParams, setTagDescription } = useProjectStore();
  const panelRef  = useRef<HTMLDivElement>(null);
  const tagRef    = useRef<HTMLInputElement>(null);

  const routine = project.programs.flatMap(p => p.routines).find(r => r.id === routineId);
  const rung    = routine?.rungs.find(r => r.id === editor.rungId);
  const node    = rung ? findNodeById(rung.nodes, editor.nodeId) : null;
  if (!node || node.kind !== "instruction") return null;

  const isTimer = ["TON","TOF","RTO"].includes(node.type);
  const p = node.params as TimerParams | CounterParams;

  const existingTimerTag = project.tags.find(t => t.name === node.tagName);
  const [tagName, setTagName]     = useState(node.tagName ?? "");
  const [comment, setComment]     = useState(existingTimerTag?.description ?? "");
  const [presetRaw, setPresetRaw] = useState<string>(() =>
    p?.presetTag ? p.presetTag : String(p?.preset ?? (isTimer ? 1000 : 10))
  );

  // DINT/INT tags available for preset reference
  const dintTags = project.tags.filter(t => t.dataType === "DINT" || t.dataType === "INT");
  const presetTrimmed = presetRaw.trim();
  const looksLikeNumber = /^-?\d+$/.test(presetTrimmed);
  const presetMatches = !looksLikeNumber && presetTrimmed
    ? dintTags.filter(t => t.name.toLowerCase().includes(presetTrimmed.toLowerCase())).slice(0, 4)
    : [];

  useEffect(() => { tagRef.current?.focus(); }, []);

  useEffect(() => {
    function handlePointerDown(e: PointerEvent) {
      if (!panelRef.current?.contains(e.target as Node)) onClose();
    }
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [onClose]);

  function commit() {
    const tName = tagName.trim();
    // ── Tag assignment ──────────────────────────────────────────────────────
    if (tName) {
      const expectedType = isTimer ? "TIMER" : "COUNTER";
      if (!project.tags.find(t => t.name === tName)) {
        addTag(tName, expectedType);
      }
      assignTag(routineId, editor.rungId, editor.nodeId, tName);
    }
    // ── Preset assignment ────────────────────────────────────────────────────
    if (looksLikeNumber) {
      setInstructionParams(routineId, editor.rungId, editor.nodeId, {
        preset: parseInt(presetTrimmed, 10),
        presetTag: "",   // clear any tag reference
      });
    } else if (presetTrimmed) {
      setInstructionParams(routineId, editor.rungId, editor.nodeId, {
        presetTag: presetTrimmed,
      });
    }
    // ── Tag description ───────────────────────────────────────────────────────
    const resolvedTag = project.tags.find(t => t.name === tName || t.name === tagName.trim());
    if (resolvedTag) setTagDescription(resolvedTag.id, comment.trim());
    onClose();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") { e.preventDefault(); onClose(); }
    if (e.key === "Enter")  { e.preventDefault(); commit(); }
  }

  return (
    <div
      ref={panelRef}
      className="tag-quick-edit"
      style={{ left: editor.x, top: editor.y, minWidth: 200 }}
      onPointerDown={e => e.stopPropagation()}
    >
      <div className="tag-quick-edit-head">
        <span>{node.type}</span>
        <button type="button" onClick={onClose}>x</button>
      </div>

      {/* Tag field */}
      <label className="tag-quick-edit-type" style={{ borderBottom: "1px solid var(--border)", paddingBottom: 6, marginBottom: 4 }}>
        <span>Tag ({isTimer ? "TIMER" : "COUNTER"})</span>
      </label>
      <input
        ref={tagRef}
        className="tag-quick-edit-input"
        value={tagName}
        placeholder="Tag name"
        onChange={e => setTagName(e.target.value)}
        onKeyDown={handleKeyDown}
      />

      {/* Preset field */}
      <label className="tag-quick-edit-type" style={{ marginTop: 6 }}>
        <span>Preset ({isTimer ? "ms" : "counts"})</span>
      </label>
      <input
        className="tag-quick-edit-input"
        value={presetRaw}
        placeholder={isTimer ? "1000  or  Tag_Name" : "10  or  Tag_Name"}
        onChange={e => setPresetRaw(e.target.value)}
        onKeyDown={handleKeyDown}
      />
      {!looksLikeNumber && presetTrimmed && (
        <div style={{ fontSize: 9, color: "var(--text-dim)", padding: "2px 8px" }}>
          Will link to DINT/INT tag "{presetTrimmed}"
        </div>
      )}
      {presetMatches.length > 0 && (
        <div className="tag-quick-edit-list">
          {presetMatches.map(t => (
            <button
              key={t.id}
              type="button"
              onClick={() => setPresetRaw(t.name)}
            >
              <span>{t.name}</span>
              <em>{t.dataType}</em>
            </button>
          ))}
        </div>
      )}

      {/* Tag description field */}
      <label className="tag-quick-edit-type" style={{ marginTop: 6 }}>
        <span>Description</span>
      </label>
      <input
        className="tag-quick-edit-input tag-quick-edit-comment"
        value={comment}
        placeholder="Tag description (shown above instruction)"
        onChange={e => setComment(e.target.value)}
        onKeyDown={handleKeyDown}
      />

      <button
        type="button"
        style={{
          margin: "6px 8px 4px",
          padding: "4px 10px",
          background: "var(--accent-blue-bg)",
          color: "var(--accent-blue)",
          border: "1px solid var(--accent-blue)",
          borderRadius: 3,
          fontSize: 11,
          cursor: "pointer",
          width: "calc(100% - 16px)",
        }}
        onClick={commit}
      >
        Apply
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Compare / Move operand editor  (double-click on EQU/NEQ/… / MOV/MVM)
// ---------------------------------------------------------------------------

const MATH_TYPES = new Set(["ADD","SUB","MUL","DIV","MOD","NEG","ABS","SQR","CLR"]);
const BINARY_MATH_TYPES = new Set(["ADD","SUB","MUL","DIV","MOD"]);
const COMPARE_MOVE_TYPES = new Set([
  "EQU","NEQ","LES","LEQ","GRT","GEQ","LIM","MOV","MVM","COP","CPS","BSL","BSR",
  ...MATH_TYPES,
  "JSR",
]);

function CompareMovEditor({ editor, routineId, onClose }: {
  editor: TagEditorState;
  routineId: string;
  onClose: () => void;
}) {
  const { project, setInstructionParams, addTag } = useProjectStore();
  const panelRef = useRef<HTMLDivElement>(null);

  const routine = project.programs.flatMap(p => p.routines).find(r => r.id === routineId);
  const rung    = routine?.rungs.find(r => r.id === editor.rungId);
  const node    = rung ? findNodeById(rung.nodes, editor.nodeId) : null;
  if (!node || node.kind !== "instruction") return null;

  const isJsrInst = node.type === "JSR";
  const isLimInst = node.type === "LIM";
  const isMovInst = node.type === "MOV" || node.type === "MVM";
  const isMVM     = node.type === "MVM";
  const isCopyInst = node.type === "COP" || node.type === "CPS";
  const isShiftInst = node.type === "BSL" || node.type === "BSR";
  const isMathInst = MATH_TYPES.has(node.type);
  const isBinaryMath = BINARY_MATH_TYPES.has(node.type);
  const isClr = node.type === "CLR";
  const cp = node.params as CompareParams;
  const mp = node.params as MoveParams;
  const copy = node.params as CopyParams;
  const shift = node.params as BitShiftParams;
  const math = node.params as MathParams;
  const jsr = node.params as JsrParams;

  const [fieldA, setFieldA] = useState(isMathInst ? (math.sourceA ?? "") : isShiftInst ? (shift.array ?? "") : isCopyInst ? (copy.source ?? "") : isMovInst ? (mp.source ?? "") : (cp.sourceA ?? ""));
  const [fieldB, setFieldB] = useState(isMathInst ? (math.sourceB ?? "") : isShiftInst ? (shift.source ?? "") : isCopyInst ? (copy.dest ?? "") : isMovInst ? (mp.dest   ?? "") : (cp.sourceB ?? ""));
  const [fieldDest, setFieldDest] = useState(isMathInst ? (math.dest ?? "") : "");
  const [fieldMask, setFieldMask] = useState(isMVM ? ((node.params as MoveParams).mask ?? "0xFFFFFFFF") : isShiftInst ? (shift.length ?? "32") : isCopyInst ? (copy.length ?? "1") : isLimInst ? (cp.sourceC ?? "") : "");
  const routines = project.programs.flatMap(program => program.routines);
  const [routineName, setRoutineName] = useState(jsr.routineName || routines.find(r => r.id !== routineId)?.name || "");
  type OperandField = "sourceA" | "sourceB" | "dest" | "mask";
  const [activeField, setActiveField] = useState<OperandField | null>(null);
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(0);

  type OperandSuggestion = { id: string; name: string; dataType: string };

  const numericTags: OperandSuggestion[] = project.tags
    .filter(t => t.dataType === "DINT" || t.dataType === "INT" || t.dataType === "REAL" || t.dataType === "BOOL")
    .map(t => ({ id: t.id, name: t.name, dataType: t.dataType }));

  const structuredNumericTags: OperandSuggestion[] = project.tags.flatMap(t => {
    if (t.dataType === "TIMER") {
      return [
        { id: `${t.id}:PRE`, name: `${t.name}.PRE`, dataType: "TIMER" },
        { id: `${t.id}:ACC`, name: `${t.name}.ACC`, dataType: "TIMER" },
      ];
    }
    if (t.dataType === "COUNTER") {
      return [
        { id: `${t.id}:PRE`, name: `${t.name}.PRE`, dataType: "COUNTER" },
        { id: `${t.id}:ACC`, name: `${t.name}.ACC`, dataType: "COUNTER" },
      ];
    }
    return [];
  });

  const operandTags = [...numericTags, ...structuredNumericTags];

  useEffect(() => {
    function handlePointerDown(e: PointerEvent) {
      if (!panelRef.current?.contains(e.target as Node)) onClose();
    }
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [onClose]);

  function suggestionsFor(val: string) {
    const lower = val.trim().toLowerCase();
    if (/^-?[\d.]/.test(lower) || /^0x/i.test(lower)) return [];
    if (!lower) return operandTags.slice(0, 10);
    return operandTags
      .filter(t => t.name.toLowerCase().includes(lower))
      .slice(0, 10);
  }

  function normalizeOperandRef(value: string): string {
    const trimmed = value.trim();
    const match = trimmed.match(/^([A-Za-z_]\w*)(\.(pre|acc|en|tt|dn|cu|cd|ov|un))$/i);
    if (!match) return trimmed;
    return `${match[1]}.${match[3].toUpperCase()}`;
  }

  function isExistingStructuredRef(value: string): boolean {
    const match = value.trim().match(/^([A-Za-z_]\w*)\.(PRE|ACC|EN|TT|DN|CU|CD|OV|UN)$/i);
    if (!match) return false;
    const base = project.tags.find(t => t.name.toLowerCase() === match[1].toLowerCase());
    return base?.dataType === "TIMER" || base?.dataType === "COUNTER";
  }

  function commit() {
    if (isJsrInst) {
      setInstructionParams(routineId, editor.rungId, editor.nodeId, {
        routineName: routineName.trim(),
      });
      onClose();
      return;
    }

    const a = normalizeOperandRef(fieldA);
    const b = normalizeOperandRef(fieldB);
    const mask = normalizeOperandRef(fieldMask);

    if (isMathInst) {
      const dest = normalizeOperandRef(fieldDest);
      if (dest && !isExistingStructuredRef(dest) && !project.tags.find(t => t.name === dest)) {
        addTag(dest, "DINT");
      }
      const patch: Partial<MathParams> = { sourceA: a, dest };
      if (isBinaryMath) patch.sourceB = b;
      setInstructionParams(routineId, editor.rungId, editor.nodeId, patch);
    } else if (isMovInst) {
      // Auto-create dest tag if it looks like a tag name and doesn't exist
      const destIsLiteral = !isNaN(Number(b)) || /^0x/i.test(b);
      if (!destIsLiteral && b && !isExistingStructuredRef(b) && !project.tags.find(t => t.name === b)) {
        addTag(b, "DINT");
      }
      const patch: Partial<MoveParams> = { source: a, dest: b };
      if (isMVM) patch.mask = mask || "0xFFFFFFFF";
      setInstructionParams(routineId, editor.rungId, editor.nodeId, patch);
    } else if (isCopyInst) {
      const destIsLiteral = !isNaN(Number(b)) || /^0x/i.test(b);
      if (!destIsLiteral && b && !isExistingStructuredRef(b) && !project.tags.find(t => t.name === b)) {
        addTag(b, "DINT");
      }
      const patch: Partial<CopyParams> = {
        source: a,
        dest: b,
        length: mask || "1",
      };
      setInstructionParams(routineId, editor.rungId, editor.nodeId, patch);
    } else if (isShiftInst) {
      if (a && !project.tags.find(t => t.name === a)) {
        addTag(a, "DINT");
      }
      const patch: Partial<BitShiftParams> = {
        array: a,
        source: b,
        length: mask || "32",
      };
      setInstructionParams(routineId, editor.rungId, editor.nodeId, patch);
    } else if (isLimInst) {
      setInstructionParams(routineId, editor.rungId, editor.nodeId,
        { sourceA: a, sourceB: b, sourceC: mask });
    } else {
      setInstructionParams(routineId, editor.rungId, editor.nodeId,
        { sourceA: a, sourceB: b });
    }
    onClose();
  }

  function handleFocus(field: OperandField) {
    setActiveField(field);
    setActiveSuggestionIndex(0);
  }

  function handleOperandKey(
    e: React.KeyboardEvent<HTMLInputElement>,
    field: OperandField,
    suggestions: OperandSuggestion[],
    setValue: (value: string) => void
  ) {
    if (e.key === "ArrowDown" && suggestions.length > 0) {
      e.preventDefault();
      setActiveField(field);
      setActiveSuggestionIndex(i => Math.min(i + 1, suggestions.length - 1));
      return;
    }
    if (e.key === "ArrowUp" && suggestions.length > 0) {
      e.preventDefault();
      setActiveField(field);
      setActiveSuggestionIndex(i => Math.max(i - 1, 0));
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      if (activeField) setActiveField(null);
      else onClose();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (activeField === field && suggestions.length > 0) {
        setValue(suggestions[activeSuggestionIndex]?.name ?? suggestions[0].name);
        setActiveField(null);
        setActiveSuggestionIndex(0);
        return;
      }
      commit();
    }
  }

  const labelA = isClr ? "Source" : isShiftInst ? "Array" : isLimInst ? "Low Limit" : (isMovInst || isCopyInst) ? "Source" : "Source A";
  const labelB = isShiftInst ? "Source Bit" : isLimInst ? "Test" : (isMovInst || isCopyInst) ? "Destination" : "Source B";
  const hintA  = "tag or literal";
  const hintB  = (isMovInst || isCopyInst) ? "tag name" : "tag or literal";

  const sugA = activeField === "sourceA" ? suggestionsFor(fieldA) : [];
  const sugB = activeField === "sourceB" ? suggestionsFor(fieldB) : [];
  const sugDest = activeField === "dest" ? suggestionsFor(fieldDest) : [];
  const sugMask = activeField === "mask" ? suggestionsFor(fieldMask) : [];

  if (isJsrInst) {
    return (
      <div
        ref={panelRef}
        className="tag-quick-edit"
        style={{ left: editor.x, top: editor.y, minWidth: 230 }}
        onPointerDown={e => e.stopPropagation()}
      >
        <div className="tag-quick-edit-head">
          <span>JSR</span>
          <button type="button" onClick={onClose}>x</button>
        </div>
        <label className="tag-quick-edit-type"><span>Routine</span></label>
        <select
          className="tag-quick-edit-input"
          autoFocus
          value={routineName}
          onChange={e => setRoutineName(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") onClose();
          }}
        >
          <option value="">Select routine</option>
          {routines.map(r => (
            <option key={r.id} value={r.name}>{r.name}</option>
          ))}
        </select>
        <button
          type="button"
          className="tag-quick-edit-apply"
          onClick={commit}
        >
          Apply
        </button>
      </div>
    );
  }

  return (
    <div
      ref={panelRef}
      className="tag-quick-edit"
      style={{ left: editor.x, top: editor.y, minWidth: 210 }}
      onPointerDown={e => e.stopPropagation()}
    >
      <div className="tag-quick-edit-head">
        <span>{node.type}</span>
        <button type="button" onClick={onClose}>x</button>
      </div>

      {/* Field A */}
      {!isClr && (
        <>
          <label className="tag-quick-edit-type"><span>{labelA}</span></label>
          <input
            autoFocus
            className="tag-quick-edit-input"
            value={fieldA}
            placeholder={hintA}
            onFocus={() => handleFocus("sourceA")}
            onChange={e => { setFieldA(e.target.value); setActiveSuggestionIndex(0); }}
            onKeyDown={e => handleOperandKey(e, "sourceA", sugA, setFieldA)}
          />
          {sugA.length > 0 && (
            <div className="tag-quick-edit-list">
              {sugA.map((t, i) => (
                <button
                  key={t.id}
                  className={i === activeSuggestionIndex ? "active" : ""}
                  type="button"
                  onMouseDown={e => { e.preventDefault(); setFieldA(t.name); setActiveField(null); }}
                >
                  <span>{t.name}</span><em>{t.dataType}</em>
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {/* Field B */}
      {(!isMathInst || isBinaryMath || isShiftInst || isCopyInst || isLimInst) && (
        <>
          <label className="tag-quick-edit-type" style={{ marginTop: 6 }}><span>{labelB}</span></label>
          <input
            className="tag-quick-edit-input"
            value={fieldB}
            placeholder={hintB}
            onFocus={() => handleFocus("sourceB")}
            onChange={e => { setFieldB(e.target.value); setActiveSuggestionIndex(0); }}
            onKeyDown={e => handleOperandKey(e, "sourceB", sugB, setFieldB)}
          />
          {sugB.length > 0 && (
            <div className="tag-quick-edit-list">
              {sugB.map((t, i) => (
                <button
                  key={t.id}
                  className={i === activeSuggestionIndex ? "active" : ""}
                  type="button"
                  onMouseDown={e => { e.preventDefault(); setFieldB(t.name); setActiveField(null); }}
                >
                  <span>{t.name}</span><em>{t.dataType}</em>
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {/* Destination field for math */}
      {isMathInst && (
        <>
          <label className="tag-quick-edit-type" style={{ marginTop: 6 }}><span>Destination</span></label>
          <input
            autoFocus={isClr}
            className="tag-quick-edit-input"
            value={fieldDest}
            placeholder="tag name"
            onFocus={() => handleFocus("dest")}
            onChange={e => { setFieldDest(e.target.value); setActiveSuggestionIndex(0); }}
            onKeyDown={e => handleOperandKey(e, "dest", sugDest, setFieldDest)}
          />
          {sugDest.length > 0 && (
            <div className="tag-quick-edit-list">
              {sugDest.map((t, i) => (
                <button
                  key={t.id}
                  className={i === activeSuggestionIndex ? "active" : ""}
                  type="button"
                  onMouseDown={e => { e.preventDefault(); setFieldDest(t.name); setActiveField(null); }}
                >
                  <span>{t.name}</span><em>{t.dataType}</em>
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {/* Mask field for MVM */}
      {isMVM && (
        <>
          <label className="tag-quick-edit-type" style={{ marginTop: 6 }}><span>Mask</span></label>
          <input
            className="tag-quick-edit-input"
            value={fieldMask}
            placeholder="0xFFFFFFFF or tag"
            onFocus={() => handleFocus("mask")}
            onChange={e => { setFieldMask(e.target.value); setActiveSuggestionIndex(0); }}
            onKeyDown={e => handleOperandKey(e, "mask", sugMask, setFieldMask)}
          />
          {sugMask.length > 0 && (
            <div className="tag-quick-edit-list">
              {sugMask.map((t, i) => (
                <button
                  key={t.id}
                  className={i === activeSuggestionIndex ? "active" : ""}
                  type="button"
                  onMouseDown={e => { e.preventDefault(); setFieldMask(t.name); setActiveField(null); }}
                >
                  <span>{t.name}</span><em>{t.dataType}</em>
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {/* Third field for LIM / copy / shift instructions */}
      {(isShiftInst || isCopyInst || isLimInst) && (
        <>
          <label className="tag-quick-edit-type" style={{ marginTop: 6 }}><span>{isLimInst ? "High Limit" : "Length"}</span></label>
          <input
            className="tag-quick-edit-input"
            value={fieldMask}
            placeholder={isLimInst ? "tag or literal" : isCopyInst ? "element count" : "bit count"}
            onFocus={() => handleFocus("mask")}
            onChange={e => { setFieldMask(e.target.value); setActiveSuggestionIndex(0); }}
            onKeyDown={e => handleOperandKey(e, "mask", sugMask, setFieldMask)}
          />
          {sugMask.length > 0 && (
            <div className="tag-quick-edit-list">
              {sugMask.map((t, i) => (
                <button
                  key={t.id}
                  className={i === activeSuggestionIndex ? "active" : ""}
                  type="button"
                  onMouseDown={e => { e.preventDefault(); setFieldMask(t.name); setActiveField(null); }}
                >
                  <span>{t.name}</span><em>{t.dataType}</em>
                </button>
              ))}
            </div>
          )}
        </>
      )}

      <button
        type="button"
        style={{
          margin: "6px 8px 4px",
          padding: "4px 10px",
          background: "var(--accent-blue-bg)",
          color: "var(--accent-blue)",
          border: "1px solid var(--accent-blue)",
          borderRadius: 3,
          fontSize: 11,
          cursor: "pointer",
          width: "calc(100% - 16px)",
        }}
        onClick={commit}
      >
        Apply
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rung comment editor  (double-click on rung body)
// ---------------------------------------------------------------------------

function RungCommentEditor({ editor, routineId, onClose }: {
  editor: TagEditorState;
  routineId: string;
  onClose: () => void;
}) {
  const { project, setRungComment } = useProjectStore();
  const panelRef  = useRef<HTMLDivElement>(null);
  const inputRef  = useRef<HTMLInputElement>(null);

  const routine = project.programs.flatMap(p => p.routines).find(r => r.id === routineId);
  const rung = routine?.rungs.find(r => r.id === editor.rungId);
  const [value, setValue] = useState(rung?.comment ?? "");

  useEffect(() => { inputRef.current?.focus(); inputRef.current?.select(); }, []);
  useEffect(() => {
    function handlePointerDown(e: PointerEvent) {
      if (!panelRef.current?.contains(e.target as Node)) { commit(); onClose(); }
    }
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [value, onClose]);

  function commit() {
    setRungComment(routineId, editor.rungId, value.trim());
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter")  { e.preventDefault(); commit(); onClose(); }
    if (e.key === "Escape") { e.preventDefault(); onClose(); }
  }

  return (
    <div
      ref={panelRef}
      className="tag-quick-edit"
      style={{ left: editor.x, top: editor.y, minWidth: 240 }}
      onPointerDown={e => e.stopPropagation()}
    >
      <div className="tag-quick-edit-head">
        <span>Rung Comment</span>
        <button type="button" onClick={onClose}>x</button>
      </div>
      <input
        ref={inputRef}
        className="tag-quick-edit-input"
        value={value}
        placeholder="Enter rung comment…"
        onChange={e => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
      />
      <div style={{ fontSize: 9, color: "var(--text-dim)", padding: "2px 8px 6px" }}>
        Enter to save · Esc to cancel
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Leg selection bar  (branch leg background clicked)
// ---------------------------------------------------------------------------

function LegBar({ rungId, branchId, legId, routineId }: {
  rungId: string; branchId: string; legId: string; routineId: string;
}) {
  void rungId;
  void branchId;
  void legId;
  void routineId;

  return (
    <div className="selection-bar">
      <span className="sel-type" style={{ color: "var(--text-dim)", fontSize: 10 }}>LEG</span>
      <span className="sel-hint" style={{ flex: 1 }}>
        Drag Add Leg from the toolbar onto this branch - Delete to remove this leg - Esc to deselect
      </span>
    </div>
  );
}
// ---------------------------------------------------------------------------
// Rung selection bar  (rung background clicked)
// ---------------------------------------------------------------------------

function RungBar({ rungId, routineId, canDelete }: {
  rungId: string; routineId: string; canDelete: boolean;
}) {
  const { deleteRung } = useProjectStore();
  const { clearSelection } = useEditorStore();

  function handleDelete() {
    if (!confirmDeleteRung()) return;
    deleteRung(routineId, rungId);
    clearSelection();
  }

  return (
    <div className="selection-bar">
      <span className="sel-type" style={{ color: "var(--text-dim)" }}>RUNG</span>
      <span className="sel-hint" style={{ flex: 1 }}>
        Double-click gutter to online edit - Double-click rung body for comment - Esc to deselect
      </span>
      {canDelete && (
        <button className="sel-delete-btn" onClick={handleDelete}>Delete Rung</button>
      )}
    </div>
  );
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function confirmDeleteRung(): boolean {
  return window.confirm("Delete this rung? This cannot be undone.");
}

function findNodeById(nodes: any[], id: string): any {
  for (const n of nodes) {
    if (n.id === id) return n;
    if (n.kind === "branch") for (const leg of n.legs) {
      const f = findNodeById(leg.nodes, id);
      if (f) return f;
    }
  }
  return null;
}

function resolveBranchTarget(rung: Rung, nodeId: string): string | null {
  const node = findNodeById(rung.nodes, nodeId);
  if (node?.kind === "branch") return node.id;
  return findContainingBranch(rung.nodes, nodeId)?.branchId ?? null;
}

function defaultDataTypeForInstruction(type: InstructionType | null): TagDataType {
  switch (type) {
    case "TON":
    case "TOF":
    case "RTO":
      return "TIMER";
    case "CTU":
    case "CTD":
      return "COUNTER";
    case "RES":
      return "TIMER";
    default:
      return "BOOL";
  }
}

function syncPixiBackground(app: Application | null, theme: "dark" | "light") {
  if (!app) return;
  const { hex, css } = getCanvasBackground(theme);
  const renderer = app.renderer as any;
  if (renderer.background) {
    renderer.background.color = hex;
    renderer.background.alpha = 0;
  }
  app.canvas.style.backgroundColor = css;
}

function readCssHexVar(el: HTMLElement | null, name: string, fallback: number): number {
  if (!el) return fallback;
  const raw = getComputedStyle(el).getPropertyValue(name).trim();
  if (/^#[0-9a-f]{6}$/i.test(raw)) return Number.parseInt(raw.slice(1), 16);
  if (/^#[0-9a-f]{3}$/i.test(raw)) {
    const [, r, g, b] = raw;
    return Number.parseInt(`${r}${r}${g}${g}${b}${b}`, 16);
  }
  return fallback;
}

function getCanvasBackground(theme: "dark" | "light") {
  return theme === "light"
    ? { hex: 0xf3f4f8, css: "#f3f4f8" }
    : { hex: 0x18181e, css: "#18181e" };
}

function getRendererColors(theme: "dark" | "light") {
  const shared = {
    wireOn: 0x22cc66,
    railOn: 0x22cc66,
    nodeOn: 0x22cc66,
    nodeSelected: 0x4a8cff,
    textBlue: 0x4a8cff,
    textYellow: 0xf0b429,
    textGreen: 0x22cc66,
    branchRailOn: 0x22cc66,
  };

  if (theme === "light") {
    return {
      ...shared,
      wireOff: 0x535b7a,
      rail: 0x4f5590,
      nodeBg: 0xffffff,
      nodeBorder: 0x68708f,
      nodeOnBg: 0xdbf8e8,
      textPrimary: 0x171927,
      textDim: 0x69708e,
      textYellow: 0x9a5a00,
      gutterBg: 0xe8eaf2,
      canvasBg: 0xf3f4f8,
      separator: 0xc3c7d6,
      branchRail: 0x535b7a,
    };
  }

  return {
    ...shared,
    wireOff: 0x64657a,
    rail: 0x6060a0,
    nodeBg: 0x28283a,
    nodeBorder: 0x3c3c58,
    nodeOnBg: 0x0a1f12,
    textPrimary: 0xe8e8f0,
    textDim: 0x6f7088,
    gutterBg: 0x1e1e26,
    canvasBg: 0x18181e,
    separator: 0x2e2e3a,
    branchRail: 0x4a4a5a,
  };
}

// ---------------------------------------------------------------------------
// Pure AST helpers â€” compute preview rungs without touching the store
// ---------------------------------------------------------------------------

/**
 * Return a new rung where the instruction adjacent to `branchId` has been
 * pulled inside `legId`.  Returns null if there is nothing to absorb.
 */
function computeAbsorbPreview(
  rung: Rung,
  branchId: string,
  legId: string,
  direction: "next" | "prev",
): Rung | null {
  try {
    const loc = locateNodeInRung(rung, branchId);
    if (!loc) return null;
    const targetIdx = direction === "next" ? loc.index + 1 : loc.index - 1;
    if (targetIdx < 0 || targetIdx >= loc.list.length) return null;

    const nodeToAbsorb = cloneNode(loc.list[targetIdx]);
    let updated = applyDelete(rung, { kind: "node", rungId: rung.id, nodeId: nodeToAbsorb.id });

    if (direction === "next") {
      updated = applyInsert(
        updated,
        { kind: "branch-leg-append", rungId: rung.id, branchId, legId },
        nodeToAbsorb,
      );
    } else {
      const branch = findNodeInSeries(updated.nodes, branchId);
      const leg = (branch as any)?.legs?.find((l: any) => l.id === legId);
      if (leg && leg.nodes.length > 0) {
        updated = applyInsert(
          updated,
          { kind: "branch-leg-before", rungId: rung.id, branchId, legId, siblingId: leg.nodes[0].id },
          nodeToAbsorb,
        );
      } else {
        updated = applyInsert(
          updated,
          { kind: "branch-leg-append", rungId: rung.id, branchId, legId },
          nodeToAbsorb,
        );
      }
    }
    return updated;
  } catch {
    return null;
  }
}

/**
 * Return a new rung where the first or last node of `legId` has been
 * ejected back into the parent series.  Returns null if the leg is empty.
 */
function computeEjectPreview(
  rung: Rung,
  branchId: string,
  legId: string,
  side: "first" | "last",
): Rung | null {
  try {
    const branchNode = findNodeInSeries(rung.nodes, branchId);
    if (!branchNode || !isBranch(branchNode)) return null;
    const leg = branchNode.legs.find(l => l.id === legId);
    if (!leg || leg.nodes.length === 0) return null;

    const ejected = cloneNode(side === "last" ? leg.nodes[leg.nodes.length - 1] : leg.nodes[0]);
    let updated = applyDelete(rung, { kind: "node", rungId: rung.id, nodeId: ejected.id });

    if (side === "last") {
      updated = applyInsert(updated, { kind: "series-after", rungId: rung.id, siblingId: branchId }, ejected);
    } else {
      updated = applyInsert(updated, { kind: "series-before", rungId: rung.id, siblingId: branchId }, ejected);
    }
    return updated;
  } catch {
    return null;
  }
}

/**
 * Return the id of the node immediately before or after `branchId` in
 * whatever series list (top-level or nested) contains the branch.
 */
function findAdjacentNodeId(
  nodes: any[],
  branchId: string,
  side: "left" | "right"
): string | null {
  // Recursive search through any series list
  function searchList(list: any[]): string | null {
    for (let i = 0; i < list.length; i++) {
      if (list[i].id === branchId) {
        const adj = side === "right" ? list[i + 1] : list[i - 1];
        return adj?.id ?? null;
      }
      if (list[i].kind === "branch") {
        for (const leg of list[i].legs) {
          const result = searchList(leg.nodes);
          if (result !== null) return result;
        }
      }
    }
    return null;
  }
  return searchList(nodes);
}
