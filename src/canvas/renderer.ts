// =============================================================================
// PixiJS Renderer
// =============================================================================

import {
  Application,
  Container,
  Graphics,
  Text,
  TextStyle,
  Rectangle,
} from "pixi.js";

import type { Rung, SeriesNode, InstructionNode, InsertPosition, RungPowerState, InstructionType, TagDefinition, TimerParams, CounterParams, CompareParams, MoveParams, MathParams, JsrParams } from "../model/types";
import { isCoilOutput, isOutput } from "../model/types";
import { isInstruction, isBranch } from "../model/ast";
import {
  layoutRung,
  isLayoutInstruction,
  isLayoutBranch,
  hitTest,
  RAIL_W,
  INST_H,
  BRANCH_RAIL_W,
  BAND_FOLD_H,
  COMMENT_H,
  RUNG_COMMENT_H,
  type HitResult,
  type LayoutRung,
  type LayoutBand,
  type LayoutNode,
  type LayoutBranch,
  type LayoutLeg,
  type LayoutInstruction,
} from "./layout";

// ---------------------------------------------------------------------------
// Theme colours
// ---------------------------------------------------------------------------

const C = {
  wireOff:       0x64657a,
  wireOn:        0x22cc66,
  rail:          0x5858a0,
  railOn:        0x22cc66,
  nodeBg:        0x1e1e2a,
  nodeBorder:    0x3a3a56,
  nodeOn:        0x22cc66,
  nodeOnBg:      0x0a1f12,
  nodeSelected:  0x4a8cff,
  textPrimary:   0xe8e8f0,
  textBlue:      0x6a9eff,
  textYellow:    0xf0b429,
  textGreen:     0x22cc66,
  textDim:       0x707088,
  gutterBg:      0x11111a,
  canvasBg:      0x18181e,
  separator:     0x26263a,
  branchRail:    0x64657a,
  branchRailOn:  0x22cc66,
};

type RendererColors = Partial<typeof C>;

// ---------------------------------------------------------------------------
// Text styles
// ---------------------------------------------------------------------------

const STYLE_TAG = new TextStyle({
  fontFamily: "Consolas, monospace",
  fontSize: 11,
  fill: C.textDim,
});

const STYLE_TAG_ON = new TextStyle({
  fontFamily: "Consolas, monospace",
  fontSize: 11,
  fill: C.textGreen,
});

const STYLE_MNEMONIC = new TextStyle({
  fontFamily: "Consolas, monospace",
  fontSize: 10,
  fill: C.textBlue,
  letterSpacing: 0.5,
});

const STYLE_MNEMONIC_OUT = new TextStyle({
  fontFamily: "Consolas, monospace",
  fontSize: 10,
  fill: C.textYellow,
  letterSpacing: 0.5,
});

const STYLE_MNEMONIC_ON = new TextStyle({
  fontFamily: "Consolas, monospace",
  fontSize: 10,
  fill: C.textGreen,
  letterSpacing: 0.5,
});

const STYLE_RUNG_NUM = new TextStyle({
  fontFamily: "Consolas, monospace",
  fontSize: 11,
  fill: C.textDim,
});

// ---------------------------------------------------------------------------
// Per-rung rendered container
// ---------------------------------------------------------------------------

export interface RenderedRung {
  rungId: string;
  container: Container;
  layout: LayoutRung;
  dirty: boolean;
}

interface VisualRung {
  key: string;
  rung: Rung;
  sourceRungId: string;
  rungNumber: number;
  readOnly: boolean;
  label?: "LIVE" | "EDIT";
}

type KeyboardNavTarget =
  | { kind: "node"; rungId: string; nodeId: string }
  | { kind: "rung"; rungId: string }
  | null;

interface NavNode {
  rungId: string;
  nodeId: string;
  cx: number;
  cy: number;
  order: number;
}

// ---------------------------------------------------------------------------
// Main renderer class
// ---------------------------------------------------------------------------

export class LadderRenderer {
  app: Application;
  private _stage: Container;
  private _bgContainer: Container;
  private _rungs: Map<string, RenderedRung> = new Map();
  private _selectedNodeId: string | null = null;
  private _selectedRungId: string | null = null;

  onNodeClick?:   (rungId: string, nodeId: string, legId?: string) => void;
  onRungClick?:   (rungId: string) => void;
  onRungDelete?:  (rungId: string) => void;

  /** Current tag values — used for XIO/XIC state colouring */
  private _tagValues: Map<string, boolean> = new Map();
  /** Full tag data — used for timer/counter accum display */
  private _tagDataMap: Map<string, TagDefinition> = new Map();

  private _showNodeComments = false;
  private _showRungComments = true;
  /** Local x of the right power rail (relative to any rung container).
   *  Set in render() pass-1 so _drawMainWire can extend every wire to the rail. */
  private _rightRailLocalX = 0;

  /** Layout data kept after each render so drag-drop can query positions */
  private _rungLayoutData: Array<{
    rungId: string;
    y: number;
    h: number;
    layout: LayoutRung;
    /** AST nodes — used to check whether the rung has an output coil */
    nodes: SeriesNode[];
  }> = [];

  /** Overlay graphics for drag-drop insertion indicator */
  private _dropGfx: Graphics;
  /** Overlay graphics for all possible insertion anchors during drag. */
  private _dropDotsGfx: Graphics;
  /** Overlay graphics for branch-extend preview (teal box around absorbed node) */
  private _extendGfx: Graphics;
  /** Overlay graphics for live branch-resize preview tint */
  private _previewGfx: Graphics;
  /** Overlay graphics for leg hover highlight */
  private _hoverGfx: Graphics;
  /** Overlay graphics for rail hover highlight */
  private _railHoverGfx: Graphics;
  /** Overlay graphics for rung reorder drop indicator */
  private _rungDropGfx: Graphics;

  readonly RUNG_NUMBER_W = 44;

  constructor(app: Application) {
    this.app = app;
    this._stage = new Container();
    app.stage.addChild(this._stage);

    // Background layer sits below all rung containers
    this._bgContainer = new Container();
    this._stage.addChild(this._bgContainer);

    // Drop zone overlay — added last so it renders on top
    this._dropGfx = new Graphics();
    this._dropGfx.eventMode = "none";
    this._stage.addChild(this._dropGfx);

    this._dropDotsGfx = new Graphics();
    this._dropDotsGfx.eventMode = "none";
    this._stage.addChild(this._dropDotsGfx);

    // Branch-extend preview overlay (teal box around the node that would be absorbed)
    this._extendGfx = new Graphics();
    this._extendGfx.eventMode = "none";
    this._stage.addChild(this._extendGfx);

    // Live branch-resize preview tint — sits on top of everything
    this._previewGfx = new Graphics();
    this._previewGfx.eventMode = "none";
    this._stage.addChild(this._previewGfx);

    // Leg hover highlight
    this._hoverGfx = new Graphics();
    this._hoverGfx.eventMode = "none";
    this._stage.addChild(this._hoverGfx);

    // Rail hover highlight
    this._railHoverGfx = new Graphics();
    this._railHoverGfx.eventMode = "none";
    this._stage.addChild(this._railHoverGfx);

    // Rung reorder drop indicator
    this._rungDropGfx = new Graphics();
    this._rungDropGfx.eventMode = "none";
    this._stage.addChild(this._rungDropGfx);
  }

  // ── Public API ────────────────────────────────────────────────────────────

  setSelection(nodeId: string | null, rungId: string | null = null) {
    this._selectedNodeId = nodeId;
    this._selectedRungId = rungId;
  }

  setTagData(tags: TagDefinition[]) {
    this._tagDataMap = new Map(tags.map(t => [t.name, t]));
  }

  /**
   * Resolve the TagDefinition for a tag reference that may use structured
   * notation: "Base[n].bit", "Base[n]", "Base.bit", "Base.MEMBER".
   * Always returns the *base* tag so callers can read description, timerData, etc.
   */
  private _resolveTag(tagName: string): TagDefinition | undefined {
    // Direct lookup first (covers plain BOOL, TIMER, COUNTER names)
    const direct = this._tagDataMap.get(tagName);
    if (direct) return direct;
    // Strip array index and/or dot suffix to get base name
    const base = tagName.replace(/\[\d+\]/, "").replace(/\.\w+$/, "");
    return base !== tagName ? this._tagDataMap.get(base) : undefined;
  }

  private _parseTagRef(name: string): { base: string; idx?: number; bit?: number; member?: string } {
    const arrayBitRe = /^([A-Za-z_]\w*)\[(\d+)\]\.(\w+)$/;
    const arrayRe    = /^([A-Za-z_]\w*)\[(\d+)\]$/;
    const dotRe      = /^([A-Za-z_]\w*)\.(\w+)$/;
    let m: RegExpMatchArray | null;
    if ((m = name.match(arrayBitRe))) {
      const suffix = m[3];
      const bitNum = parseInt(suffix, 10);
      return isNaN(bitNum)
        ? { base: m[1], idx: parseInt(m[2], 10), member: suffix.toUpperCase() }
        : { base: m[1], idx: parseInt(m[2], 10), bit: bitNum };
    }
    if ((m = name.match(arrayRe))) return { base: m[1], idx: parseInt(m[2], 10) };
    if ((m = name.match(dotRe))) {
      const suffix = m[2];
      const bitNum = parseInt(suffix, 10);
      return isNaN(bitNum) ? { base: m[1], member: suffix.toUpperCase() } : { base: m[1], bit: bitNum };
    }
    return { base: name };
  }

  private _readNumericValue(refName: string): number | null {
    if (!refName) return null;
    if (/^0x[0-9a-fA-F]+$/i.test(refName)) return parseInt(refName, 16);
    const literal = Number(refName);
    if (!isNaN(literal)) return literal;

    const ref = this._parseTagRef(refName);
    const tag = this._tagDataMap.get(ref.base);
    if (!tag) return null;

    if (tag.dataType === "BOOL") return tag.value ? 1 : 0;
    if (tag.dataType === "REAL") return tag.value as number;
    if (tag.dataType === "DINT" || tag.dataType === "INT") {
      const raw = Array.isArray(tag.value)
        ? ((tag.value as number[])[ref.idx ?? 0] ?? 0)
        : (tag.value as number);
      return ref.bit !== undefined ? ((raw >> ref.bit) & 1) : raw;
    }
    if (tag.dataType === "TIMER" && tag.timerData && ref.member) {
      const td = tag.timerData;
      if (ref.member === "PRE") return td.preset;
      if (ref.member === "ACC") return td.accum;
      if (ref.member === "EN") return td.en ? 1 : 0;
      if (ref.member === "TT") return td.tt ? 1 : 0;
      if (ref.member === "DN") return td.dn ? 1 : 0;
    }
    if (tag.dataType === "COUNTER" && tag.counterData && ref.member) {
      const cd = tag.counterData;
      if (ref.member === "PRE") return cd.preset;
      if (ref.member === "ACC") return cd.accum;
      if (ref.member === "CU") return cd.cu ? 1 : 0;
      if (ref.member === "CD") return cd.cd ? 1 : 0;
      if (ref.member === "DN") return cd.dn ? 1 : 0;
      if (ref.member === "OV") return cd.ov ? 1 : 0;
      if (ref.member === "UN") return cd.un ? 1 : 0;
    }
    return null;
  }

  private _formatLiveValue(refName: string): string {
    const trimmed = refName.trim();
    if (/^0x[0-9a-fA-F]+$/i.test(trimmed) || /^[-+]?\d+(\.\d+)?$/.test(trimmed)) return "";
    const value = this._readNumericValue(refName);
    if (value === null) return "";
    return Number.isInteger(value) ? String(value) : String(+value.toFixed(3));
  }

  private _readBooleanValue(refName: string): boolean | null {
    const value = this._readNumericValue(refName);
    return value === null ? null : value !== 0;
  }

