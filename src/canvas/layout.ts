// =============================================================================
// Deterministic Layout Engine
// =============================================================================
// Input:  a Rung (AST)
// Output: LayoutRung — pixel positions for every wire segment, instruction
//         block, and branch shape. Nothing is drawn here; the renderer reads
//         this data structure and draws from it.
//
// Coordinate system:
//   x increases to the right
//   y increases downward
//   Origin (0,0) = left edge of the left power rail, vertical centre of rung
// =============================================================================

import type { Rung, SeriesNode, InstructionNode, BranchNode } from "../model/types";
import { isOutput } from "../model/types";
import { isInstruction, isBranch } from "../model/ast";

// ---------------------------------------------------------------------------
// Sizing constants
// ---------------------------------------------------------------------------

export const RAIL_W        = 6;    // width of left/right power rail
export const INST_W        = 80;   // instruction block width
export const FUNCTION_INST_W = 104; // compare/move/math blocks need room for live values
export const INST_H        = 52;   // instruction block height (contacts / coils / RES)
export const COMPLEX_INST_H       = 88;  // taller block for TON/TOF/RTO/CTU/CTD
export const COMPLEX_INST_WIRE_Y  = 20;  // wireYLocal for complex blocks (wire near top)
export const INST_GAP      = 16;   // horizontal gap between series elements
export const BRANCH_PAD_H  = 34;   // horizontal padding inside branch rails
export const BRANCH_PAD_V  = 10;   // vertical padding above/below each leg
export const LEG_GAP_V     = 4;    // extra gap between legs inside a branch
export const BRANCH_RAIL_W = 4;    // width of branch vertical bars
export const RUNG_PAD_H    = 20;   // horizontal padding inside rung body (after rail)
export const WIRE_Y_HALF   = INST_H / 2;  // wire runs at the centre of instruction height
export const BAND_FOLD_H   = 28;   // vertical gap between bands for fold-wrap connectors
export const COMMENT_H     = 16;   // height of per-instruction comment area (when visible)
export const RUNG_COMMENT_H = 20;  // height of rung comment bar (when visible)

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

/** A positioned instruction block */
export interface LayoutInstruction {
  nodeId: string;
  x: number;        // left edge
  y: number;        // top edge
  w: number;
  h: number;
  /** y of the wire centreline through this instruction */
  wireY: number;
}

/** A single leg within a branch */
export interface LayoutLeg {
  legId: string;
  /** y of the wire that runs through this leg */
  wireY: number;
  /** child nodes laid out within this leg */
  nodes: LayoutNode[];
  /** total content width of this leg (excluding branch rails) */
  contentW: number;
}

/** A positioned branch group */
export interface LayoutBranch {
  nodeId: string;
  x: number;
  y: number;        // top of the whole branch block
  w: number;        // total width including branch rails
  h: number;        // total height
  /** y of the output wire (bottom of top rail join) */
  wireY: number;
  legs: LayoutLeg[];
  /** x of left vertical rail (absolute) */
  leftRailX: number;
  /** x of right vertical rail */
  rightRailX: number;
}

export type LayoutNode = LayoutInstruction | LayoutBranch;

export function isLayoutInstruction(n: LayoutNode): n is LayoutInstruction {
  return !("legs" in n);
}

export function isLayoutBranch(n: LayoutNode): n is LayoutBranch {
  return "legs" in n;
}

/**
 * Result of a canvas hit-test.
 * Exactly one of legId / rail may be set (never both):
 *  - neither  → instruction node was clicked (drag to reorder)
 *  - legId    → click is inside a specific branch leg body (not on an instruction)
 *  - rail     → click is on the branch's left or right vertical rail (drag to extend/shrink)
 */
export interface HitResult {
  nodeId: string;
  /** Set when the click lands inside a branch leg area (not on an instruction) */
  legId?: string;
  /** Set when the click lands on a branch's left or right vertical rail */
  rail?: "left" | "right";
}

/**
 * One horizontal band in a multi-band rung.
 * Bands are used when the total series width exceeds the available canvas width;
 * instead of expanding horizontally the rung folds into multiple stacked rows.
 */
export interface LayoutBand {
  /** Absolute Y of the wire centreline for this band (rung-container space) */
  wireY: number;
  /** Absolute Y of the top of this band's content area */
  topY: number;
  /** Total height of this band's content (above + below wire) */
  bandH: number;
  /** Index of the first LayoutNode in this band within LayoutRung.nodes */
  firstNodeIdx: number;
  /** Index of the last LayoutNode (inclusive) in this band within LayoutRung.nodes */
  lastNodeIdx: number;
}

