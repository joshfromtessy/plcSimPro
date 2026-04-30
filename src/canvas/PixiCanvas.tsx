// =============================================================================
// PixiCanvas â€” React component that owns the Pixi Application
// =============================================================================

import { useEffect, useRef, useState } from "react";
import { Application } from "pixi.js";
import { useProjectStore } from "../store/projectStore";
import { useSimulationStore } from "../store/simulationStore";
import { useEditorStore } from "../store/editorStore";
import { LadderRenderer } from "./renderer";
import type { InstructionType, InsertPosition, Rung, TagDataType, TimerParams, CounterParams, CompareParams, MoveParams } from "../model/types";
import { isCoilOutput } from "../model/types";
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

export function PixiCanvas() {
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
    setInstructionParams,
    setNodeComment, setRungComment,
  } = useProjectStore();
  const { scanResult } = useSimulationStore();
  const { selection, drag, showNodeComments, showRungComments, toggleNodeComments, toggleRungComments } = useEditorStore();
  const [tagEditor, setTagEditor] = useState<TagEditorState | null>(null);
  const [complexEditor, setComplexEditor] = useState<TagEditorState | null>(null);
  const [compareMovEditor, setCompareMovEditor] = useState<TagEditorState | null>(null);
  const [rungCommentEditor, setRungCommentEditor] = useState<TagEditorState | null>(null);

  // Stores the current drag-over drop position â€” use a ref to avoid re-renders
  const dropTargetRef  = useRef<InsertPosition | null>(null);
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

  // Build a tag-value map for XIO/XIC colouring (updated every render)
  const tagValues = new Map<string, boolean>(
    project.tags.map(t => [t.name, Boolean(t.value)])
  );

  renderRef.current = () => {
    const lr  = rendererRef.current;
    const app = appRef.current;
    if (!lr || !app || !routine) return;
    syncPixiBackground(app, canvasRef.current);
    lr.setThemeColors(readRendererColors(canvasRef.current));
    lr.setTagData(project.tags);
    const w = canvasRef.current?.clientWidth ?? app.renderer.width;
    if (w === 0) return;
    const selectedNodeId = selection?.kind === "node" ? selection.nodeId : null;
    lr.setSelection(selectedNodeId);
    lr.setCommentVisibility(showNodeComments, showRungComments);

    // During a pointer rail drag, substitute the preview rung so the canvas
    // shows the branch live-resizing in real time (no store mutation yet).
    const preview = previewRungRef.current;
    const rungs = preview.size > 0
      ? routine.rungs.map(r => preview.get(r.id) ?? r)
      : routine.rungs;

    const { h: contentH, w: contentW } = lr.render(rungs, scanResult, w, tagValues);
    if (contentH > 0) {
      const newW = Math.max(w, contentW);
      app.renderer.resize(newW, contentH);
      // If content is wider than container, fix the pixel width; otherwise stay fluid
      app.canvas.style.width = newW > w ? `${newW}px` : "100%";
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
      background: readCssHexVar(container, "--bg-canvas", 0x18181e),
      antialias: true,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
      width:  container.clientWidth  || 800,
      height: container.clientHeight || 600,
    }).then(() => {
      container.appendChild(app.canvas);
      app.canvas.style.display = "block";
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
        const cur = useEditorStore.getState().selection;
        if (cur?.kind === "rung" && cur.rungId === rungId) {
          useEditorStore.getState().clearSelection();
        } else {
          useEditorStore.getState().setSelection({ kind: "rung", rungId });
        }
      };

      lr.onRungDelete = (rungId) => {
        const { activeRoutineId, deleteRung } = useProjectStore.getState();
        if (activeRoutineId) {
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

  // Theme changes arrive through CSS variables on the parent app root.
  useEffect(() => {
    syncPixiBackground(appRef.current, canvasRef.current);
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => renderRef.current());
  });

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
      if (!selection) return;
      const { activeRoutineId, project, deleteNode, deleteRung, setTagValue } = useProjectStore.getState();
      if (!activeRoutineId) return;

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
        deleteRung(activeRoutineId, selection.rungId);
        clearSelection();
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
        if (gutterRungId && !lr.hitTestRungDeleteButton(coords.x, coords.y)) {
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
    rendererRef.current?.clearExtendTarget();
    rendererRef.current?.clearRungDropLine();
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

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    const isRungMove    = e.dataTransfer.types.includes("application/plc-rung-move");
    const isNodeMove    = e.dataTransfer.types.includes("application/plc-move");
    const isRailExtend  = e.dataTransfer.types.includes("application/plc-rail-extend");
    const isBranchWrap  = e.dataTransfer.types.includes("application/plc-branch-wrap");
    const isAddLeg      = e.dataTransfer.types.includes("application/plc-add-leg");
    e.dataTransfer.dropEffect = (isRungMove || isNodeMove || isRailExtend) ? "move" : "copy";

    // ── Rung reorder ─────────────────────────────────────────────────────────
    if (isRungMove) {
      const coords = getCanvasCoords(e);
      if (coords) {
        const drop = rendererRef.current?.queryRungDropY(coords.y);
        if (drop) rendererRef.current?.showRungDropLine(drop.lineY);
      }
      rendererRef.current?.clearDropZone();
      rendererRef.current?.clearExtendTarget();
      return;
    }

    if (isRailExtend && railDragRef.current) {
      const { rungId, branchId, side } = railDragRef.current;
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
      return;
    }

    if (isBranchWrap) {
      const coords = getCanvasCoords(e);
      const hit = coords ? rendererRef.current?.hitTestNode(coords.x, coords.y) : null;
      const target = hit && routine
        ? findNodeById(routine.rungs.find(r => r.id === hit.rungId)?.nodes ?? [], hit.nodeId)
        : null;
      rendererRef.current?.clearDropZone();
      rendererRef.current?.clearExtendTarget();
      if (hit && target?.kind === "instruction" && !isCoilOutput(target.type)) {
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
      rendererRef.current?.clearDropZone();
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
    dropTargetRef.current = info?.position ?? null;
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
    rendererRef.current?.clearExtendTarget();
    rendererRef.current?.clearLegHover();
    rendererRef.current?.clearRungDropLine();
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    rendererRef.current?.clearDropZone();
    rendererRef.current?.clearExtendTarget();
    rendererRef.current?.clearRungDropLine();
    dragNodeRef.current = null;
    railDragRef.current = null;
    rungDragRef.current = null;
    if (canvasRef.current) canvasRef.current.draggable = false;

    if (!routine) return;

    // ── Rung reorder ─────────────────────────────────────────────────────────
    const rungMoveId = e.dataTransfer.getData("application/plc-rung-move");
    if (rungMoveId) {
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
      if (hit && target?.kind === "instruction" && !isCoilOutput(target.type)) {
        wrapNodeInBranch(routine.id, hit.rungId, hit.nodeId);
      }
      return;
    }

    // â”€â”€ Branch rail extend/shrink â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const railRaw = e.dataTransfer.getData("application/plc-rail-extend");
    if (railRaw) {
      const src: { rungId: string; branchId: string; side: "left" | "right" } = JSON.parse(railRaw);
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

    // â”€â”€ Moving an existing canvas node â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const moveRaw = e.dataTransfer.getData("application/plc-move");
    if (moveRaw) {
      const src: { rungId: string; nodeId: string } = JSON.parse(moveRaw);
      moveNode(routine.id, src.rungId, src.nodeId, position);
      dropTargetRef.current = null;
      return;
    }

    // â”€â”€ Inserting a new instruction from the palette â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (!type) return;
    dropTargetRef.current = null;
    insertInstruction(routine.id, position, type);
  }

  function handleDoubleClick(e: React.MouseEvent) {
    const coords = getCanvasCoords(e);
    if (!coords) return;
    const outerRect = outerRef.current?.getBoundingClientRect();
    const editorX = outerRect ? e.clientX - outerRect.left : e.clientX;
    const editorY = outerRect ? e.clientY - outerRect.top  : e.clientY;

    const hit = rendererRef.current?.hitTestNode(coords.x, coords.y);
    const rung = hit ? routine?.rungs.find(r => r.id === hit.rungId) : null;
    const node = hit && rung ? findNodeById(rung.nodes, hit.nodeId) : null;

    if (hit && node?.kind === "instruction") {
      const editorState: TagEditorState = { rungId: hit.rungId, nodeId: hit.nodeId, x: editorX, y: editorY };
      useEditorStore.getState().setSelection({ kind: "node", rungId: hit.rungId, nodeId: hit.nodeId });
      const isTimerCounter = ["TON","TOF","RTO","CTU","CTD"].includes(node.type);
      const isCompareMov   = ["EQU","NEQ","LES","LEQ","GRT","GEQ","MOV","MVM"].includes(node.type);
      if (isTimerCounter) {
        setComplexEditor(editorState);
        setTagEditor(null);
        setCompareMovEditor(null);
        setRungCommentEditor(null);
      } else if (isCompareMov) {
        setCompareMovEditor(editorState);
        setTagEditor(null);
        setComplexEditor(null);
        setRungCommentEditor(null);
      } else {
        setTagEditor(editorState);
        setComplexEditor(null);
        setCompareMovEditor(null);
        setRungCommentEditor(null);
      }
      return;
    }

    // No instruction hit — check for rung body (opens rung comment editor)
    const hitRungId = rendererRef.current?.hitTestRungBody(coords.x, coords.y);
    if (hitRungId) {
      setRungCommentEditor({ rungId: hitRungId, nodeId: "", x: editorX, y: editorY });
      setTagEditor(null);
      setComplexEditor(null);
    }
  }

  function handleAddRung() {
    if (!routine) return;
    addRung(routine.id);
  }

  // â”€â”€ Render â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (!routine) {
    return <div className="pixi-canvas-wrap pixi-canvas-wrap--empty">No routine selected</div>;
  }

  return (
    <div className="pixi-canvas-outer" ref={outerRef}>
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
        className="pixi-canvas-wrap"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerLeave={handlePointerLeave}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onDoubleClick={handleDoubleClick}
      >
        {routine.rungs.length === 0 && (
          <div className="pixi-empty-hint">
            Click <strong>+ Rung</strong> to add a rung
          </div>
        )}
      </div>

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

      {selection?.kind === "leg" && (
        <LegBar
          rungId={selection.rungId}
          branchId={selection.branchId}
          legId={selection.legId}
          routineId={routine.id}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pointer tag editor
// ---------------------------------------------------------------------------

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

const COMPARE_MOVE_TYPES = new Set(["EQU","NEQ","LES","LEQ","GRT","GEQ","MOV","MVM"]);

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

  const isMovInst = node.type === "MOV" || node.type === "MVM";
  const isMVM     = node.type === "MVM";
  const cp = node.params as CompareParams;
  const mp = node.params as MoveParams;

  const [fieldA, setFieldA] = useState(isMovInst ? (mp.source ?? "") : (cp.sourceA ?? ""));
  const [fieldB, setFieldB] = useState(isMovInst ? (mp.dest   ?? "") : (cp.sourceB ?? ""));
  const [fieldMask, setFieldMask] = useState(isMVM ? ((node.params as MoveParams).mask ?? "0xFFFFFFFF") : "");

  // All numeric tags for autocomplete
  const numericTags = project.tags.filter(t =>
    t.dataType === "DINT" || t.dataType === "INT" || t.dataType === "REAL" || t.dataType === "BOOL"
  );

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
    if (!lower) return numericTags.slice(0, 6);
    return numericTags
      .filter(t => t.name.toLowerCase().includes(lower))
      .slice(0, 6);
  }

  function commit() {
    const a = fieldA.trim();
    const b = fieldB.trim();
    const mask = fieldMask.trim();

    if (isMovInst) {
      // Auto-create dest tag if it looks like a tag name and doesn't exist
      const destIsLiteral = !isNaN(Number(b)) || /^0x/i.test(b);
      if (!destIsLiteral && b && !project.tags.find(t => t.name === b)) {
        addTag(b, "DINT");
      }
      const patch: Partial<MoveParams> = { source: a, dest: b };
      if (isMVM) patch.mask = mask || "0xFFFFFFFF";
      setInstructionParams(routineId, editor.rungId, editor.nodeId, patch as any);
    } else {
      setInstructionParams(routineId, editor.rungId, editor.nodeId,
        { sourceA: a, sourceB: b } as any);
    }
    onClose();
  }

  function handleKey(e: React.KeyboardEvent) {
    if (e.key === "Escape") { e.preventDefault(); onClose(); }
    if (e.key === "Enter")  { e.preventDefault(); commit(); }
  }

  const labelA = isMovInst ? "Source"      : "Source A";
  const labelB = isMovInst ? "Destination" : "Source B";
  const hintA  = isMovInst ? "tag or literal" : "tag or literal";
  const hintB  = isMovInst ? "tag name"        : "tag or literal";

  const sugA = suggestionsFor(fieldA);
  const sugB = suggestionsFor(fieldB);

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
      <label className="tag-quick-edit-type"><span>{labelA}</span></label>
      <input
        autoFocus
        className="tag-quick-edit-input"
        value={fieldA}
        placeholder={hintA}
        onChange={e => setFieldA(e.target.value)}
        onKeyDown={handleKey}
      />
      {sugA.length > 0 && (
        <div className="tag-quick-edit-list">
          {sugA.map(t => (
            <button key={t.id} type="button" onClick={() => setFieldA(t.name)}>
              <span>{t.name}</span><em>{t.dataType}</em>
            </button>
          ))}
        </div>
      )}

      {/* Field B */}
      <label className="tag-quick-edit-type" style={{ marginTop: 6 }}><span>{labelB}</span></label>
      <input
        className="tag-quick-edit-input"
        value={fieldB}
        placeholder={hintB}
        onChange={e => setFieldB(e.target.value)}
        onKeyDown={handleKey}
      />
      {sugB.length > 0 && (
        <div className="tag-quick-edit-list">
          {sugB.map(t => (
            <button key={t.id} type="button" onClick={() => setFieldB(t.name)}>
              <span>{t.name}</span><em>{t.dataType}</em>
            </button>
          ))}
        </div>
      )}

      {/* Mask field for MVM */}
      {isMVM && (
        <>
          <label className="tag-quick-edit-type" style={{ marginTop: 6 }}><span>Mask</span></label>
          <input
            className="tag-quick-edit-input"
            value={fieldMask}
            placeholder="0xFFFFFFFF or tag"
            onChange={e => setFieldMask(e.target.value)}
            onKeyDown={handleKey}
          />
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

/*
function RungBar({ rungId, routineId, canDelete }: {
  rungId: string; routineId: string; canDelete: boolean;
}) {
  const { deleteRung } = useProjectStore();
  const { clearSelection } = useEditorStore();

  function handleDelete() {
    deleteRung(routineId, rungId);
    clearSelection();
  }

  return (
    <div className="selection-bar">
      <span className="sel-type" style={{ color: "var(--text-dim)" }}>RUNG</span>
      <span className="sel-hint" style={{ flex: 1 }}>
        Click a node to edit Â· Esc to deselect
      </span>
      {canDelete && (
        <button className="sel-delete-btn" onClick={handleDelete}>Delete Rung</button>
      )}
    </div>
  );
}

*/
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function syncPixiBackground(app: Application | null, el: HTMLElement | null) {
  if (!app) return;
  const color = readCssHexVar(el, "--bg-canvas", 0x18181e);
  const renderer = app.renderer as any;
  if (renderer.background) {
    renderer.background.color = color;
    renderer.background.alpha = 1;
  }
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

function readRendererColors(el: HTMLElement | null) {
  return {
    wireOff: readCssHexVar(el, "--wire-inactive", 0x4a4a5a),
    wireOn: readCssHexVar(el, "--wire-powered", 0x22cc66),
    rail: readCssHexVar(el, "--wire-rail", 0x5858a0),
    railOn: readCssHexVar(el, "--wire-powered", 0x22cc66),
    nodeBg: readCssHexVar(el, "--node-bg", 0x1e1e2a),
    nodeBorder: readCssHexVar(el, "--node-border", 0x3a3a56),
    nodeOn: readCssHexVar(el, "--node-powered", 0x22cc66),
    nodeOnBg: readCssHexVar(el, "--node-powered-bg", 0x0a1f12),
    nodeSelected: readCssHexVar(el, "--node-selected", 0x4a8cff),
    textPrimary: readCssHexVar(el, "--text-primary", 0xe8e8f0),
    textBlue: readCssHexVar(el, "--accent-blue", 0x6a9eff),
    textYellow: readCssHexVar(el, "--accent-yellow", 0xf0b429),
    textGreen: readCssHexVar(el, "--accent-green", 0x22cc66),
    textDim: readCssHexVar(el, "--text-dim", 0x707088),
    gutterBg: readCssHexVar(el, "--bg-panel-alt", 0x11111a),
    canvasBg: readCssHexVar(el, "--bg-canvas", 0x18181e),
    separator: readCssHexVar(el, "--border", 0x26263a),
    branchRail: readCssHexVar(el, "--wire-inactive", 0x4a4a5a),
    branchRailOn: readCssHexVar(el, "--wire-powered", 0x22cc66),
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