  setThemeColors(colors: RendererColors) {
    Object.assign(C, colors);
    (STYLE_TAG as any).fill = C.textDim;
    (STYLE_TAG_ON as any).fill = C.textGreen;
    (STYLE_MNEMONIC as any).fill = C.textBlue;
    (STYLE_MNEMONIC_OUT as any).fill = C.textYellow;
    (STYLE_MNEMONIC_ON as any).fill = C.textGreen;
    (STYLE_RUNG_NUM as any).fill = C.textDim;
  }

  setCommentVisibility(showNode: boolean, showRung: boolean) {
    this._showNodeComments = showNode;
    this._showRungComments = showRung;
  }

  /** Returns the rungId at the given canvas coordinate, or null (ignores gutter). */
  hitTestRungBody(cx: number, cy: number): string | null {
    if (cx < this.RUNG_NUMBER_W) return null;
    for (const rd of this._rungLayoutData) {
      if (cy >= rd.y && cy < rd.y + rd.h) return rd.rungId;
    }
    return null;
  }

  render(
    rungs: Rung[],
    powerStates: Map<string, RungPowerState>,
    canvasW: number,
    tagValues: Map<string, boolean> = new Map(),
    canvasH = 0
  ): { h: number; w: number } {
    this.app.stage.position.set(0, 0);
    this.app.stage.scale.set(1, 1);
    this._stage.position.set(0, 0);
    this._stage.scale.set(1, 1);

    this._tagValues = tagValues;
    const visualRungs = this._buildVisualRungs(rungs);
    // Remove stale rungs
    const currentIds = new Set(visualRungs.map(r => r.key));
    for (const [id, rr] of this._rungs) {
      if (!currentIds.has(id)) {
        this._stage.removeChild(rr.container);
        rr.container.destroy({ children: true });
        this._rungs.delete(id);
      }
    }

    const bodyW = canvasW - this.RUNG_NUMBER_W;
    const separatorYs: number[] = [];
    this._rungLayoutData = [];

    // ── Pass 1: compute all layouts so we know maxSeriesEndX before drawing ──
    // This is necessary so every rung's wire can extend all the way to the right
    // power rail, even when that rung is narrower than the widest rung.
    const rungLayouts: LayoutRung[] = visualRungs.map(visual =>
      layoutRung(visual.rung, bodyW, {
        showNodeComments: this._showNodeComments,
        showRungComments: this._showRungComments,
      })
    );
    let maxSeriesEndX = 0;
    for (const layout of rungLayouts) {
      if (layout.seriesEndX > maxSeriesEndX) maxSeriesEndX = layout.seriesEndX;
    }
    // Store as instance var so _drawMainWire can reference it without extra params.
    this._rightRailLocalX = maxSeriesEndX + 4;

    // ── Pass 2: position containers and draw ─────────────────────────────────
    let curY = 0;
    for (let ri = 0; ri < visualRungs.length; ri++) {
      const visual = visualRungs[ri];
      const rung   = visual.rung;
      const layout = rungLayouts[ri];
      const power  = visual.label === "EDIT" ? null : powerStates.get(visual.sourceRungId);
      if (!visual.readOnly) {
        this._rungLayoutData.push({ rungId: visual.sourceRungId, y: curY, h: layout.totalH, layout, nodes: rung.nodes });
      }

      let rr = this._rungs.get(visual.key);
      if (!rr) {
        const container = new Container();
        container.eventMode = "static";
        container.cursor = "pointer";
        this._stage.addChild(container);
        rr = { rungId: visual.key, container, layout, dirty: true };
        this._rungs.set(visual.key, rr);
      }

      rr.container.position.set(this.RUNG_NUMBER_W, curY);
      rr.layout = layout;
      this._drawRung(rr, rung, layout, power ?? null, visual.rungNumber, {
        readOnly: visual.readOnly,
        sourceRungId: visual.sourceRungId,
        label: visual.label,
      });

      curY += layout.totalH;
      if (ri < visualRungs.length - 1) separatorYs.push(curY);
    }

    const totalH = curY;

    // Right rail sits after the widest rung's content (+ small gap for the wire stub)
    const rightRailX = visualRungs.length > 0
      ? this.RUNG_NUMBER_W + maxSeriesEndX + 4
      : canvasW - 22;
    const contentW = rightRailX + RAIL_W + 8;

    const contentH = Math.max(totalH + 8, canvasH);
    this._drawBackground(totalH, contentH, rightRailX, separatorYs, canvasW);

    // Keep overlays on top of all rung containers (addChild re-orders to end).
    this._stage.addChild(this._dropDotsGfx);
    this._stage.addChild(this._dropGfx);
    this._stage.addChild(this._extendGfx);
    this._stage.addChild(this._hoverGfx);
    this._stage.addChild(this._railHoverGfx);
    this._stage.addChild(this._previewGfx);
    this._stage.addChild(this._rungDropGfx);

    return { h: contentH, w: contentW };
  }

  private _buildVisualRungs(rungs: Rung[]): VisualRung[] {
    const rows: VisualRung[] = [];
    for (let i = 0; i < rungs.length; i++) {
      const rung = rungs[i];
      const rungNumber = i + 1;
      if (rung.onlineEditStatus && rung.onlineEditOriginal) {
        const liveRung: Rung = {
          ...rung,
          comment: rung.onlineEditOriginal.comment,
          nodes: rung.onlineEditOriginal.nodes,
          disabled: rung.onlineEditOriginal.disabled,
          onlineEditStatus: undefined,
          onlineEditOriginal: undefined,
        };
        rows.push({
          key: `${rung.id}:live`,
          rung: liveRung,
          sourceRungId: rung.id,
          rungNumber,
          readOnly: true,
          label: "LIVE",
        });
        rows.push({
          key: `${rung.id}:edit`,
          rung,
          sourceRungId: rung.id,
          rungNumber,
          readOnly: false,
          label: "EDIT",
        });
      } else {
        rows.push({
          key: rung.id,
          rung,
          sourceRungId: rung.id,
          rungNumber,
          readOnly: false,
        });
      }
    }
    return rows;
  }

  // ── Background (rails, gutter, separators) ────────────────────────────────

  private _drawBackground(
    totalH: number,
    backgroundH: number,
    rightRailX: number,
    separatorYs: number[],
    canvasW: number
  ) {
    this._bgContainer.removeChildren().forEach(c => c.destroy({ children: true }));

    const g = new Graphics();
    this._bgContainer.addChild(g);
    const backgroundW = Math.max(canvasW, rightRailX + RAIL_W + 8);

    g.rect(0, 0, backgroundW, backgroundH).fill({ color: C.canvasBg });
    if (totalH === 0) return;

    // Gutter
    g.rect(0, 0, this.RUNG_NUMBER_W, totalH).fill({ color: C.gutterBg });
    g.moveTo(this.RUNG_NUMBER_W - 1, 0)
      .lineTo(this.RUNG_NUMBER_W - 1, totalH)
      .stroke({ color: C.separator, width: 1 });

    // Left power rail
    g.rect(this.RUNG_NUMBER_W, 0, RAIL_W, totalH).fill({ color: C.rail });

    // Right power rail
    g.rect(rightRailX, 0, RAIL_W, totalH).fill({ color: C.rail });

    // Rung separators
    for (const y of separatorYs) {
      g.moveTo(this.RUNG_NUMBER_W, y)
        .lineTo(rightRailX + RAIL_W, y)
        .stroke({ color: C.separator, width: 1 });
    }
  }

  // ── Rung ─────────────────────────────────────────────────────────────────

  private _drawRung(
    rr: RenderedRung,
    rung: Rung,
    layout: LayoutRung,
    power: RungPowerState | null,
    rungNumber: number,
    opts: { readOnly?: boolean; sourceRungId?: string; label?: "LIVE" | "EDIT" } = {}
  ) {
    // Clear children and listeners — listeners stack up across re-renders otherwise
    rr.container.removeChildren().forEach(c => c.destroy({ children: true }));
    rr.container.removeAllListeners();

    // Hit area must include the gutter (negative x in container space, because the
    // container is offset right by RUNG_NUMBER_W). Without this, clicks on the ×
    // button never reach the container at all.
    rr.container.hitArea = new Rectangle(
      -this.RUNG_NUMBER_W,
      0,
      layout.seriesEndX + RAIL_W + 20 + this.RUNG_NUMBER_W,
      layout.totalH
    );

    const g = new Graphics();
    rr.container.addChild(g);
    const sourceRungId = opts.sourceRungId ?? rung.id;
    const readOnly = !!opts.readOnly;

    const rungSelected = !readOnly && this._selectedRungId === sourceRungId;
    if (rungSelected) {
      g.rect(-this.RUNG_NUMBER_W, 0, this.RUNG_NUMBER_W, layout.totalH)
        .fill({ color: C.nodeSelected, alpha: 0.12 });
      g.rect(-this.RUNG_NUMBER_W, 0, 4, layout.totalH)
        .fill({ color: C.nodeSelected, alpha: 0.95 });
    }

    if (opts.label || rung.onlineEditStatus) {
      const color = opts.label === "LIVE"
        ? 0x6a9eff
        : rung.onlineEditStatus === "pending-delete"
          ? 0xff4455
          : 0xf0b429;
      g.rect(0, 0, Math.max(layout.seriesEndX, this._rightRailLocalX), layout.totalH)
        .fill({ color, alpha: opts.label === "LIVE" ? 0.035 : 0.045 });
      const label = new Text({
        text: opts.label ?? (rung.onlineEditStatus === "pending-delete" ? "PENDING DELETE" : "ONLINE EDIT"),
        style: new TextStyle({
          fontFamily: "Consolas, monospace",
          fontSize: 10,
          fontWeight: "700",
          fill: color,
          letterSpacing: 0.4,
        }),
      });
      label.anchor.set(0, 0);
      label.position.set(RAIL_W + 10, 5);
      rr.container.addChild(label);
    }

    // Main horizontal wire
    this._drawMainWire(g, layout, rung.nodes, power);

    // Nodes (or empty hint)
    if (rung.nodes.length === 0 && !readOnly) {
      for (let dx = RAIL_W + 8; dx < layout.seriesEndX; dx += 12) {
        g.moveTo(dx, layout.wireY)
          .lineTo(Math.min(dx + 7, layout.seriesEndX), layout.wireY)
          .stroke({ color: C.separator, width: 2 });
      }
      const hint = new Text({
        text: "← drag instruction here",
        style: new TextStyle({
          fontSize: 12, fill: C.textPrimary,
          fontFamily: "Consolas, monospace", fontStyle: "italic",
        }),
      });
      hint.anchor.set(0, 0.5);
      hint.position.set(RAIL_W + 16, layout.wireY);
      rr.container.addChild(hint);
    }

    for (let i = 0; i < layout.nodes.length; i++) {
      // inputPowered = power that has arrived at this node's left terminal.
      // First node: always energised from the left rail while scan data exists.
      // Subsequent nodes: energised only if the previous node passed power through.
      const inputPowered = i === 0
        ? power !== null
        : this._wireBetweenPw(power, rung.nodes, layout.nodes[i - 1], layout.nodes[i]);
      const visualOutPowered = i < layout.nodes.length - 1
        ? this._wireBetweenPw(power, rung.nodes, layout.nodes[i], layout.nodes[i + 1])
        : undefined;
      this._drawNode(g, rr.container, layout.nodes[i], rung, power, inputPowered, visualOutPowered, readOnly);
    }

    // Fold-wrap continuation arrows (no-op for single-band rungs)
    this._drawBandFolds(g, layout);

    if (!readOnly) {
      // Body click handler — hit-test nodes, fall back to rung selection
      rr.container.on("pointerdown", (e) => {
        const local = rr.container.toLocal(e.global);
        const hit = hitTest(layout.nodes, local.x, local.y);
        if (hit) {
          this.onNodeClick?.(sourceRungId, hit.nodeId, hit.legId);
        } else {
          this.onRungClick?.(sourceRungId);
        }
      });
    }

    // ── Gutter: rung number / drag handle ──────────────────────────────────
    const gutterCtr = new Container();
    gutterCtr.eventMode = "static";
    gutterCtr.cursor = readOnly ? "default" : "grab";
    gutterCtr.hitArea = new Rectangle(
      -this.RUNG_NUMBER_W, 0, this.RUNG_NUMBER_W - 2, layout.totalH
    );
    gutterCtr.on("pointerdown", (e) => {
      e.stopPropagation();
      if (readOnly) return;
      this.onRungClick?.(sourceRungId);
      // Drag-start is handled by PixiCanvas's DOM-level handlePointerDown.
    });
    rr.container.addChild(gutterCtr);

    // Rung number
    const numText = new Text({
      text: opts.label === "LIVE" ? `${rungNumber}L` : opts.label === "EDIT" ? `${rungNumber}E` : String(rungNumber),
      style: rungSelected
        ? new TextStyle({
            fontFamily: "Consolas, monospace",
            fontSize: 11,
            fontWeight: "700",
            fill: C.textBlue,
          })
        : STYLE_RUNG_NUM,
    });
    numText.anchor.set(1, 0.5);
    numText.position.set(-14, layout.wireY);
    gutterCtr.addChild(numText);

    // ── Rung comment bar ──────────────────────────────────────────────────────
    if (this._showRungComments && rung.comment) {
      const caH = layout.commentAreaH; // = RUNG_COMMENT_H or 0 (shouldn't be 0 here)
      if (caH > 0) {
        // Faint bar background
        g.rect(0, 0, layout.seriesEndX + RAIL_W + 20, caH)
          .fill({ color: C.gutterBg });
        g.moveTo(0, caH).lineTo(layout.seriesEndX + RAIL_W + 20, caH)
          .stroke({ color: C.separator, width: 1 });

        const cmt = new Text({
          text: "// " + rung.comment,
          style: new TextStyle({
            fontSize: 9,
            fill: C.textDim,
            fontFamily: "Consolas, monospace",
            fontStyle: "italic",
          }),
        });
        cmt.anchor.set(0, 0.5);
        cmt.position.set(RAIL_W + 6, caH / 2);
        rr.container.addChild(cmt);
      }
    }
  }