/** A complete laid-out rung */
export interface LayoutRung {
  rungId: string;
  /** total height of rung (excluding rung chrome like number strip) */
  totalH: number;
  /** y centreline for the main horizontal wire (= first band's wireY) */
  wireY: number;
  /** x where the left rail ends / series starts */
  seriesStartX: number;
  /** x where the right rail starts */
  seriesEndX: number;
  nodes: LayoutNode[];
  /**
   * Defined when the rung content is split across multiple horizontal bands
   * (fold-wrap layout).  Undefined for single-band rungs (the common case).
   */
  bands?: LayoutBand[];
  /**
   * Height reserved at the top of the rung container for the rung comment bar.
   * 0 when rung comments are hidden; RUNG_COMMENT_H when visible.
   * All node y-positions already include this offset.
   */
  commentAreaH: number;
}

// ---------------------------------------------------------------------------
// Size measurement pass (bottom-up)
// ---------------------------------------------------------------------------

interface SizeResult {
  w: number;
  h: number;
  /** The wire y relative to the top of this element's bounding box */
  wireYLocal: number;
}

const TIMER_COUNTER_TYPES   = new Set(["TON", "TOF", "RTO", "CTU", "CTD"]);
const COMPARE_MOVE_TYPES    = new Set([
  "EQU", "NEQ", "LES", "LEQ", "GRT", "GEQ", "MOV", "MVM",
  "ADD", "SUB", "MUL", "DIV", "MOD", "NEG", "ABS", "SQR", "CLR",
  "JSR",
]);

/** Set before each layoutRung call; used by measureInstruction (single-threaded, safe). */
let _showNodeComments = false;

function measureInstruction(node: InstructionNode): SizeResult {
  const ch = _showNodeComments ? COMMENT_H : 0;
  if (TIMER_COUNTER_TYPES.has(node.type)) {
    return { w: INST_W, h: COMPLEX_INST_H + ch, wireYLocal: COMPLEX_INST_WIRE_Y + ch };
  }
  if (COMPARE_MOVE_TYPES.has(node.type)) {
    // Two data rows (sourceA/B or source/dest) — a bit shorter than timers
    return { w: FUNCTION_INST_W, h: 72 + ch, wireYLocal: COMPLEX_INST_WIRE_Y + ch };
  }
  return { w: INST_W, h: INST_H + ch, wireYLocal: INST_H / 2 + ch };
}

function measureBranch(node: BranchNode): SizeResult {
  // Each leg: measure its series content
  const legSizes = node.legs.map(leg => measureSeries(leg.nodes));

  // Branch width = widest leg + 2 branch rails
  const maxLegW = Math.max(...legSizes.map(s => s.w), INST_W);

  // Branch height = sum of all leg heights + padding
  let totalH = BRANCH_PAD_V; // top padding
  for (const ls of legSizes) {
    totalH += ls.h + LEG_GAP_V;
  }
  totalH += BRANCH_PAD_V - LEG_GAP_V; // bottom padding

  const totalW = maxLegW + BRANCH_RAIL_W * 2 + BRANCH_PAD_H * 2;

  // Wire enters/exits at the midpoint of the first leg's wire
  const firstLegWireYLocal = BRANCH_PAD_V + legSizes[0].wireYLocal;

  return { w: totalW, h: totalH, wireYLocal: firstLegWireYLocal };
}

function measureSeries(nodes: SeriesNode[]): SizeResult {
  if (nodes.length === 0) {
    return { w: INST_W, h: INST_H, wireYLocal: INST_H / 2 };
  }

  const sizes = nodes.map(n =>
    isInstruction(n) ? measureInstruction(n) : measureBranch(n)
  );

  const totalW = sizes.reduce((sum, s) => sum + s.w, 0)
    + INST_GAP * (sizes.length - 1);

  // All elements in a series share the same wire centreline.
  // A branch's wireYLocal is NOT its midpoint — it's where leg[0]'s wire sits,
  // which can be near the top when many legs stack below.
  // Compute the maximum space each element needs above and below the wire
  // independently, then derive the correct total height.
  const maxAbove = Math.max(...sizes.map(s => s.wireYLocal));
  const maxBelow = Math.max(...sizes.map(s => s.h - s.wireYLocal));
  const totalH   = maxAbove + maxBelow;

  return { w: totalW, h: totalH, wireYLocal: maxAbove };
}

// ---------------------------------------------------------------------------
// Placement pass (top-down)
// ---------------------------------------------------------------------------

function placeNodes(
  nodes: SeriesNode[],
  startX: number,
  wireY: number   // absolute y of the wire centreline
): LayoutNode[] {
  const result: LayoutNode[] = [];
  let curX = startX;

  for (const node of nodes) {
    if (isInstruction(node)) {
      const m = measureInstruction(node);
      const top = wireY - m.wireYLocal;
      result.push({
        nodeId: node.id,
        x: curX,
        y: top,
        w: m.w,
        h: m.h,
        wireY,
      } satisfies LayoutInstruction);
      curX += m.w + INST_GAP;
    } else {
      const br = placeBranch(node, curX, wireY);
      result.push(br);
      curX += br.w + INST_GAP;
    }
  }

  return result;
}

function isOutputSectionNode(node: SeriesNode): boolean {
  if (isInstruction(node)) return isOutput(node.type);
  // A branch is treated as an "output node" when every leg contains
  // only coil output instructions — i.e. parallel outputs (Studio 5000 style).
  if (isBranch(node)) {
    return node.legs.every(leg =>
      leg.nodes.length === 0 ||
      leg.nodes.every(isOutputSectionNode)
    );
  }
  return false;
}

function outputSectionStartIndex(nodes: SeriesNode[]): number {
  return nodes.findIndex(isOutputSectionNode);
}

function placeTopLevelNodes(
  nodes: SeriesNode[],
  startX: number,
  endX: number,
  wireY: number
): LayoutNode[] {
  const firstOutputIdx = outputSectionStartIndex(nodes);
  if (firstOutputIdx === -1) return placeNodes(nodes, startX, wireY);

  const inputNodes = nodes.slice(0, firstOutputIdx);
  const outputNodes = nodes.slice(firstOutputIdx);
  const outputSize = measureSeries(outputNodes);
  const outputStartX = endX - outputSize.w;

  return [
    ...placeNodes(inputNodes, startX, wireY),
    ...placeNodes(outputNodes, outputStartX, wireY),
  ];
}

function placeBranch(
  node: BranchNode,
  x: number,
  wireY: number   // wire enters from the left at this y
): LayoutBranch {
  const legSizes = node.legs.map(leg => measureSeries(leg.nodes));
  const maxLegW  = Math.max(...legSizes.map(s => s.w), INST_W);
  const innerW   = maxLegW;                          // content area width
  const totalW   = innerW + BRANCH_RAIL_W * 2 + BRANCH_PAD_H * 2;

  // Lay legs out top-to-bottom; first leg's wire aligns with incoming wireY
  // Compute y offsets for each leg
  const legYOffsets: number[] = [];
  let curY = 0;
  for (const ls of legSizes) {
    legYOffsets.push(curY);
    curY += ls.h + LEG_GAP_V;
  }
  const totalInnerH = curY - LEG_GAP_V;
  const totalH = totalInnerH + BRANCH_PAD_V * 2;

  // First leg's wire sits at wireY (incoming). Compute branchTop from that.
  const firstLegWireLocal = legSizes[0].wireYLocal;
  const branchTop = wireY - BRANCH_PAD_V - firstLegWireLocal;

  const leftRailX  = x + BRANCH_PAD_H;
  const rightRailX = x + BRANCH_PAD_H + BRANCH_RAIL_W + innerW;
  const contentX   = leftRailX + BRANCH_RAIL_W;

  const layoutLegs: LayoutLeg[] = node.legs.map((leg, i) => {
    const legTop      = branchTop + BRANCH_PAD_V + legYOffsets[i];
    const legWireY    = legTop + legSizes[i].wireYLocal;
    const legNodes    = placeNodes(leg.nodes, contentX, legWireY);
    return {
      legId:    leg.id,
      wireY:    legWireY,
      nodes:    legNodes,
      contentW: legSizes[i].w,
    };
  });

  return {
    nodeId:     node.id,
    x,
    y:          branchTop,
    w:          totalW,
    h:          totalH,
    wireY,
    legs:       layoutLegs,
    leftRailX,
    rightRailX,
  };
}

// ---------------------------------------------------------------------------
// Helper: shift all node y/wireY values (for rung comment bar offset)
// ---------------------------------------------------------------------------