  // ── Wire drawing ──────────────────────────────────────────────────────────

  private _drawMainWire(
    g: Graphics,
    layout: LayoutRung,
    nodes: SeriesNode[],
    power: RungPowerState | null
  ) {
    // ── Multi-band: draw per-band wire segments ──────────────────────────────
    if (layout.bands) {
      for (let bi = 0; bi < layout.bands.length; bi++) {
        const band      = layout.bands[bi];
        const isFirst   = bi === 0;
        const isLast    = bi === layout.bands.length - 1;
        const wireY     = band.wireY;
        const bandNodes = layout.nodes.slice(band.firstNodeIdx, band.lastNodeIdx + 1);

        if (bandNodes.length === 0) {
          this._seg(g, layout.seriesStartX, layout.seriesEndX + 4, wireY, false);
          continue;
        }

        // Left stub — first band starts at the rail edge (square cap handles overlap);
        // other bands start from seriesStartX (fold entry, no rail needed).
        const entryPowered = isFirst
          ? power !== null
          : band.firstNodeIdx > 0
            ? this._outPw(power, layout.nodes[band.firstNodeIdx - 1].nodeId)
            : false;
        if (isFirst) {
          this._seg(g, RAIL_W, bandNodes[0].x, wireY, entryPowered);
        } else {
          this._seg(g, layout.seriesStartX, bandNodes[0].x, wireY, entryPowered);
        }

        // Between consecutive nodes in this band
        for (let i = 0; i < bandNodes.length - 1; i++) {
          const cur  = bandNodes[i];
          const next = bandNodes[i + 1];
          const pw   = this._wireBetweenPw(power, nodes, cur, next);
          this._seg(g, cur.x + cur.w, next.x, wireY, pw);
        }

        // Right stub — last band reaches the shared right rail; others fold.
        const last   = bandNodes[bandNodes.length - 1];
        const lastPw = this._outPw(power, last.nodeId);
        const rightEnd = isLast ? this._rightRailLocalX : layout.seriesEndX + 4;
        this._seg(g, last.x + last.w, rightEnd, wireY, lastPw);
      }
      return;
    }

    // ── Single-band (original logic) ──────────────────────────────────────────
    const wireY = layout.wireY;

    // _seg uses cap:"square" which extends 1px past each endpoint, giving a
    // free 1px overlap into both rails without visually painting over them.
    // Use the shared right-rail x so every rung's wire reaches the rail even
    // when that rung is narrower than the widest one.
    const rightEnd = this._rightRailLocalX;

    if (nodes.length === 0) {
      this._seg(g, RAIL_W, rightEnd, wireY, false);
      return;
    }

    // Left stub starts at the rail's right edge; square cap overlaps 1px in.
    this._seg(g, RAIL_W, layout.nodes[0].x, wireY, power !== null);

    // Between consecutive top-level nodes
    for (let i = 0; i < layout.nodes.length - 1; i++) {
      const cur  = layout.nodes[i];
      const next = layout.nodes[i + 1];
      const pw   = this._wireBetweenPw(power, nodes, cur, next);
      this._seg(g, cur.x + cur.w, next.x, wireY, pw);
    }

    // Last node → right rail (square cap overlaps 1px into the rail rect).
    const last   = layout.nodes[layout.nodes.length - 1];
    const lastPw = this._outPw(power, last.nodeId);
    this._seg(g, last.x + last.w, rightEnd, wireY, lastPw);
  }

  // ── Band fold connectors ──────────────────────────────────────────────────

  /**
   * Draw Studio 5000-style fold-wrap continuation arrows between bands.
   * At the right end of each non-last band: a ">>" chevron indicating wrap-right.
   * At the left start of each non-first band: a ">>" chevron indicating entry.
   * A faint vertical trace in the fold gap connects the two sides visually.
   */
  private _drawBandFolds(g: Graphics, layout: LayoutRung) {
    if (!layout.bands || layout.bands.length <= 1) return;

    const color = 0x9090b8;

    for (let bi = 0; bi < layout.bands.length - 1; bi++) {
      const band     = layout.bands[bi];
      const nextBand = layout.bands[bi + 1];
      const wy  = band.wireY;
      const nwy = nextBand.wireY;

      // ── Right-end fold marker ──────────────────────────────────────────────
      // Double ">>" chevron just past the right edge of the band wire
      const rx = layout.seriesEndX + 4;
      g.moveTo(rx - 7, wy - 6).lineTo(rx - 1, wy).lineTo(rx - 7, wy + 6)
        .stroke({ color, width: 2, alpha: 0.4 });
      g.moveTo(rx - 2, wy - 6).lineTo(rx + 4, wy).lineTo(rx - 2, wy + 6)
        .stroke({ color, width: 2, alpha: 0.85 });

      // Faint vertical connector in the fold gap (right side)
      g.moveTo(rx + 4, wy).lineTo(rx + 4, nwy)
        .stroke({ color, width: 1, alpha: 0.18 });

      // ── Left-entry fold marker ─────────────────────────────────────────────
      // Double ">>" chevron just before the left edge of the next band's wire
      const lx = layout.seriesStartX - 2;
      g.moveTo(lx - 7, nwy - 6).lineTo(lx - 1, nwy).lineTo(lx - 7, nwy + 6)
        .stroke({ color, width: 2, alpha: 0.4 });
      g.moveTo(lx - 2, nwy - 6).lineTo(lx + 4, nwy).lineTo(lx - 2, nwy + 6)
        .stroke({ color, width: 2, alpha: 0.85 });

      // Faint vertical connector in the fold gap (left side)
      g.moveTo(lx - 4, wy).lineTo(lx - 4, nwy)
        .stroke({ color, width: 1, alpha: 0.18 });
    }
  }

  /** Truncate an operand string for display inside a function block cell. */
  private _truncOp(s: string, max = 9): string {
    return s.length > max ? s.slice(0, max - 1) + "…" : s;
  }

  private _truncMiddleOperand(s: string): string {
    return this._truncOp(s || "?", 10);
  }

  private _truncLiveValue(s: string): string {
    return this._truncOp(s, 6);
  }

  private _truncTagLabel(s: string): string {
    return this._truncOp(s || "?", 16);
  }

  private _wrapComment(s: string, maxChars = 13, maxLines = 3): string {
    const words = s.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return "";

    const lines: string[] = [];
    let current = "";
    for (const word of words) {
      const chunks = word.length > maxChars
        ? word.match(new RegExp(`.{1,${maxChars}}`, "g")) ?? [word]
        : [word];
      for (const chunk of chunks) {
        const next = current ? `${current} ${chunk}` : chunk;
        if (next.length <= maxChars) {
          current = next;
          continue;
        }
        if (current) lines.push(current);
        current = chunk;
        if (lines.length >= maxLines) break;
      }
      if (lines.length >= maxLines) break;
    }
    if (current && lines.length < maxLines) lines.push(current);

    const original = s.trim();
    const rendered = lines.join(" ");
    if (rendered.length < original.length && lines.length > 0) {
      const last = lines[lines.length - 1];
      lines[lines.length - 1] = last.length >= maxChars
        ? `${last.slice(0, maxChars - 1)}…`
        : `${last}…`;
    }
    return lines.join("\n");
  }

  /**
   * Wire-exit power for a node: uses nodeOutputPowered when available (so
   * terminal blocks like TON show their input lit but their output dark),
   * falling back to nodePowered for nodes that don't set it.
   */
  private _outPw(power: RungPowerState | null, nodeId: string): boolean {
    if (!power) return false;
    const out = power.nodeOutputPowered?.get(nodeId);
    if (out !== undefined) return out;
    return power.nodePowered.get(nodeId) ?? false;
  }

  private _wireBetweenPw(
    power: RungPowerState | null,
    astNodes: SeriesNode[],
    cur: LayoutNode,
    next: LayoutNode
  ): boolean {
    const curAst = this._findAstInstruction(astNodes, cur.nodeId);
    const nextAst = this._findAstInstruction(astNodes, next.nodeId);
    if (curAst && nextAst && this._isTerminalDoneContact(curAst, nextAst)) {
      return power?.nodePowered.get(next.nodeId) ?? false;
    }
    return this._outPw(power, cur.nodeId);
  }

  private _isTerminalDoneContact(cur: InstructionNode, next: InstructionNode): boolean {
    const terminalTypes = new Set(["TON", "TOF", "RTO", "CTU", "CTD"]);
    if (!terminalTypes.has(cur.type) || next.type !== "XIC" || !cur.tagName) return false;
    return next.tagName.trim().toUpperCase() === `${cur.tagName.trim()}.DN`.toUpperCase();
  }

  private _seg(g: Graphics, x1: number, x2: number, y: number, powered: boolean) {
    if (x2 <= x1) return;
    g.moveTo(x1, y).lineTo(x2, y)
      .stroke({ color: powered ? C.wireOn : C.wireOff, width: 2, cap: "square" });
  }

  // ── Node dispatch ─────────────────────────────────────────────────────────

  private _drawNode(
    g: Graphics,
    container: Container,
    node: LayoutNode,
    rung: Rung,
    power: RungPowerState | null,
    inputPowered: boolean = false,
    visualOutPowered?: boolean,
    readOnly = false
  ) {
    if (isLayoutInstruction(node)) {
      const ast = this._findAstInstruction(rung.nodes, node.nodeId);
      if (!ast) return;
      const powered    = power?.nodePowered.get(node.nodeId) ?? false;
      const outPowered = visualOutPowered ?? this._outPw(power, node.nodeId);
      const selected   = !readOnly && this._selectedNodeId === node.nodeId;
      this._drawInstruction(g, container, node, ast, powered, outPowered, selected, inputPowered, power !== null);
    } else {
      this._drawBranch(g, container, node, rung, power, inputPowered, readOnly);
    }
  }

  // ── Instruction ───────────────────────────────────────────────────────────

  private _drawInstruction(
    g: Graphics,
    container: Container,
    layout: LayoutInstruction,
    node: InstructionNode,
    powered: boolean,
    outPowered: boolean,
    selected: boolean,
    inputPowered: boolean = false,
    liveValuesVisible: boolean = false
  ) {
    const { x, w } = layout;
    const cx    = x + w / 2;
    const wireY = layout.wireY;

    const isOutput      = ["OTE","OTL","OTU"].includes(node.type);
    const isTimerCtr    = ["TON","TOF","RTO","CTU","CTD"].includes(node.type);
    const isCompareMov  = [
      "EQU","NEQ","LES","LEQ","GRT","GEQ","MOV","MVM",
      "ADD","SUB","MUL","DIV","MOD","NEG","ABS","SQR","CLR",
      "JSR",
    ].includes(node.type);
    const isComplex     = isTimerCtr || node.type === "RES" || node.type === "NOP";

    const wireColor = powered ? C.wireOn : C.wireOff;
    const contactTagValue = ["XIC", "XIO", "OSR", "OSF"].includes(node.type)
      ? this._readBooleanValue(node.tagName)
      : null;
    const contactLit = liveValuesVisible && (node.type === "XIO" ? contactTagValue === false : contactTagValue === true);
    const outputTagValue = isOutput ? this._readBooleanValue(node.tagName) : null;
    const outputLatched = liveValuesVisible && outputTagValue === true;
    const tagStateLit = contactLit || outputLatched;
    const tagStyle  = powered || tagStateLit ? STYLE_TAG_ON : STYLE_TAG;
    const mnStyle   = powered || tagStateLit ? STYLE_MNEMONIC_ON : isOutput ? STYLE_MNEMONIC_OUT : STYLE_MNEMONIC;

    // ── Instruction comment (tag description, shown when _showNodeComments is true) ──
    if (this._showNodeComments) {
      const tagDesc = this._resolveTag(node.tagName)?.description ?? "";
      const cmt = new Text({
        text: this._wrapComment(tagDesc),
        style: new TextStyle({
          fontSize: 10,
          fill: tagDesc ? C.textDim : 0x3a3b4d,
          fontFamily: "Consolas, monospace",
          fontStyle: "italic",
          align: "center",
          leading: 1,
        }),
      });
      cmt.anchor.set(0.5, 0.5);
      cmt.position.set(cx, layout.y + COMMENT_H / 2);
      container.addChild(cmt);
    }

    if (isTimerCtr) {
      // ── Studio 5000-style function block: Tag / Pre / Acc rows ────────────
      // wireY is near the top of the block (COMPLEX_INST_WIRE_Y px from layout top)
      const bx = x + 8, by = wireY - 14, bw = w - 16, bh = 74;
      if (selected) {
        g.roundRect(bx - 2, by - 2, bw + 4, bh + 4, 5)
          .stroke({ color: C.nodeSelected, width: 1.5 });
      }
      g.roundRect(bx, by, bw, bh, 3)
        .fill({ color: powered ? C.nodeOnBg : C.nodeBg })
        .stroke({ color: powered ? C.nodeOn : C.nodeBorder, width: 1 });

      // Left stub = input power. Right stub stays dark; use an explicit
      // downstream XIC Timer.DN / Counter.DN contact to continue power flow.
      this._seg(g, x, bx, wireY, powered);
      this._seg(g, bx + bw, x + w, wireY, outPowered);

      // Mnemonic in the header band (above the divider)
      const mn = new Text({ text: node.type, style: mnStyle });
      mn.anchor.set(0.5, 0.5);
      mn.position.set(cx, wireY - 5);
      container.addChild(mn);

      // Divider separating mnemonic from data rows
      g.moveTo(bx + 1, wireY + 4)
        .lineTo(bx + bw - 1, wireY + 4)
        .stroke({ color: powered ? C.nodeOn : C.nodeBorder, width: 1 });

      // Data rows: Tag, Preset, Accum
      const isTimer = ["TON","TOF","RTO"].includes(node.type);
      const tagEntry    = this._resolveTag(node.tagName);
      const timerData   = tagEntry?.timerData;
      const counterData = tagEntry?.counterData;
      const p = node.params as TimerParams | CounterParams;
      const livePreset = isTimer
        ? timerData?.preset
        : counterData?.preset;

      const accumVal = isTimer
        ? (timerData?.accum ?? 0)
        : (counterData?.accum ?? 0);

      const presetDisplay = livePreset !== undefined ? String(livePreset) : p?.presetTag
        ? `[${p.presetTag.length > 9 ? p.presetTag.slice(0, 8) + "…" : p.presetTag}]`
        : String(p?.preset ?? (isTimer ? 1000 : 10));

      const tagDisplay = node.tagName
        ? (node.tagName.length > 10 ? node.tagName.slice(0, 9) + "…" : node.tagName)
        : "?";

      const labelSt = new TextStyle({
        fontFamily: "Consolas, monospace", fontSize: 10, fill: C.textDim,
      });
      const tagValSt = new TextStyle({
        fontFamily: "Consolas, monospace", fontSize: 11,
        fill: powered ? C.textGreen : C.textPrimary,
      });
      const presetValSt = new TextStyle({
        fontFamily: "Consolas, monospace", fontSize: 11,
        fill: powered ? C.textGreen : C.textYellow,
      });
      const accumValSt = new TextStyle({
        fontFamily: "Consolas, monospace", fontSize: 11,
        fill: powered ? C.textGreen : C.textPrimary,
        fontWeight: "bold",
      });

      const rowYs    = [wireY + 18, wireY + 34, wireY + 50];
      const labels   = ["Tag", "Pre", "Acc"];
      const values   = [tagDisplay, presetDisplay, String(accumVal)];
      const valStyles = [tagValSt, presetValSt, accumValSt];

      for (let i = 0; i < 3; i++) {
        const lbl = new Text({ text: labels[i], style: labelSt });
        lbl.anchor.set(0, 0.5);
        lbl.position.set(bx + 4, rowYs[i]);
        container.addChild(lbl);

        const val = new Text({ text: values[i], style: valStyles[i] });
        val.anchor.set(1, 0.5);
        val.position.set(bx + bw - 4, rowYs[i]);
        container.addChild(val);
      }

    } else if (isCompareMov) {
      // ── Compare / Move function block ─────────────────────────────────────
      // Wire enters near the top of the block (same as timer blocks).
      // 8px margins give visible stubs on each side matching Studio 5000 style.
      const bx = x + 8, by = wireY - 18, bw = w - 16, bh = 88;
      const isMovInst = node.type === "MOV" || node.type === "MVM";
      const isMathInst = ["ADD","SUB","MUL","DIV","MOD","NEG","ABS","SQR","CLR"].includes(node.type);
      const isUnaryMath = ["NEG","ABS","SQR","CLR"].includes(node.type);
      const isJsrInst = node.type === "JSR";
      const headerY = isJsrInst ? by + 16 : wireY - 7;
      const dividerY = isJsrInst ? by + 31 : wireY + 6;

      if (selected) {
        g.roundRect(bx - 2, by - 2, bw + 4, bh + 4, 5)
          .stroke({ color: C.nodeSelected, width: 1.5 });
      }
      g.roundRect(bx, by, bw, bh, 3)
        .fill({ color: powered ? C.nodeOnBg : C.nodeBg })
        .stroke({ color: powered ? C.nodeOn : C.nodeBorder, width: 1 });

      // Wire stubs
      this._seg(g, x, bx, wireY, inputPowered);
      this._seg(g, bx + bw, x + w, wireY, powered);

      // Mnemonic in header
      const mn = new Text({ text: node.type, style: mnStyle });
      mn.anchor.set(0.5, 0.5);
      mn.position.set(cx, headerY);
      container.addChild(mn);

      // Divider
      g.moveTo(bx + 1, dividerY).lineTo(bx + bw - 1, dividerY)
        .stroke({ color: powered ? C.nodeOn : C.nodeBorder, width: 1 });

      // Row styles
      const labelSt = new TextStyle({ fontFamily: "Consolas, monospace", fontSize: 10, fill: C.textDim });
      const valSt   = new TextStyle({ fontFamily: "Consolas, monospace", fontSize: 11, fill: powered ? C.textGreen : C.textPrimary });
      const destSt  = new TextStyle({ fontFamily: "Consolas, monospace", fontSize: 11, fill: powered ? C.textGreen : C.textYellow });
      const liveSt  = new TextStyle({ fontFamily: "Consolas, monospace", fontSize: 11, fill: powered ? C.textGreen : C.textDim, fontWeight: "bold" });

      const drawOperandRow = (label: string, operand: string, rowY: number, style: TextStyle, valueX = bx + 38) => {
        const lbl = new Text({ text: label, style: labelSt });
        lbl.anchor.set(0, 0.5); lbl.position.set(bx + 6, rowY);
        container.addChild(lbl);

        const name = new Text({ text: this._truncMiddleOperand(operand), style });
        name.anchor.set(0, 0.5); name.position.set(valueX, rowY);
        container.addChild(name);

        const liveValue = this._formatLiveValue(operand);
        if (liveValue && liveValue !== operand.trim()) {
          const live = new Text({ text: this._truncLiveValue(liveValue), style: liveSt });
          live.anchor.set(1, 0.5); live.position.set(bx + bw - 4, rowY);
          container.addChild(live);
        }
      };

      const rowYs  = isJsrInst ? [dividerY + 22] : [wireY + 24, wireY + 48];
      let labels: string[], values: string[];

        if (isJsrInst) {
          const jsr = node.params as JsrParams;
          labels = ["Routine"];
          values = [jsr?.routineName ?? ""];
        } else if (isMovInst) {
          const move = node.params as MoveParams;
          labels = ["Src", "Dst"];
          values = [
            move?.source ?? "",
            move?.dest ?? "",
          ];
          if (node.type === "MVM") {
            labels = ["Src", "Msk", "Dst"];
            // squeeze 3 rows into the same space
            const rowY3 = [wireY + 19, wireY + 39, wireY + 60];
            const vals3 = [
              move?.source ?? "",
              move?.mask ?? "",
              move?.dest ?? "",
            ];
          for (let i = 0; i < 3; i++) {
            drawOperandRow(labels[i], vals3[i], rowY3[i], i < 2 ? valSt : destSt);
          }
          // skip generic 2-row render below
          labels = []; values = [];
        }
        } else if (isMathInst) {
          const math = node.params as MathParams;
          if (isUnaryMath) {
            labels = node.type === "CLR" ? ["Dst"] : ["Src", "Dst"];
            values = node.type === "CLR"
              ? [math?.dest ?? ""]
              : [math?.sourceA ?? "", math?.dest ?? ""];
          } else {
            labels = ["SrcA", "SrcB", "Dst"];
            const rowY3 = [wireY + 19, wireY + 39, wireY + 60];
            const vals3 = [
              math?.sourceA ?? "",
              math?.sourceB ?? "",
              math?.dest ?? "",
            ];
            for (let i = 0; i < 3; i++) {
              drawOperandRow(labels[i], vals3[i], rowY3[i], i === 2 ? destSt : valSt);
            }
            labels = []; values = [];
          }
        } else {
          const compare = node.params as CompareParams;
          labels = ["SrcA", "SrcB"];
          values = [
            compare?.sourceA ?? "",
            compare?.sourceB ?? "",
          ];
        }

      for (let i = 0; i < labels.length; i++) {
        drawOperandRow(labels[i], values[i], rowYs[i], i === 1 && isMovInst ? destSt : valSt, isJsrInst ? bx + 48 : undefined);
      }

    } else if (isComplex) {
      // ── RES: simple box style ─────────────────────────────────────────────
      const bx = x + 6, by = wireY - 20, bw = w - 12, bh = 40;
      if (selected) {
        g.roundRect(bx - 2, by - 2, bw + 4, bh + 4, 5)
          .stroke({ color: C.nodeSelected, width: 1.5 });
      }
      g.roundRect(bx, by, bw, bh, 3)
        .fill({ color: powered ? C.nodeOnBg : C.nodeBg })
        .stroke({ color: powered ? C.nodeOn : C.nodeBorder, width: 1 });

      // Wire stubs into box sides
      this._seg(g, x, bx, wireY, powered);
      this._seg(g, bx + bw, x + w, wireY, powered);

      // Type mnemonic inside box
      const mn = new Text({ text: node.type, style: mnStyle });
      mn.anchor.set(0.5, 0.5);
      mn.position.set(cx, wireY);
      container.addChild(mn);

      // RES is tag-bound; NOP is intentionally parameterless.
      if (node.type !== "NOP") {
        const tag = new Text({ text: this._truncTagLabel(node.tagName), style: tagStyle });
        tag.anchor.set(0.5, 1);
        tag.position.set(cx, by - 2);
        container.addChild(tag);
      }

    } else if (isOutput) {
      // ── Coil: ─( )─ ──────────────────────────────────────────────────────
      const r = 10;
      const coilColor = outputLatched ? C.wireOn : wireColor;

      // Selection highlight
      if (selected) {
        g.circle(cx, wireY, r + 4).stroke({ color: C.nodeSelected, width: 1.5 });
      }

      // Wire stubs
      this._seg(g, x, cx - r, wireY, powered);
      this._seg(g, cx + r, x + w, wireY, powered);

      // Circle
      g.circle(cx, wireY, r).stroke({ color: coilColor, width: 2 });

      // Letter inside for OTL / OTU
      if (node.type === "OTL" || node.type === "OTU") {
        const ltr = new Text({
          text: node.type === "OTL" ? "L" : "U",
          style: new TextStyle({
            fontFamily: "Consolas, monospace", fontSize: 10,
            fontWeight: "bold",
            fill: coilColor,
          }),
        });
        ltr.anchor.set(0.5, 0.5);
        ltr.position.set(cx, wireY);
        container.addChild(ltr);
      }

      // Tag above
      const tag = new Text({ text: this._truncTagLabel(node.tagName), style: tagStyle });
      tag.anchor.set(0.5, 1);
      tag.position.set(cx, wireY - r - 6);
      container.addChild(tag);

      // Mnemonic below
      const mn = new Text({ text: node.type, style: mnStyle });
      mn.anchor.set(0.5, 0);
      mn.position.set(cx, wireY + r + 6);
      container.addChild(mn);

    } else if (node.type === "ONS") {
      // ── ONS: slim inline box — same height feel as a contact ──────────────
      const bh = 24, bw = w - 20;
      const bx = x + 10, by = wireY - bh / 2;
      if (selected) {
        g.roundRect(bx - 2, by - 2, bw + 4, bh + 4, 5)
          .stroke({ color: C.nodeSelected, width: 1.5 });
      }
      g.roundRect(bx, by, bw, bh, 3)
        .fill({ color: powered ? C.nodeOnBg : C.nodeBg })
        .stroke({ color: powered ? C.nodeOn : C.nodeBorder, width: 0.75 });

      // Wire stubs
      this._seg(g, x, bx, wireY, inputPowered);
      this._seg(g, bx + bw, x + w, wireY, powered);

      // Rising-edge glyph — slightly smaller to fit the tighter box
      const px = cx, py = wireY;
      const pw2 = 8, ph2 = 5;
      const pulseColor = powered ? C.wireOn : C.textDim;
      g.moveTo(px - pw2,     py + ph2)
       .lineTo(px - pw2,     py - ph2)
       .lineTo(px,           py - ph2)
       .lineTo(px,           py + ph2)
       .lineTo(px + pw2,     py + ph2)
       .stroke({ color: pulseColor, width: 1.5 });

      // Tag above
      const tag = new Text({ text: this._truncTagLabel(node.tagName), style: tagStyle });
      tag.anchor.set(0.5, 1);
      tag.position.set(cx, by - 2);
      container.addChild(tag);

      // Mnemonic below
      const mn = new Text({ text: "ONS", style: mnStyle });
      mn.anchor.set(0.5, 0);
      mn.position.set(cx, by + bh + 2);
      container.addChild(mn);

    } else {
      // ── Contact: ─┤ ├─  or  ─┤/├─ ───────────────────────────────────────
      const barH = 16, barW = 2, halfGap = 8;
      const lBarX = cx - halfGap - barW;
      const rBarX = cx + halfGap;

      // Left side = power arriving at this contact's input terminal.
      // Right side = power exiting (conducting through).
      const contactColor = contactLit ? C.wireOn : C.wireOff;
      const inColor  = inputPowered ? C.wireOn : C.wireOff;

      // XIO is visually true when the referenced bit is false.
      let slashColor = contactColor;
      if (liveValuesVisible && node.type === "XIO") {
        slashColor = contactTagValue === false ? C.wireOn : C.wireOff;
      }

      // Selection highlight
      if (selected) {
        g.roundRect(lBarX - 4, wireY - barH / 2 - 4, (rBarX + barW) - (lBarX - 4) + 4, barH + 8, 3)
          .stroke({ color: C.nodeSelected, width: 1.5 });
      }

      // Left stub + left bar  → input colour (power arriving)
      this._seg(g, x, lBarX, wireY, inputPowered);
      g.rect(lBarX, wireY - barH / 2, barW, barH).fill({ color: contactColor });

      // Right bar + right stub → output colour (power passing through)
      g.rect(rBarX, wireY - barH / 2, barW, barH).fill({ color: contactColor });
      this._seg(g, rBarX + barW, x + w, wireY, powered);

      // XIO slash — tag-based colour shows contact state regardless of power
      if (node.type === "XIO") {
        g.moveTo(cx - halfGap + 3, wireY + 7)
          .lineTo(cx + halfGap - 3, wireY - 7)
          .stroke({ color: slashColor, width: 2 });
      }
      // OSR up-arrow
      if (node.type === "OSR") {
        g.moveTo(cx, wireY + 5).lineTo(cx, wireY - 5).stroke({ color: contactColor, width: 2 });
        g.moveTo(cx - 4, wireY - 1).lineTo(cx, wireY - 6).lineTo(cx + 4, wireY - 1)
          .stroke({ color: contactColor, width: 2 });
      }
      // OSF down-arrow
      if (node.type === "OSF") {
        g.moveTo(cx, wireY - 5).lineTo(cx, wireY + 5).stroke({ color: contactColor, width: 2 });
        g.moveTo(cx - 4, wireY + 1).lineTo(cx, wireY + 6).lineTo(cx + 4, wireY + 1)
          .stroke({ color: contactColor, width: 2 });
      }

      // Tag above
      if (node.type !== "AFI") {
        const tag = new Text({ text: this._truncTagLabel(node.tagName), style: tagStyle });
        tag.anchor.set(0.5, 1);
        tag.position.set(cx, wireY - barH / 2 - 3);
        container.addChild(tag);
      }

      // Mnemonic below
      const mn = new Text({ text: node.type, style: mnStyle });
      mn.anchor.set(0.5, 0);
      mn.position.set(cx, wireY + barH / 2 + 3);
      container.addChild(mn);
    }

  }