function shiftNodes(nodes: LayoutNode[], dy: number): void {
  for (const n of nodes) {
    n.y      += dy;
    n.wireY  += dy;
    if (isLayoutBranch(n)) {
      for (const leg of n.legs) {
        leg.wireY += dy;
        shiftNodes(leg.nodes, dy);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export interface LayoutRungOptions {
  showNodeComments?: boolean;
  showRungComments?: boolean;
}

/**
 * Compute the full pixel layout for a rung.
 * @param rung        The rung to lay out.
 * @param availableW  The width available for the rung body (excluding outer chrome).
 * @param opts        Optional flags for comment visibility (affects heights).
 *
 * When the series of input nodes is wider than availableW the rung is split into
 * multiple stacked horizontal "bands" (fold-wrap layout, Studio 5000 style).
 * Output coils are always right-aligned in the last band.
 * Single-band rungs that fit within availableW behave exactly as before; the
 * returned LayoutRung has no `bands` field.
 */
export function layoutRung(rung: Rung, availableW: number, opts?: LayoutRungOptions): LayoutRung {
  _showNodeComments = opts?.showNodeComments ?? false;
  const commentAreaH = (opts?.showRungComments ?? false) && rung.comment.trim()
    ? RUNG_COMMENT_H
    : 0;
  const seriesStartX = RAIL_W + RUNG_PAD_H;
  const minHalf      = (INST_H + BRANCH_PAD_V * 2) / 2;

  // ── Determine if multi-band layout is required ─────────────────────────────
  // Separate output coils from input nodes; outputs are always right-aligned.
  const firstOutputIdx = outputSectionStartIndex(rung.nodes);
  const inputNodesSrc  = firstOutputIdx >= 0 ? rung.nodes.slice(0, firstOutputIdx) : rung.nodes;
  const outputNodesSrc = firstOutputIdx >= 0 ? rung.nodes.slice(firstOutputIdx)     : [];

  // Width available for a single band of input content
  const maxBandContentW = availableW - seriesStartX - RUNG_PAD_H - RAIL_W;
  const inputSize       = measureSeries(inputNodesSrc);

  const needsMultiBand = inputNodesSrc.length > 1 && inputSize.w > maxBandContentW;

  // ── Single-band path (original behaviour) ─────────────────────────────────
  if (!needsMultiBand) {
    const size = measureSeries(rung.nodes);

    const wireY      = Math.max(size.wireYLocal + BRANCH_PAD_V, minHalf);
    const spaceBelow = Math.max(size.h - size.wireYLocal + BRANCH_PAD_V, minHalf);
    const totalH     = wireY + spaceBelow;

    // Expand the rung body if content is wider than the canvas (deep branches, etc.)
    const minBodyW   = seriesStartX + size.w + RUNG_PAD_H + RAIL_W;
    const effectiveW = Math.max(availableW, minBodyW);
    const seriesEndX = effectiveW - RAIL_W - RUNG_PAD_H;

    const nodes = placeTopLevelNodes(rung.nodes, seriesStartX, seriesEndX, wireY);
    if (commentAreaH > 0) {
      shiftNodes(nodes, commentAreaH);
      return { rungId: rung.id, totalH: totalH + commentAreaH, wireY: wireY + commentAreaH,
               seriesStartX, seriesEndX, nodes, commentAreaH };
    }
    return { rungId: rung.id, totalH, wireY, seriesStartX, seriesEndX, nodes, commentAreaH: 0 };
  }

  // ── Multi-band path ────────────────────────────────────────────────────────
  // seriesEndX is capped at availableW — we fold instead of expanding.
  const seriesEndX = availableW - RAIL_W - RUNG_PAD_H;

  // Greedy-pack input nodes into bands of ≤ maxBandContentW width.
  // Branches are atomic — they are never split across bands.
  const bandInputGroups: SeriesNode[][] = [];
  let curBand: SeriesNode[] = [];
  let curBandW = 0;

  for (const node of inputNodesSrc) {
    const nm  = isInstruction(node) ? measureInstruction(node) : measureBranch(node);
    const gap = curBand.length > 0 ? INST_GAP : 0;

    if (curBand.length > 0 && curBandW + gap + nm.w > maxBandContentW) {
      bandInputGroups.push(curBand);
      curBand  = [node];
      curBandW = nm.w;
    } else {
      curBand.push(node);
      curBandW += gap + nm.w;
    }
  }
  bandInputGroups.push(curBand); // push remaining nodes (last input band)

  // Place nodes band by band and accumulate LayoutBands + flat node list.
  const layoutBands: LayoutBand[] = [];
  const allNodes: LayoutNode[]    = [];
  let   curTopY   = 0;
  let   firstWireY = 0;

  for (let bi = 0; bi < bandInputGroups.length; bi++) {
    const isLastBand = bi === bandInputGroups.length - 1;
    // Last band includes the output coils so they stay right-aligned.
    const bandSrcNodes = isLastBand
      ? [...bandInputGroups[bi], ...outputNodesSrc]
      : bandInputGroups[bi];

    const bandSize   = measureSeries(bandSrcNodes);
    const wireYLocal = Math.max(bandSize.wireYLocal + BRANCH_PAD_V, minHalf);
    const spaceBelow = Math.max(bandSize.h - bandSize.wireYLocal + BRANCH_PAD_V, minHalf);
    const bandH      = wireYLocal + spaceBelow;
    const wireY      = curTopY + wireYLocal;

    if (bi === 0) firstWireY = wireY;

    // Last band: right-align output coils; other bands: left-align all nodes.
    const bandPlaced = isLastBand
      ? placeTopLevelNodes(bandSrcNodes, seriesStartX, seriesEndX, wireY)
      : placeNodes(bandSrcNodes, seriesStartX, wireY);

    const firstNodeIdx = allNodes.length;
    allNodes.push(...bandPlaced);
    const lastNodeIdx = allNodes.length - 1;

    layoutBands.push({ wireY, topY: curTopY, bandH, firstNodeIdx, lastNodeIdx });

    // Advance Y: add fold gap between bands (not after the last band).
    curTopY += bandH + (isLastBand ? 0 : BAND_FOLD_H);
  }

  // curTopY is now lastBand.topY + lastBand.bandH — add bottom padding.
  const totalH = curTopY + RUNG_PAD_H;

  if (commentAreaH > 0) {
    shiftNodes(allNodes, commentAreaH);
    for (const band of layoutBands) {
      band.wireY += commentAreaH;
      band.topY  += commentAreaH;
    }
    return {
      rungId: rung.id,
      totalH: totalH + commentAreaH,
      wireY: firstWireY + commentAreaH,
      seriesStartX, seriesEndX,
      nodes: allNodes,
      bands: layoutBands,
      commentAreaH,
    };
  }

  return {
    rungId: rung.id,
    totalH,
    wireY: firstWireY,
    seriesStartX, seriesEndX,
    nodes: allNodes,
    bands: layoutBands,
    commentAreaH: 0,
  };
}

// ---------------------------------------------------------------------------
// Helper: find a LayoutNode by nodeId anywhere in the tree
// ---------------------------------------------------------------------------

export function findLayoutNode(
  nodes: LayoutNode[],
  nodeId: string
): LayoutNode | undefined {
  for (const n of nodes) {
    if (n.nodeId === nodeId) return n;
    if (isLayoutBranch(n)) {
      for (const leg of n.legs) {
        const found = findLayoutNode(leg.nodes, nodeId);
        if (found) return found;
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Hit testing — given canvas (x, y), return which nodeId was clicked
// ---------------------------------------------------------------------------

export function hitTest(
  nodes: LayoutNode[],
  cx: number,
  cy: number
): HitResult | null {
  for (const n of nodes) {
    if (isLayoutInstruction(n)) {
      if (cx >= n.x && cx <= n.x + n.w && cy >= n.y && cy <= n.y + n.h) {
        return { nodeId: n.nodeId };
      }
    } else {
      const branch = n as LayoutBranch;
      // Instructions inside branch legs take priority — check them first.
      for (const leg of branch.legs) {
        const hit = hitTest(leg.nodes, cx, cy);
        if (hit) return hit;
      }
      // If the cursor is anywhere inside the branch bounding box:
      if (cx >= branch.x && cx <= branch.x + branch.w && cy >= branch.y && cy <= branch.y + branch.h) {
        // Left rail hit → drag to extend/shrink branch span leftward
        if (cx >= branch.leftRailX - 2 && cx <= branch.leftRailX + BRANCH_RAIL_W + 4) {
          return { nodeId: branch.nodeId, rail: "left" };
        }
        // Right rail hit → drag to extend/shrink branch span rightward
        if (cx >= branch.rightRailX - 4 && cx <= branch.rightRailX + BRANCH_RAIL_W + 2) {
          return { nodeId: branch.nodeId, rail: "right" };
        }
        // Clicks inside a leg's body → leg selection.
        // Assign to the closest leg by vertical distance.
        let bestLeg = branch.legs[0];
        let bestDist = Math.abs(cy - branch.legs[0].wireY);
        for (const leg of branch.legs.slice(1)) {
          const d = Math.abs(cy - leg.wireY);
          if (d < bestDist) { bestDist = d; bestLeg = leg; }
        }
        return { nodeId: branch.nodeId, legId: bestLeg.legId };
      }
    }
  }
  return null;
}