  // ── Branch ────────────────────────────────────────────────────────────────

  private _drawBranch(
    g: Graphics,
    container: Container,
    branch: LayoutBranch,
    rung: Rung,
    power: RungPowerState | null,
    inputPowered: boolean = false,
    readOnly = false
  ) {
    const branchPowered = power?.nodePowered.get(branch.nodeId) ?? false;
    const railColor = inputPowered ? C.branchRailOn : C.branchRail;

    const firstWY = branch.legs[0]?.wireY ?? branch.wireY;
    const lastWY  = branch.legs[branch.legs.length - 1]?.wireY ?? branch.wireY;

    // Vertical bars drawn as filled rects — pixel-exact, no cap/anti-aliasing
    // artefacts.  Extended 1 px above firstWY and below lastWY so the rect
    // definitively overlaps the 2 px-wide horizontal leg wires at both ends.
    // The horizontal wires are drawn afterwards (on top) and cover any overhang
    // at their own x-range, so there is no visible protrusion.
    const rightRailColor = branchPowered ? C.branchRailOn : C.branchRail;
    const barY1 = firstWY - 1;
    const barH  = lastWY - firstWY + 2;          // +2 = 1 px top + 1 px bottom
    g.rect(branch.leftRailX,  barY1, BRANCH_RAIL_W, barH).fill({ color: railColor });
    g.rect(branch.rightRailX, barY1, BRANCH_RAIL_W, barH).fill({ color: rightRailColor });

    // Per-leg stubs + content
    for (const leg of branch.legs) {
      const legPowered = power?.legPowered.get(leg.legId) ?? false;
      const legColor   = legPowered ? C.wireOn : C.wireOff;
      // Leg wires span from the inner edge of the left bar to the inner edge of
      // the right bar.  cap:"square" on _seg extends 1 px past each endpoint,
      // overlapping the bar rects and guaranteeing gap-free corners.
      const legLeft  = branch.leftRailX + BRANCH_RAIL_W;
      const legRight = branch.rightRailX;

      if (leg.nodes.length === 0) {
        g.moveTo(legLeft, leg.wireY).lineTo(legRight, leg.wireY)
          .stroke({ color: legColor, width: 2 });
      } else {
        const first = leg.nodes[0];
        const last  = leg.nodes[leg.nodes.length - 1];

        g.moveTo(legLeft, leg.wireY).lineTo(first.x, leg.wireY)
          .stroke({ color: inputPowered ? C.wireOn : C.wireOff, width: 2 });

        // Draw nodes with per-node inputPowered tracking
        for (let ni = 0; ni < leg.nodes.length; ni++) {
          const nodeInputPowered = ni === 0
            ? inputPowered
            : this._wireBetweenPw(power, rung.nodes, leg.nodes[ni - 1], leg.nodes[ni]);
          const visualOutPowered = ni < leg.nodes.length - 1
            ? this._wireBetweenPw(power, rung.nodes, leg.nodes[ni], leg.nodes[ni + 1])
            : undefined;
          this._drawNode(g, container, leg.nodes[ni], rung, power, nodeInputPowered, visualOutPowered, readOnly);
        }

        for (let i = 0; i < leg.nodes.length - 1; i++) {
          const cur  = leg.nodes[i];
          const next = leg.nodes[i + 1];
          const pw   = this._wireBetweenPw(power, rung.nodes, cur, next);
          g.moveTo(cur.x + cur.w, leg.wireY).lineTo(next.x, leg.wireY)
            .stroke({ color: pw ? C.wireOn : C.wireOff, width: 2 });
        }

        const lastPow = this._outPw(power, last.nodeId);
        g.moveTo(last.x + last.w, leg.wireY).lineTo(legRight, leg.wireY)
          .stroke({ color: lastPow ? C.wireOn : C.wireOff, width: 2 });
      }
    }

    // Main wire stubs into branch — meet the outer edges of the bar rects.
    // cap:"square" extends 1 px into each bar so the join is gap-free.
    this._seg(g, branch.x, branch.leftRailX, branch.wireY, inputPowered);
    this._seg(g, branch.rightRailX + BRANCH_RAIL_W, branch.x + branch.w, branch.wireY, branchPowered);
  }

  // ── AST helpers ───────────────────────────────────────────────────────────

  private _findAstInstruction(nodes: SeriesNode[], id: string): InstructionNode | undefined {
    for (const n of nodes) {
      if (isInstruction(n) && n.id === id) return n;
      if (isBranch(n)) {
        for (const leg of n.legs) {
          const found = this._findAstInstruction(leg.nodes, id);
          if (found) return found;
        }
      }
    }
    return undefined;
  }

  // ── Drag-drop query & feedback ────────────────────────────────────────────

  /**
   * Return which instruction node (if any) is under the given canvas point.
   * Used to determine whether a mousedown should start a node drag.
   */
  hitTestNode(
    canvasX: number,
    canvasY: number
  ): { rungId: string; nodeId: string; rail?: "left" | "right" } | null {
    const entry = this._rungLayoutData.find(
      e => canvasY >= e.y && canvasY < e.y + e.h
    );
    if (!entry) return null;
    const localX = canvasX - this.RUNG_NUMBER_W;
    const localY = canvasY - entry.y;
    const hit = hitTest(entry.layout.nodes, localX, localY);
    if (!hit) return null;
    return { rungId: entry.rungId, nodeId: hit.nodeId, rail: hit.rail };
  }

  /**
   * Given a point in canvas pixel space (top of canvas = 0, accounts for scroll
   * externally), return the nearest InsertPosition and the x for the indicator line.
   *
   * wireY (absolute canvas y) is used to place the diamond indicator at the
   * correct wire level — either the rung's main wire or a branch leg wire.
   */
  queryDropTarget(
    canvasX: number,
    canvasY: number,
    dragType?: InstructionType
  ): {
    position: InsertPosition;
    lineX: number;
    rungY: number;
    rungH: number;
    wireY: number;
  } | null {
    const entry = this._rungLayoutData.find(
      e => canvasY >= e.y && canvasY < e.y + e.h
    );
    if (!entry) return null;

    const { rungId, y: rungY, h: rungH, layout } = entry;
    const localX = canvasX - this.RUNG_NUMBER_W;
    const localY = canvasY - rungY;
    const mainWireY = rungY + layout.wireY;
    const isCoilDrag = dragType ? isCoilOutput(dragType) : false;
    const isOutputClassDrag = dragType ? isOutput(dragType) : false;

    const appendLineX = () => {
      const last = layout.nodes[layout.nodes.length - 1];
      return this.RUNG_NUMBER_W + (last ? last.x + last.w : layout.seriesStartX);
    };

    // ── Branch-leg drop detection (checked first, takes priority) ────────────
    const branchDrop = this._queryBranchDrop(
      layout.nodes, localX, localY, rungId, rungY
    );
    if (branchDrop) return { ...branchDrop, rungY, rungH };

    if (isCoilDrag) {
      return {
        position: { kind: "series-append", rungId },
        lineX: appendLineX(),
        rungY,
        rungH,
        wireY: mainWireY,
      };
    }

    const firstOutputIdx = entry.nodes.findIndex(n => isInstruction(n) && isCoilOutput(n.type));

    // ── No output yet → always snap to far right ──────────────────────────────
    if (isOutputClassDrag && firstOutputIdx === -1) {
      return {
        position: { kind: "series-append", rungId },
        lineX: appendLineX(),
        rungY,
        rungH,
        wireY: mainWireY,
      };
    }

    if (layout.nodes.length === 0) {
      return {
        position: { kind: "series-append", rungId },
        lineX: this.RUNG_NUMBER_W + layout.seriesStartX,
        rungY,
        rungH,
        wireY: mainWireY,
      };
    }

    const nodes = layout.nodes;

    if (localX < nodes[0].x + nodes[0].w / 2) {
      return {
        position: { kind: "series-prepend", rungId },
        lineX: this.RUNG_NUMBER_W + nodes[0].x,
        rungY,
        rungH,
        wireY: mainWireY,
      };
    }

    for (let i = 0; i < nodes.length - 1; i++) {
      const cur  = nodes[i];
      const next = nodes[i + 1];
      if (localX < (cur.x + cur.w + next.x) / 2) {
        return {
          position: { kind: "series-after", rungId, siblingId: cur.nodeId },
          lineX: this.RUNG_NUMBER_W + cur.x + cur.w,
          rungY,
          rungH,
          wireY: mainWireY,
        };
      }
    }

    const last = nodes[nodes.length - 1];
    return {
      position: { kind: "series-append", rungId },
      lineX: this.RUNG_NUMBER_W + last.x + last.w,
      rungY,
      rungH,
      wireY: mainWireY,
    };
  }

  /**
   * Recursively check whether (localX, localY) falls inside any branch leg
   * in the given layout node list.  Returns the drop info or null.
   */
  private _queryBranchDrop(
    nodes: LayoutNode[],
    localX: number,
    localY: number,
    rungId: string,
    rungY: number
  ): { position: InsertPosition; lineX: number; wireY: number } | null {
    for (const node of nodes) {
      if (!isLayoutBranch(node)) continue;

      // Bounding box check
      if (localX < node.x || localX > node.x + node.w) continue;
      if (localY < node.y || localY > node.y + node.h) continue;

      // Recurse into nested branches first (inner match beats outer)
      for (const leg of node.legs) {
        const nested = this._queryBranchDrop(leg.nodes, localX, localY, rungId, rungY);
        if (nested) return nested;
      }

      // Find the leg whose wireY is closest to the cursor
      let bestLeg = node.legs[0];
      let bestDist = Math.abs(localY - node.legs[0].wireY);
      for (const leg of node.legs.slice(1)) {
        const d = Math.abs(localY - leg.wireY);
        if (d < bestDist) { bestDist = d; bestLeg = leg; }
      }

      const branchId  = node.nodeId;
      const legId     = bestLeg.legId;
      const legNodes  = bestLeg.nodes;
      const contentX  = node.leftRailX + BRANCH_RAIL_W;
      const absWireY  = rungY + bestLeg.wireY;

      if (legNodes.length === 0) {
        return {
          position: { kind: "branch-leg-append", rungId, branchId, legId },
          lineX: this.RUNG_NUMBER_W + contentX,
          wireY: absWireY,
        };
      }

      // Position within leg by cursor x
      if (localX < legNodes[0].x + legNodes[0].w / 2) {
        return {
          position: { kind: "branch-leg-before", rungId, branchId, legId, siblingId: legNodes[0].nodeId },
          lineX: this.RUNG_NUMBER_W + legNodes[0].x,
          wireY: absWireY,
        };
      }
      for (let i = 0; i < legNodes.length - 1; i++) {
        const cur  = legNodes[i];
        const next = legNodes[i + 1];
        if (localX < (cur.x + cur.w + next.x) / 2) {
          return {
            position: { kind: "branch-leg-after", rungId, branchId, legId, siblingId: cur.nodeId },
            lineX: this.RUNG_NUMBER_W + cur.x + cur.w,
            wireY: absWireY,
          };
        }
      }
      const last = legNodes[legNodes.length - 1];
      return {
        position: { kind: "branch-leg-append", rungId, branchId, legId },
        lineX: this.RUNG_NUMBER_W + last.x + last.w,
        wireY: absWireY,
      };
    }
    return null;
  }

  /** Draw the insertion-point indicator. Pass null to clear. */
  showDropZone(
    info: ReturnType<LadderRenderer["queryDropTarget"]>
  ) {
    this._dropGfx.clear();
    if (!info) return;

    const { lineX, rungY, rungH, wireY } = info;

    // Subtle rung tint
    this._dropGfx
      .rect(this.RUNG_NUMBER_W, rungY, 4000, rungH)
      .fill({ color: 0x4a8cff, alpha: 0.08 });

    // Vertical insertion line
    this._dropGfx
      .rect(lineX - 1, rungY + 2, 2, rungH - 4)
      .fill({ color: 0x4a8cff });

    // Diamond at the correct wire level (main rung wire OR branch leg wire)
    this._dropGfx
      .poly([lineX, wireY - 6, lineX + 5, wireY, lineX, wireY + 6, lineX - 5, wireY])
      .fill({ color: 0x4a8cff });
  }

  clearDropZone() {
    this._dropGfx.clear();
  }

  showDropAnchors(dragType?: InstructionType) {
    this._dropDotsGfx.clear();
    const color = 0x4a8cff;
    const outputOnly = dragType ? isCoilOutput(dragType) : false;
    const outputClass = dragType ? isOutput(dragType) : false;

    const drawDot = (x: number, y: number, strong = false) => {
      this._dropDotsGfx.circle(x, y, strong ? 4 : 3)
        .fill({ color, alpha: strong ? 0.9 : 0.48 });
      this._dropDotsGfx.circle(x, y, strong ? 7 : 6)
        .stroke({ color, alpha: strong ? 0.45 : 0.22, width: 1 });
    };

    const addSeriesDots = (nodes: LayoutNode[], rungId: string, wireY: number, seriesStartX: number, forceAppendOnly = false) => {
      void rungId;
      if (nodes.length === 0) {
        drawDot(this.RUNG_NUMBER_W + seriesStartX, wireY, true);
        return;
      }
      const last = nodes[nodes.length - 1];
      if (forceAppendOnly) {
        drawDot(this.RUNG_NUMBER_W + last.x + last.w, wireY, true);
        return;
      }
      drawDot(this.RUNG_NUMBER_W + nodes[0].x, wireY);
      for (let i = 0; i < nodes.length - 1; i++) {
        drawDot(this.RUNG_NUMBER_W + nodes[i].x + nodes[i].w, wireY);
      }
      drawDot(this.RUNG_NUMBER_W + last.x + last.w, wireY, true);
    };

    const addBranchDots = (nodes: LayoutNode[], rungY: number) => {
      for (const node of nodes) {
        if (!isLayoutBranch(node)) continue;
        for (const leg of node.legs) {
          addSeriesDots(leg.nodes, "", rungY + leg.wireY, node.leftRailX + BRANCH_RAIL_W, false);
          addBranchDots(leg.nodes, rungY);
        }
      }
    };

    for (const entry of this._rungLayoutData) {
      const layout = entry.layout;
      const mainWireY = entry.y + layout.wireY;
      const firstOutputIdx = entry.nodes.findIndex(n => isInstruction(n) && isCoilOutput(n.type));
      const forceAppendOnly = outputOnly || (outputClass && firstOutputIdx === -1);
      addSeriesDots(layout.nodes, entry.rungId, mainWireY, layout.seriesStartX, forceAppendOnly);
      addBranchDots(layout.nodes, entry.y);
    }
  }

  clearDropAnchors() {
    this._dropDotsGfx.clear();
  }

  /**
   * Draw a highlight box around the node (by id) in the given rung.
   *  mode "absorb" — teal: this instruction will be pulled into the branch
   *  mode "eject"  — amber: this instruction will be pushed out of the branch
   */
  showExtendTarget(rungId: string, nodeId: string | null, mode: "absorb" | "eject" = "absorb") {
    this._extendGfx.clear();
    if (!nodeId) return;
    const entry = this._rungLayoutData.find(e => e.rungId === rungId);
    if (!entry) return;
    const node = this._findLayoutNode(entry.layout.nodes, nodeId);
    if (!node) return;
    const absX = this.RUNG_NUMBER_W + node.x;
    const absY = entry.y + node.y;
    const color = mode === "absorb" ? 0x00d4aa : 0xf0a030;
    this._extendGfx
      .rect(absX - 3, absY - 3, node.w + 6, node.h + 6)
      .fill({ color, alpha: 0.15 })
      .stroke({ color, width: 2, alpha: 0.9 });
  }

  clearExtendTarget() {
    this._extendGfx.clear();
  }

  /**
   * Return the layout of a branch node, or null if not found.
   * Used by PixiCanvas to determine rail positions during drag.
   */
  getBranchLayout(rungId: string, branchId: string): LayoutBranch | null {
    const entry = this._rungLayoutData.find(e => e.rungId === rungId);
    if (!entry) return null;
    const node = this._findLayoutNode(entry.layout.nodes, branchId);
    if (!node || !isLayoutBranch(node)) return null;
    return node;
  }

  /**
   * Return the layout of an instruction node. Used by tag drag/drop to map the
   * drop position to a block field row.
   */
  getInstructionLayout(rungId: string, nodeId: string): LayoutInstruction | null {
    const entry = this._rungLayoutData.find(e => e.rungId === rungId);
    if (!entry) return null;
    const node = this._findLayoutNode(entry.layout.nodes, nodeId);
    if (!node || !isLayoutInstruction(node)) return null;
    return node;
  }

  getKeyboardNavigationTarget(
    selection: { kind: "node"; rungId: string; nodeId: string } | { kind: "rung"; rungId: string } | null,
    direction: "left" | "right" | "up" | "down"
  ): KeyboardNavTarget {
    if (this._rungLayoutData.length === 0) return null;
    const navNodes = this._collectNavNodes();
    if (navNodes.length === 0) {
      const currentIdx = selection?.kind === "rung"
        ? this._rungLayoutData.findIndex(e => e.rungId === selection.rungId)
        : -1;
      const nextIdx = direction === "up"
        ? Math.max(0, currentIdx - 1)
        : direction === "down"
          ? Math.min(this._rungLayoutData.length - 1, Math.max(0, currentIdx + 1))
          : Math.max(0, currentIdx);
      return { kind: "rung", rungId: this._rungLayoutData[nextIdx].rungId };
    }

    if (!selection) {
      const first = navNodes[0];
      return { kind: "node", rungId: first.rungId, nodeId: first.nodeId };
    }

    if (selection.kind === "rung") {
      const rungNodes = navNodes.filter(n => n.rungId === selection.rungId);
      if ((direction === "left" || direction === "right") && rungNodes.length > 0) {
        const target = direction === "left" ? rungNodes[rungNodes.length - 1] : rungNodes[0];
        return { kind: "node", rungId: target.rungId, nodeId: target.nodeId };
      }
      const idx = this._rungLayoutData.findIndex(e => e.rungId === selection.rungId);
      const nextIdx = direction === "up" ? idx - 1 : direction === "down" ? idx + 1 : idx;
      const next = this._rungLayoutData[Math.max(0, Math.min(this._rungLayoutData.length - 1, nextIdx))];
      return next ? { kind: "rung", rungId: next.rungId } : null;
    }

    const current = navNodes.find(n => n.rungId === selection.rungId && n.nodeId === selection.nodeId);
    if (!current) return { kind: "rung", rungId: selection.rungId };

    if (direction === "left" || direction === "right") {
      const next = navNodes[current.order + (direction === "right" ? 1 : -1)];
      return next ? { kind: "node", rungId: next.rungId, nodeId: next.nodeId } : { kind: "rung", rungId: current.rungId };
    }

    const candidates = navNodes.filter(n => direction === "up" ? n.cy < current.cy - 1 : n.cy > current.cy + 1);
    if (candidates.length === 0) return { kind: "rung", rungId: current.rungId };
    candidates.sort((a, b) => {
      const dyA = Math.abs(a.cy - current.cy);
      const dyB = Math.abs(b.cy - current.cy);
      if (dyA !== dyB) return dyA - dyB;
      return Math.abs(a.cx - current.cx) - Math.abs(b.cx - current.cx);
    });
    const target = candidates[0];
    return { kind: "node", rungId: target.rungId, nodeId: target.nodeId };
  }

  private _collectNavNodes(): NavNode[] {
    const nodes: NavNode[] = [];
    const addNodes = (rungId: string, rungY: number, layoutNodes: LayoutNode[]) => {
      for (const node of layoutNodes) {
        nodes.push({
          rungId,
          nodeId: node.nodeId,
          cx: this.RUNG_NUMBER_W + node.x + node.w / 2,
          cy: rungY + node.y + node.h / 2,
          order: nodes.length,
        });
        if (isLayoutBranch(node)) {
          for (const leg of node.legs) addNodes(rungId, rungY, leg.nodes);
        }
      }
    };
    for (const entry of this._rungLayoutData) {
      addNodes(entry.rungId, entry.y, entry.layout.nodes);
    }
    return nodes;
  }

  /**
   * Return which branch leg is under the canvas point, ignoring the rail strips
   * themselves (those are handled by hitTestNode).  Used for hover highlighting.
   */
  hitTestLeg(
    canvasX: number,
    canvasY: number
  ): { rungId: string; branchId: string; legId: string } | null {
    const entry = this._rungLayoutData.find(
      e => canvasY >= e.y && canvasY < e.y + e.h
    );
    if (!entry) return null;
    const localX = canvasX - this.RUNG_NUMBER_W;
    const localY = canvasY - entry.y;
    const hit = this._hitTestLegInNodes(entry.layout.nodes, localX, localY);
    if (!hit) return null;
    return { rungId: entry.rungId, ...hit };
  }

  private _hitTestLegInNodes(
    nodes: LayoutNode[],
    localX: number,
    localY: number
  ): { branchId: string; legId: string } | null {
    for (const node of nodes) {
      if (!isLayoutBranch(node)) continue;
      // Must be within the branch's bounding box
      if (localX < node.leftRailX || localX > node.rightRailX + BRANCH_RAIL_W) continue;
      if (localY < node.y || localY > node.y + node.h) continue;
      // Exclude the rail strips themselves
      const onLeftRail  = localX <= node.leftRailX + BRANCH_RAIL_W;
      const onRightRail = localX >= node.rightRailX;
      if (onLeftRail || onRightRail) continue;

      // Find the leg whose y band contains the cursor
      for (let i = 0; i < node.legs.length; i++) {
        const leg   = node.legs[i];
        const yTop  = i === 0
          ? node.y
          : (node.legs[i - 1].wireY + leg.wireY) / 2;
        const yBot  = i === node.legs.length - 1
          ? node.y + node.h
          : (leg.wireY + node.legs[i + 1].wireY) / 2;
        if (localY < yTop || localY > yBot) continue;
        // Recurse into nested branches first
        const nested = this._hitTestLegInNodes(leg.nodes, localX, localY);
        if (nested) return nested;
        return { branchId: node.nodeId, legId: leg.legId };
      }
    }
    return null;
  }

  /**
   * Draw a subtle blue tint over the given branch leg to indicate hover.
   */
  showLegHover(rungId: string, branchId: string, legId: string) {
    this._hoverGfx.clear();
    this._hoverGfx.removeChildren().forEach(c => c.destroy({ children: true }));
    const entry = this._rungLayoutData.find(e => e.rungId === rungId);
    if (!entry) return;
    const branch = this._findLayoutNode(entry.layout.nodes, branchId);
    if (!branch || !isLayoutBranch(branch)) return;
    const legIdx = branch.legs.findIndex(l => l.legId === legId);
    if (legIdx < 0) return;
    const leg  = branch.legs[legIdx];
    const yTop = legIdx === 0
      ? branch.y
      : (branch.legs[legIdx - 1].wireY + leg.wireY) / 2;
    const yBot = legIdx === branch.legs.length - 1
      ? branch.y + branch.h
      : (leg.wireY + branch.legs[legIdx + 1].wireY) / 2;

    const absX = this.RUNG_NUMBER_W + branch.leftRailX + BRANCH_RAIL_W;
    const absY = entry.y + yTop;
    const bw   = branch.rightRailX - branch.leftRailX - BRANCH_RAIL_W;
    const bh   = yBot - yTop;

    // Subtle fill
    this._hoverGfx.rect(absX, absY, bw, bh).fill({ color: 0x4a8cff, alpha: 0.07 });
    // Wire-level accent line
    const wireAbsY = entry.y + leg.wireY;
    this._hoverGfx
      .moveTo(absX, wireAbsY)
      .lineTo(absX + bw, wireAbsY)
      .stroke({ color: 0x4a8cff, alpha: 0.35, width: 1.5 });
  }

  clearLegHover() {
    this._hoverGfx.clear();
    this._hoverGfx.removeChildren().forEach(c => c.destroy({ children: true }));
  }

  /**
   * Highlight the left or right vertical rail of a branch when the cursor
   * hovers over it, signalling that it can be dragged.
   */
  showRailHover(rungId: string, branchId: string, side: "left" | "right") {
    this._railHoverGfx.clear();
    const entry = this._rungLayoutData.find(e => e.rungId === rungId);
    if (!entry) return;
    const branch = this._findLayoutNode(entry.layout.nodes, branchId);
    if (!branch || !isLayoutBranch(branch)) return;

    const firstWY    = branch.legs[0]?.wireY ?? branch.wireY;
    const lastWY     = branch.legs[branch.legs.length - 1]?.wireY ?? branch.wireY;
    const railLocalX = side === "left" ? branch.leftRailX : branch.rightRailX;
    const absRailX   = this.RUNG_NUMBER_W + railLocalX;
    const absY1      = entry.y + firstWY;
    const railH      = Math.max(lastWY - firstWY, 4);

    // Soft glow halo around the rail
    this._railHoverGfx
      .rect(absRailX - 5, absY1, BRANCH_RAIL_W + 10, railH)
      .fill({ color: 0x00d4aa, alpha: 0.14 });
    // Bright rail overlay
    this._railHoverGfx
      .rect(absRailX, absY1, BRANCH_RAIL_W, railH)
      .fill({ color: 0x00d4aa, alpha: 0.9 });

    // Chevron arrows at the mid-wire level showing drag direction
    const midY = entry.y + branch.wireY;
    if (side === "right") {
      const ax = absRailX + BRANCH_RAIL_W + 5;
      this._railHoverGfx
        .moveTo(ax,      midY - 5).lineTo(ax + 5,  midY).lineTo(ax,      midY + 5)
        .stroke({ color: 0x00d4aa, width: 2, alpha: 0.9 });
      this._railHoverGfx
        .moveTo(ax + 5,  midY - 5).lineTo(ax + 10, midY).lineTo(ax + 5,  midY + 5)
        .stroke({ color: 0x00d4aa, width: 2, alpha: 0.45 });
    } else {
      const ax = absRailX - 5;
      this._railHoverGfx
        .moveTo(ax,      midY - 5).lineTo(ax - 5,  midY).lineTo(ax,      midY + 5)
        .stroke({ color: 0x00d4aa, width: 2, alpha: 0.9 });
      this._railHoverGfx
        .moveTo(ax - 5,  midY - 5).lineTo(ax - 10, midY).lineTo(ax - 5,  midY + 5)
        .stroke({ color: 0x00d4aa, width: 2, alpha: 0.45 });
    }
  }

  clearRailHover() {
    this._railHoverGfx.clear();
  }

  /**
   * Subtle tint on any instruction (or branch body) the cursor is hovering over.
   * Clears _hoverGfx, so mutually exclusive with showLegHover.
   */
  showInstructionHover(rungId: string, nodeId: string) {
    this._hoverGfx.clear();
    this._hoverGfx.removeChildren().forEach(c => c.destroy({ children: true }));
    const entry = this._rungLayoutData.find(e => e.rungId === rungId);
    if (!entry) return;
    const node = this._findLayoutNode(entry.layout.nodes, nodeId);
    if (!node) return;
    this._hoverGfx
      .rect(this.RUNG_NUMBER_W + node.x, entry.y + node.y, node.w, node.h)
      .fill({ color: 0x4a8cff, alpha: 0.06 });
  }

  showInstructionFieldHover(
    rungId: string,
    nodeId: string,
    rowIndex: number,
    rowCount: number,
    valid: boolean,
    label?: string
  ) {
    this._hoverGfx.clear();
    this._hoverGfx.removeChildren().forEach(c => c.destroy({ children: true }));
    const entry = this._rungLayoutData.find(e => e.rungId === rungId);
    if (!entry) return;
    const node = this._findLayoutNode(entry.layout.nodes, nodeId);
    if (!node) return;

    const color = valid ? 0x4a8cff : 0xff4455;
    const bx = this.RUNG_NUMBER_W + node.x + 8;
    const bw = Math.max(node.w - 16, 24);
    const headerBottom = entry.y + node.wireY + 5;
    const bodyBottom = entry.y + node.y + node.h - 6;
    const bodyH = Math.max(bodyBottom - headerBottom, 18);
    const rowH = bodyH / Math.max(rowCount, 1);
    const y = headerBottom + rowH * rowIndex;

    this._hoverGfx
      .roundRect(bx, y, bw, rowH, 3)
      .fill({ color, alpha: valid ? 0.18 : 0.13 })
      .stroke({ color, width: 1.5, alpha: valid ? 0.9 : 0.8 });

    if (label) {
      const txt = new Text({
        text: label,
        style: new TextStyle({
          fontFamily: "Consolas, monospace",
          fontSize: 9,
          fill: color,
          fontWeight: "bold",
        }),
      });
      txt.anchor.set(0, 0.5);
      txt.position.set(bx + 4, y + rowH / 2);
      this._hoverGfx.addChild(txt);
    }
  }

  showInstructionTagHover(rungId: string, nodeId: string, valid: boolean) {
    this._hoverGfx.clear();
    this._hoverGfx.removeChildren().forEach(c => c.destroy({ children: true }));
    const entry = this._rungLayoutData.find(e => e.rungId === rungId);
    if (!entry) return;
    const node = this._findLayoutNode(entry.layout.nodes, nodeId);
    if (!node) return;

    const color = valid ? 0x4a8cff : 0xff4455;
    const absX = this.RUNG_NUMBER_W + node.x;
    const tagW = Math.min(node.w + 8, 86);
    const tagH = 20;
    const tagX = absX + node.w / 2 - tagW / 2;
    const tagY = entry.y + node.wireY - 31;

    this._hoverGfx
      .roundRect(tagX, tagY, tagW, tagH, 4)
      .fill({ color, alpha: valid ? 0.16 : 0.12 })
      .stroke({ color, width: 1.5, alpha: 0.9 });

    const txt = new Text({
      text: "Tag",
      style: new TextStyle({
        fontFamily: "Consolas, monospace",
        fontSize: 9,
        fill: color,
        fontWeight: "bold",
      }),
    });
    txt.anchor.set(0.5, 0.5);
    txt.position.set(tagX + tagW / 2, tagY + tagH / 2);
    this._hoverGfx.addChild(txt);
  }

  /**
   * Returns absolute canvas x-midpoints of series nodes adjacent to the branch
   * on the given side, ordered from closest to furthest.
   * Used by the drag handler to count how many nodes the cursor has passed.
   */
  getAdjacentSeriesXMids(rungId: string, branchId: string, side: "left" | "right"): number[] {
    const entry = this._rungLayoutData.find(e => e.rungId === rungId);
    if (!entry) return [];

    const findContainingSeries = (nodes: LayoutNode[]): LayoutNode[] | null => {
      if (nodes.some(n => n.nodeId === branchId)) return nodes;
      for (const node of nodes) {
        if (!isLayoutBranch(node)) continue;
        for (const leg of node.legs) {
          const found = findContainingSeries(leg.nodes);
          if (found) return found;
        }
      }
      return null;
    };

    const nodes = findContainingSeries(entry.layout.nodes);
    if (!nodes) return [];
    const idx = nodes.findIndex(n => n.nodeId === branchId);
    if (idx < 0) return [];

    if (side === "right") {
      return nodes.slice(idx + 1).map(n => this.RUNG_NUMBER_W + n.x + n.w / 2);
    } else {
      // Reverse so closest is first
      return nodes.slice(0, idx).map(n => this.RUNG_NUMBER_W + n.x + n.w / 2).reverse();
    }
  }

  /**
   * Returns absolute canvas x-midpoints of nodes inside a branch leg, ordered
   * from the given rail edge inward (so "closest to the rail" is index 0).
   * Used by the drag handler to count how many leg nodes the cursor has passed.
   */
  getLegNodeXMids(rungId: string, branchId: string, legId: string, side: "left" | "right"): number[] {
    const entry = this._rungLayoutData.find(e => e.rungId === rungId);
    if (!entry) return [];
    const branch = this._findLayoutNode(entry.layout.nodes, branchId);
    if (!branch || !isLayoutBranch(branch)) return [];
    const leg = branch.legs.find(l => l.legId === legId);
    if (!leg) return [];
    const mids = leg.nodes.map(n => this.RUNG_NUMBER_W + n.x + n.w / 2);
    // For the right rail, the closest node to the rail is the LAST one → reverse
    return side === "right" ? [...mids].reverse() : mids;
  }

  /**
   * Adds branch-level decorations on top of the rung preview tint during an
   * active rail drag: a teal border around the branch + the dragged rail lit up.
   * Call AFTER showPreviewTint() so _previewGfx has the base tint already.
   */
  showBranchDragActive(rungId: string, branchId: string, side: "left" | "right") {
    const entry = this._rungLayoutData.find(e => e.rungId === rungId);
    if (!entry) return;
    const branch = this._findLayoutNode(entry.layout.nodes, branchId);
    if (!branch || !isLayoutBranch(branch)) return;

    const absX = this.RUNG_NUMBER_W + branch.x;
    const absY = entry.y + branch.y;

    // Teal border around the branch bounding box
    this._previewGfx
      .rect(absX - 2, absY - 2, branch.w + 4, branch.h + 4)
      .stroke({ color: 0x00d4aa, width: 1.5, alpha: 0.75 });

    // Bright rail on the side being dragged
    const firstWY    = branch.legs[0]?.wireY ?? branch.wireY;
    const lastWY     = branch.legs[branch.legs.length - 1]?.wireY ?? branch.wireY;
    const railLocalX = side === "left" ? branch.leftRailX : branch.rightRailX;
    const absRailX   = this.RUNG_NUMBER_W + railLocalX;
    this._previewGfx
      .rect(absRailX - 1, entry.y + firstWY, BRANCH_RAIL_W + 2, lastWY - firstWY)
      .fill({ color: 0x00d4aa, alpha: 1.0 });
  }

  /** Walk the layout tree to find a node by id. */
  private _findLayoutNode(nodes: LayoutNode[], nodeId: string): LayoutNode | undefined {
    for (const n of nodes) {
      if (n.nodeId === nodeId) return n;
      if (isLayoutBranch(n)) {
        for (const leg of n.legs) {
          const found = this._findLayoutNode(leg.nodes, nodeId);
          if (found) return found;
        }
      }
    }
    return undefined;
  }

  // ── Live preview tint (pointer-based rail drag) ───────────────────────────

  /**
   * Return the absolute y position and height of a rung in the canvas.
   * Valid after the most recent render() call.
   */
  getRungBounds(rungId: string): { y: number; h: number } | null {
    const entry = this._rungLayoutData.find(e => e.rungId === rungId);
    return entry ? { y: entry.y, h: entry.h } : null;
  }

  /**
   * Draw a subtle teal tint + left accent bar over the rung being live-previewed.
   * Call after render() so _rungLayoutData is fresh.
   */
  showPreviewTint(rungId: string) {
    this._previewGfx.clear();
    const entry = this._rungLayoutData.find(e => e.rungId === rungId);
    if (!entry) return;
    const { y, h } = entry;
    // Left accent bar — solid teal stripe so the user knows this rung is live
    this._previewGfx
      .rect(this.RUNG_NUMBER_W - 3, y, 3, h)
      .fill({ color: 0x00d4aa, alpha: 1.0 });
    // Subtle teal fill over the rung body
    this._previewGfx
      .rect(this.RUNG_NUMBER_W, y, 8000, h)
      .fill({ color: 0x00d4aa, alpha: 0.06 });
  }

  clearPreviewTint() {
    this._previewGfx.clear();
  }

  // ── Rung reorder helpers ──────────────────────────────────────────────────

  /**
   * Return the rungId if canvasX/Y falls inside the gutter (left number column).
   * Returns null if outside the gutter or no rung at that Y.
   */
  hitTestGutter(canvasX: number, canvasY: number): string | null {
    if (canvasX >= this.RUNG_NUMBER_W) return null;
    const entry = this._rungLayoutData.find(
      e => canvasY >= e.y && canvasY < e.y + e.h
    );
    return entry?.rungId ?? null;
  }

  /**
   * Narrower than the full gutter: only the rung-number side starts online edit.
   * The rail-adjacent gutter strip is intentionally excluded so body/comment
   * double-clicks near the rail do not accidentally enter online edit.
   */
  hitTestOnlineEditGutter(canvasX: number, canvasY: number): string | null {
    if (canvasX < 6 || canvasX > this.RUNG_NUMBER_W - 13) return null;
    return this.hitTestGutter(canvasX, canvasY);
  }

  /**
   * Return true if (canvasX, canvasY) is over the × delete icon in the gutter.
   * The × is drawn at canvas X ≈ 10, canvas Y = rungY + wireY.
   */
  hitTestRungDeleteButton(canvasX: number, canvasY: number): boolean {
    if (canvasX >= this.RUNG_NUMBER_W) return false;
    const entry = this._rungLayoutData.find(
      e => canvasY >= e.y && canvasY < e.y + e.h
    );
    if (!entry) return false;
    return this._isLocalRungDeleteHit(
      canvasX - this.RUNG_NUMBER_W,
      canvasY - entry.y,
      entry.layout.wireY
    );
  }

  private _isLocalRungDeleteHit(localX: number, localY: number, wireY: number): boolean {
    const x = -this.RUNG_NUMBER_W + 1;
    const y = wireY - 10;
    return localX >= x && localX <= x + 20 && localY >= y && localY <= y + 20;
  }

  /**
   * Return the insertion point (above/below which rung) closest to canvasY,
   * and the absolute Y of the drop indicator line to draw.
   * insertAfterRungId = null means "insert at the very top".
   */
  queryRungDropY(
    canvasY: number
  ): { insertAfterRungId: string | null; lineY: number } | null {
    if (this._rungLayoutData.length === 0) return null;
    for (let i = 0; i < this._rungLayoutData.length; i++) {
      const entry = this._rungLayoutData[i];
      if (canvasY >= entry.y && canvasY < entry.y + entry.h) {
        const midY = entry.y + entry.h / 2;
        if (canvasY < midY) {
          // Drop BEFORE this rung = after the previous one (or at top)
          const prevId = i > 0 ? this._rungLayoutData[i - 1].rungId : null;
          return { insertAfterRungId: prevId, lineY: entry.y };
        } else {
          // Drop AFTER this rung
          return { insertAfterRungId: entry.rungId, lineY: entry.y + entry.h };
        }
      }
    }
    // Below all rungs → append at the bottom
    const last = this._rungLayoutData[this._rungLayoutData.length - 1];
    return { insertAfterRungId: last.rungId, lineY: last.y + last.h };
  }

  /** Draw a horizontal amber indicator line at the given absolute Y. */
  showRungDropLine(lineY: number) {
    this._rungDropGfx.clear();
    const color = 0xf0a030;
    // Full-width line
    this._rungDropGfx
      .rect(this.RUNG_NUMBER_W, lineY - 2, 8000, 3)
      .fill({ color, alpha: 0.9 });
    // Left triangle handle
    this._rungDropGfx
      .poly([
        this.RUNG_NUMBER_W,      lineY - 7,
        this.RUNG_NUMBER_W + 10, lineY,
        this.RUNG_NUMBER_W,      lineY + 7,
      ])
      .fill({ color, alpha: 0.9 });
    // Right triangle handle (at a fixed x offset)
    this._rungDropGfx
      .poly([
        this.RUNG_NUMBER_W + 20, lineY - 5,
        this.RUNG_NUMBER_W + 12, lineY,
        this.RUNG_NUMBER_W + 20, lineY + 5,
      ])
      .fill({ color, alpha: 0.55 });
  }

  clearRungDropLine() {
    this._rungDropGfx.clear();
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────

  destroy() {
    this._stage.destroy({ children: true });
  }
}
