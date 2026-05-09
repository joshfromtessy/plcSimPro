// =============================================================================
// Simulation Engine — PLC scan loop
// =============================================================================
// Evaluates rungs top-to-bottom, series left-to-right, branches as OR.
// Produces a ScanResult (power-flow state) and mutates tag values.
//
// Design: pure function over (rungs, tags) → (ScanResult, updatedTags).
// The store drives the scan loop; this file contains only the logic.
// =============================================================================

import type {
  Rung,
  Routine,
  SeriesNode,
  BranchLeg,
  TagDefinition,
  TagValue,
  TimerData,
  CounterData,
  ScanResult,
  RungPowerState,
  InstructionNode,
  TimerParams,
  CounterParams,
  CompareParams,
  MoveParams,
  MathParams,
  InstructionParams,
  JsrParams,
} from "./types";

import { isInstruction, isBranch } from "./ast";

interface ScanExecutionContext {
  routinesByName: Map<string, Routine>;
  result: ScanResult;
  callStack: string[];
  maxCallDepth: number;
}

// ---------------------------------------------------------------------------
// Tag lookup helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tag name parsing helpers
// ---------------------------------------------------------------------------

/**
 * Parses a tag reference into its components.
 *
 * Supported forms:
 *   "MyTag"           → { base: "MyTag", idx: undefined, bit: undefined }
 *   "MyTag[2]"        → { base: "MyTag", idx: 2, bit: undefined }
 *   "MyTag[2].5"      → { base: "MyTag", idx: 2, bit: 5 }
 *   "MyTag.5"         → { base: "MyTag", idx: undefined, bit: 5 }
 *   "MyTimer.DN"      → { base: "MyTimer", idx: undefined, bit: undefined, member: "DN" }
 */
interface ParsedTagRef {
  base: string;
  idx?: number;
  bit?: number;       // numeric bit index (0–31)
  member?: string;    // named struct member ("DN", "TT", etc.) — uppercase
}

function parseTagRef(name: string): ParsedTagRef {
  // Match: Base[idx].suffix  OR  Base.suffix  OR  Base[idx]  OR  Base
  const arrayBitRe = /^([A-Za-z_]\w*)\[(\d+)\]\.(\w+)$/;
  const arrayRe    = /^([A-Za-z_]\w*)\[(\d+)\]$/;
  const dotRe      = /^([A-Za-z_]\w*)\.(\w+)$/;

  let m: RegExpMatchArray | null;

  if ((m = name.match(arrayBitRe))) {
    const suffix = m[3];
    const bitNum = parseInt(suffix, 10);
    if (!isNaN(bitNum)) {
      return { base: m[1], idx: parseInt(m[2], 10), bit: bitNum };
    }
    return { base: m[1], idx: parseInt(m[2], 10), member: suffix.toUpperCase() };
  }

  if ((m = name.match(arrayRe))) {
    return { base: m[1], idx: parseInt(m[2], 10) };
  }

  if ((m = name.match(dotRe))) {
    const suffix = m[2];
    const bitNum = parseInt(suffix, 10);
    if (!isNaN(bitNum)) {
      return { base: m[1], bit: bitNum };
    }
    return { base: m[1], member: suffix.toUpperCase() };
  }

  return { base: name };
}

// ---------------------------------------------------------------------------
// Scalar word helpers
// ---------------------------------------------------------------------------

/** Get the integer element value for a DINT/INT tag (scalar or array element). */
function getWordValue(tag: TagDefinition, idx?: number): number {
  if (Array.isArray(tag.value)) {
    const i = idx ?? 0;
    return (tag.value as number[])[i] ?? 0;
  }
  return (tag.value as number) | 0;
}

/** Set the integer element value for a DINT/INT tag in place. */
function setWordValue(tag: TagDefinition, idx: number | undefined, val: number): void {
  if (Array.isArray(tag.value)) {
    const i = idx ?? 0;
    (tag.value as number[])[i] = val | 0;
  } else {
    tag.value = val | 0;
  }
}

// ---------------------------------------------------------------------------
// BOOL read/write (contact evaluation)
// ---------------------------------------------------------------------------

/** Read a BOOL tag value, returns false if not found */
function readBool(tags: Map<string, TagDefinition>, name: string): boolean {
  const tag = tags.get(name);
  if (!tag) return false;
  if (tag.dataType === "BOOL") return tag.value as boolean;
  return false;
}

/**
 * Read a tag bit — handles all notations:
 *   "MyBool"        → BOOL value
 *   "MyTimer.DN"    → TIMER/COUNTER named bit
 *   "MyDint.5"      → bit 5 of DINT scalar
 *   "MyArr[2]"      → element 2 of array (nonzero = true)
 *   "MyArr[2].5"    → bit 5 of element 2
 */
function readTagBit(
  tags: Map<string, TagDefinition>,
  tagName: string
): boolean {
  const ref = parseTagRef(tagName);
  const tag = tags.get(ref.base);
  if (!tag) return false;

  // ---- BOOL scalar ----
  if (tag.dataType === "BOOL" && ref.idx === undefined && ref.bit === undefined && ref.member === undefined) {
    return tag.value as boolean;
  }

  // ---- TIMER named members ----
  if (tag.dataType === "TIMER" && tag.timerData && ref.member) {
    const td = tag.timerData;
    switch (ref.member) {
      case "EN": return td.en;
      case "TT": return td.tt;
      case "DN": return td.dn;
    }
    return false;
  }

  // ---- COUNTER named members ----
  if (tag.dataType === "COUNTER" && tag.counterData && ref.member) {
    const cd = tag.counterData;
    switch (ref.member) {
      case "CU": return cd.cu;
      case "CD": return cd.cd;
      case "DN": return cd.dn;
      case "OV": return cd.ov;
      case "UN": return cd.un;
    }
    return false;
  }

  // ---- DINT / INT word or bit ----
  if (tag.dataType === "DINT" || tag.dataType === "INT") {
    const word = getWordValue(tag, ref.idx);
    if (ref.bit !== undefined) {
      return ((word >> ref.bit) & 1) === 1;
    }
    // Plain element access: treat nonzero as true
    return word !== 0;
  }

  return false;
}

function writeBool(
  tags: Map<string, TagDefinition>,
  name: string,
  value: boolean
): void {
  const ref = parseTagRef(name);
  const tag = tags.get(ref.base);
  if (!tag) return;

  // ---- BOOL scalar ----
  if (tag.dataType === "BOOL" && ref.idx === undefined && ref.bit === undefined) {
    tag.value = value;
    return;
  }

  // ---- DINT / INT bit write ----
  if ((tag.dataType === "DINT" || tag.dataType === "INT") && ref.bit !== undefined) {
    const word = getWordValue(tag, ref.idx);
    const bit = ref.bit & 31;
    const next = value
      ? (word | (1 << bit)) | 0
      : (word & ~(1 << bit)) | 0;
    setWordValue(tag, ref.idx, next);
  }
}

// ---------------------------------------------------------------------------
// Numeric operand resolution (compare / move)
// ---------------------------------------------------------------------------

/**
 * Resolve a compare/move operand to a number.
 * Operand is either:
 *   - A numeric literal string: "42", "-7", "3.14", "0xFF"
 *   - A tag name (including dot/array notation): "MyTag", "Arr[2].5", etc.
 */
function resolveOperand(operand: string, tags: Map<string, TagDefinition>): number {
  if (!operand) return 0;
  // Hex literal
  if (/^0x[0-9a-fA-F]+$/i.test(operand)) return parseInt(operand, 16);
  // Decimal/float literal
  const lit = Number(operand);
  if (!isNaN(lit)) return lit;
  // Tag reference
  return readTagNumber(operand, tags);
}

/** Read a tag as a number — handles BOOL, DINT, INT, REAL, and all dot/array notations. */
function readTagNumber(tagName: string, tags: Map<string, TagDefinition>): number {
  const ref = parseTagRef(tagName);
  const tag = tags.get(ref.base);
  if (!tag) return 0;

  if (tag.dataType === "BOOL") return readTagBit(tags, tagName) ? 1 : 0;
  if (tag.dataType === "REAL") return tag.value as number;
  if (tag.dataType === "DINT" || tag.dataType === "INT") {
    const word = getWordValue(tag, ref.idx);
    if (ref.bit !== undefined) return ((word >> ref.bit) & 1);
    return word;
  }
  if (tag.dataType === "TIMER" && tag.timerData && ref.member) {
    const td = tag.timerData;
    switch (ref.member) {
      case "PRE": return td.preset;
      case "ACC": return td.accum;
      case "EN": return td.en ? 1 : 0;
      case "TT": return td.tt ? 1 : 0;
      case "DN": return td.dn ? 1 : 0;
    }
  }
  if (tag.dataType === "COUNTER" && tag.counterData && ref.member) {
    const cd = tag.counterData;
    switch (ref.member) {
      case "PRE": return cd.preset;
      case "ACC": return cd.accum;
      case "CU": return cd.cu ? 1 : 0;
      case "CD": return cd.cd ? 1 : 0;
      case "DN": return cd.dn ? 1 : 0;
      case "OV": return cd.ov ? 1 : 0;
      case "UN": return cd.un ? 1 : 0;
    }
  }
  return 0;
}

/** Write a numeric value to a tag, handling BOOL, DINT, INT, REAL, and array/bit refs. */
function writeTagNumber(tagName: string, value: number, tags: Map<string, TagDefinition>): void {
  const ref = parseTagRef(tagName);
  const tag = tags.get(ref.base);
  if (!tag) return;

  if (tag.dataType === "BOOL") {
    writeBool(tags, tagName, value !== 0);
  } else if (tag.dataType === "REAL") {
    tag.value = value;
  } else if (tag.dataType === "DINT" || tag.dataType === "INT") {
    if (ref.bit !== undefined) {
      // bit write
      const word = getWordValue(tag, ref.idx);
      const b = ref.bit & 31;
      setWordValue(tag, ref.idx, (value !== 0 ? (word | (1 << b)) : (word & ~(1 << b))) | 0);
    } else {
      setWordValue(tag, ref.idx, value | 0);
    }
  } else if (tag.dataType === "TIMER" && tag.timerData && ref.member) {
    const td = tag.timerData;
    const next = Math.max(0, value | 0);
    if (ref.member === "PRE") td.preset = next;
    if (ref.member === "ACC") {
      td.accum = Math.min(next, td.preset);
      td.dn = td.accum >= td.preset;
      td.tt = td.en && !td.dn;
    }
  } else if (tag.dataType === "COUNTER" && tag.counterData && ref.member) {
    const cd = tag.counterData;
    const next = value | 0;
    if (ref.member === "PRE") {
      cd.preset = next;
      cd.dn = cd.accum >= cd.preset;
    }
    if (ref.member === "ACC") {
      cd.accum = next;
      cd.dn = cd.accum >= cd.preset;
    }
  }
}

// ---------------------------------------------------------------------------
// Preset resolution — literal or DINT/INT tag reference
// ---------------------------------------------------------------------------

function resolvePreset(
  params: InstructionParams,
  tags: Map<string, TagDefinition>,
  defaultValue: number,
  currentPreset?: number
): number {
  const p = params as TimerParams | CounterParams;
  if (p?.presetTag) {
    return readTagNumber(p.presetTag, tags);
  }
  return currentPreset ?? (p?.preset as number | undefined) ?? defaultValue;
}

// ---------------------------------------------------------------------------
// Instruction evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate a single instruction node against the current tag state.
 * Returns the "rung condition in" for this node — i.e., whether power passes through.
 * Does NOT write outputs here — outputs are handled by executeOutput.
 */
function evaluateContact(
  node: InstructionNode,
  tags: Map<string, TagDefinition>,
  conditionIn: boolean
): boolean {
  switch (node.type) {
    case "XIC":
      return conditionIn && readTagBit(tags, node.tagName);
    case "XIO":
      return conditionIn && !readTagBit(tags, node.tagName);
    case "AFI":
      return false;
    case "OSR":
    case "OSF":
      // One-shots require tracking previous state per node — handled via _osBitMap
      // Simplified: treat as XIC/XIO for now; proper OSR/OSF needs prev-scan state
      return conditionIn && readTagBit(tags, node.tagName);

    // ── Compare instructions ──────────────────────────────────────────────
    case "EQU": case "NEQ": case "LES": case "LEQ": case "GRT": case "GEQ": {
      if (!conditionIn) return false;
      const p = node.params as CompareParams;
      const a = resolveOperand(p?.sourceA ?? "", tags);
      const b = resolveOperand(p?.sourceB ?? "", tags);
      switch (node.type) {
        case "EQU": return a === b;
        case "NEQ": return a !== b;
        case "LES": return a <   b;
        case "LEQ": return a <=  b;
        case "GRT": return a >   b;
        case "GEQ": return a >=  b;
      }
      return false;
    }

    default:
      // Output instructions are not evaluated as contacts
      return conditionIn;
  }
}

/**
 * Execute an output instruction given the final rung condition.
 * Mutates tags in place.
 */
function executeOutput(
  node: InstructionNode,
  conditionIn: boolean,
  tags: Map<string, TagDefinition>,
  deltaMs: number,
  ctx: ScanExecutionContext
): void {
  switch (node.type) {
    case "JSR": {
      if (!conditionIn) break;
      const p = node.params as JsrParams;
      const routineName = p?.routineName?.trim();
      if (!routineName) break;
      const routine = ctx.routinesByName.get(routineName.toLowerCase());
      if (!routine) break;
      if (ctx.callStack.includes(routine.id)) break;
      if (ctx.callStack.length >= ctx.maxCallDepth) break;
      executeRoutine(routine, tags, deltaMs, ctx);
      break;
    }

    case "OTE":
      writeBool(tags, node.tagName, conditionIn);
      break;

    case "OTL":
      if (conditionIn) writeBool(tags, node.tagName, true);
      break;

    case "OTU":
      if (conditionIn) writeBool(tags, node.tagName, false);
      break;

    case "TON": {
      const tag = tags.get(node.tagName);
      if (!tag || tag.dataType !== "TIMER") break;
      const td = tag.timerData!;
      const preset = resolvePreset(node.params, tags, 1000, td.preset);
      td.preset = preset;

      if (conditionIn) {
        td.en = true;
        if (!td.dn) {
          td.accum = Math.min(td.accum + deltaMs, preset);
        }
        if (td.accum >= preset) {
          td.accum = preset;
          td.dn   = true;
          td.tt   = false;
        } else {
          td.dn = false;
          td.tt = true;
        }
      } else {
        // Rung false — non-retentive reset
        td.en    = false;
        td.tt    = false;
        td.dn    = false;
        td.accum = 0;
      }
      break;
    }

    case "TOF": {
      const tag = tags.get(node.tagName);
      if (!tag || tag.dataType !== "TIMER") break;
      const td = tag.timerData!;
      const preset = resolvePreset(node.params, tags, 1000, td.preset);
      td.preset = preset;

      if (conditionIn) {
        // Rung true: output ON, accumulator resets, no timing
        td.en    = true;
        td.tt    = false;
        td.dn    = true;
        td.accum = 0;
      } else {
        // Rung false: start/continue timing; EN mirrors rung
        td.en = false;
        if (td.dn) {
          // Still within the off-delay window — accumulate
          td.tt    = true;
          td.accum = Math.min(td.accum + deltaMs, preset);
          if (td.accum >= preset) {
            td.accum = preset;
            td.dn    = false;
            td.tt    = false;
          }
        }
      }
      break;
    }

    case "RTO": {
      // Retentive Timer On — accumulates while rung is true, holds on false.
      // Only RES resets it.
      const tag = tags.get(node.tagName);
      if (!tag || tag.dataType !== "TIMER") break;
      const td = tag.timerData!;
      const preset = resolvePreset(node.params, tags, 1000, td.preset);
      td.preset = preset;

      if (conditionIn) {
        td.en = true;
        if (!td.dn) {
          td.accum = Math.min(td.accum + deltaMs, preset);
        }
        if (td.accum >= preset) {
          td.accum = preset;
          td.dn    = true;
          td.tt    = false;
        } else {
          td.dn = false;
          td.tt = true;
        }
      } else {
        // Rung false: EN and TT clear, but ACC and DN are retained
        td.en = false;
        td.tt = false;
      }
      break;
    }

    case "CTU": {
      const tag = tags.get(node.tagName);
      if (!tag || tag.dataType !== "COUNTER") break;
      const cd = tag.counterData!;
      const preset = resolvePreset(node.params, tags, 10, cd.preset);
      cd.preset = preset;

      if (conditionIn && !cd.cu) {
        // Rising edge
        cd.accum++;
        if (cd.accum >= preset) {
          cd.dn = true;
          if (cd.accum > 32767) { cd.ov = true; cd.accum = 0; }
        }
      }
      cd.cu = conditionIn;
      break;
    }

    case "CTD": {
      const tag = tags.get(node.tagName);
      if (!tag || tag.dataType !== "COUNTER") break;
      const cd = tag.counterData!;
      const preset = resolvePreset(node.params, tags, 10, cd.preset);
      cd.preset = preset;

      if (conditionIn && !cd.cd) {
        cd.accum--;
        if (cd.accum < 0) { cd.un = true; cd.accum = 0; }
        cd.dn = cd.accum >= preset;
      }
      cd.cd = conditionIn;
      break;
    }

    case "RES": {
      const tag = tags.get(node.tagName);
      if (!tag) break;
      if (conditionIn && tag.dataType === "TIMER" && tag.timerData) {
        const td = tag.timerData;
        td.en = false; td.tt = false; td.dn = false;
        td.accum = 0; delete td._startMs;
      }
      if (conditionIn && tag.dataType === "COUNTER" && tag.counterData) {
        const cd = tag.counterData;
        cd.cu = false; cd.cd = false; cd.dn = false;
        cd.ov = false; cd.un = false; cd.accum = 0;
      }
      break;
    }

    case "MOV": {
      if (!conditionIn) break;
      const p = node.params as MoveParams;
      if (!p?.dest) break;
      const val = resolveOperand(p.source ?? "", tags);
      writeTagNumber(p.dest, val, tags);
      break;
    }

    case "MVM": {
      if (!conditionIn) break;
      const p = node.params as MoveParams;
      if (!p?.dest) break;
      const src  = resolveOperand(p.source ?? "", tags) | 0;
      const mask = resolveOperand(p.mask   ?? "0xFFFFFFFF", tags) | 0;
      const dest = readTagNumber(p.dest, tags) | 0;
      writeTagNumber(p.dest, ((src & mask) | (dest & ~mask)) | 0, tags);
      break;
    }

    case "ADD":
    case "SUB":
    case "MUL":
    case "DIV":
    case "MOD":
    case "NEG":
    case "ABS":
    case "SQR":
    case "CLR": {
      if (!conditionIn) break;
      const p = node.params as MathParams;
      if (!p?.dest) break;

      const a = resolveOperand(p.sourceA ?? "", tags);
      const b = resolveOperand(p.sourceB ?? "", tags);
      let result = 0;

      switch (node.type) {
        case "ADD": result = a + b; break;
        case "SUB": result = a - b; break;
        case "MUL": result = a * b; break;
        case "DIV": result = b === 0 ? 0 : a / b; break;
        case "MOD": result = b === 0 ? 0 : a % b; break;
        case "NEG": result = -a; break;
        case "ABS": result = Math.abs(a); break;
        case "SQR": result = a < 0 ? 0 : Math.sqrt(a); break;
        case "CLR": result = 0; break;
      }

      writeTagNumber(p.dest, result, tags);
      break;
    }
  }
}


// ---------------------------------------------------------------------------
// Series / Branch evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate a series list left-to-right.
 * Returns { conditionOut, nodePowered, legPowered }
 */
function evaluateSeries(
  nodes: SeriesNode[],
  conditionIn: boolean,
  tags: Map<string, TagDefinition>,
  nodePowered: Map<string, boolean>,
  nodeOutputPowered: Map<string, boolean>,
  legPowered: Map<string, boolean>,
  deltaMs: number,
  _insideBranch: boolean,
  ctx: ScanExecutionContext
): boolean {
  // Two-condition model:
  //   condition        — the live wire value flowing right; terminal blocks
  //                      (TON/CTU/etc.) set this to false so the downstream
  //                      wire goes dark and coil outputs stay de-energised.
  //   contactCondition — accumulated result of contacts only.  Terminal blocks
  //                      leave this untouched so that a contact placed AFTER a
  //                      terminal restarts from the last-known contact chain
  //                      value rather than from false.
  //
  // Result:
  //   [XIC A][TON T][OTE B]            → OTE = false always (terminal blocks wire)
  //   [XIC A][TON T][XIC T.DN][OTE B]  → OTE = A AND T.DN  (works on one rung)
  let condition        = conditionIn;
  let contactCondition = conditionIn;

  for (const node of nodes) {
    if (isInstruction(node)) {
      if (node.type === "ONS") {
        const storagePrev = readBool(tags, node.tagName);
        const out = contactCondition && !storagePrev;
        writeBool(tags, node.tagName, contactCondition);
        condition        = out;
        contactCondition = out;
        nodePowered.set(node.id, condition);
        nodeOutputPowered.set(node.id, condition);
      } else if (
        node.type === "XIC" || node.type === "XIO" ||
        node.type === "AFI" ||
        node.type === "OSR" || node.type === "OSF" ||
        node.type === "EQU" || node.type === "NEQ" ||
        node.type === "LES" || node.type === "LEQ" ||
        node.type === "GRT" || node.type === "GEQ"
      ) {
        // Contacts evaluate against contactCondition, not the (possibly blocked)
        // wire condition.  This lets them "see through" an upstream terminal block.
        condition        = evaluateContact(node, tags, contactCondition);
        contactCondition = condition;
        nodePowered.set(node.id, condition);
        nodeOutputPowered.set(node.id, condition);
      } else {
        // Output-class: execute using the current wire condition. Outputs in
        // branch legs are valid parallel output paths, so they execute too.
        executeOutput(node, condition, tags, deltaMs, ctx);
        nodePowered.set(node.id, condition);

        // Terminal blocks block the wire condition so coil outputs downstream
        // stay de-energised.  contactCondition is left alone so contacts placed
        // after the terminal can still evaluate against the upstream chain.
        const isTerminal = ["TON","TOF","RTO","CTU","CTD"].includes(node.type);
        if (isTerminal) {
          condition = false;
          // contactCondition intentionally NOT updated so contacts placed after
          // the terminal still evaluate against the upstream contact chain.

          // A terminal instruction never energizes the wire to its right by
          // itself. Add an explicit [XIC Timer.DN] / [XIC Counter.DN] after it
          // when the done bit should drive downstream logic and wire color.
          nodeOutputPowered.set(node.id, false);
        } else {
          contactCondition = condition;
          nodeOutputPowered.set(node.id, condition);
        }
      }
    } else if (isBranch(node)) {
      condition = evaluateBranch(node, condition, tags, nodePowered, nodeOutputPowered, legPowered, deltaMs, ctx);
      contactCondition = condition; // branch result feeds back into contact chain
      nodePowered.set(node.id, condition);
      nodeOutputPowered.set(node.id, condition);
    }
  }

  return condition;
}

function evaluateBranch(
  branch: { id: string; legs: BranchLeg[] },
  conditionIn: boolean,
  tags: Map<string, TagDefinition>,
  nodePowered: Map<string, boolean>,
  nodeOutputPowered: Map<string, boolean>,
  legPowered: Map<string, boolean>,
  deltaMs: number,
  ctx: ScanExecutionContext
): boolean {
  let anyTrue = false;

  for (const leg of branch.legs) {
    const legResult = evaluateSeries(
      leg.nodes,
      conditionIn,
      tags,
      nodePowered,
      nodeOutputPowered,
      legPowered,
      deltaMs,
      true,
      ctx
    );
    legPowered.set(leg.id, legResult);
    if (legResult) anyTrue = true;
  }

  return anyTrue;
}

// ---------------------------------------------------------------------------
// Full rung evaluation
// ---------------------------------------------------------------------------

function evaluateRung(
  rung: Rung,
  tags: Map<string, TagDefinition>,
  deltaMs: number,
  ctx: ScanExecutionContext
): RungPowerState {
  const nodePowered       = new Map<string, boolean>();
  const nodeOutputPowered = new Map<string, boolean>();
  const legPowered        = new Map<string, boolean>();

  if (rung.disabled) {
    return { rungId: rung.id, rungPowered: false, nodePowered, nodeOutputPowered, legPowered };
  }

  const rungPowered = evaluateSeries(
    rung.nodes,
    true,
    tags,
    nodePowered,
    nodeOutputPowered,
    legPowered,
    deltaMs,
    false,
    ctx
  );

  return { rungId: rung.id, rungPowered, nodePowered, nodeOutputPowered, legPowered };
}

// ---------------------------------------------------------------------------
// Public API: single scan
// ---------------------------------------------------------------------------

/**
 * Execute one full scan of a routine.
 *
 * @param routine   The routine to scan.
 * @param tagMap    Mutable map of tag name → TagDefinition.
 *                  Tag values ARE mutated in place by output instructions.
 * @param deltaMs   Time elapsed since the previous scan (ms).
 *                  Timers accumulate this amount per scan.
 * @returns         ScanResult map of rungId → RungPowerState.
 */
export function executeScan(
  routine: Routine,
  tagMap: Map<string, TagDefinition>,
  deltaMs: number,
  routines: Routine[] = [routine]
): ScanResult {
  const ctx: ScanExecutionContext = {
    routinesByName: new Map(routines.map(r => [r.name.toLowerCase(), r])),
    result: new Map(),
    callStack: [],
    maxCallDepth: 16,
  };
  executeRoutine(routine, tagMap, deltaMs, ctx);
  return ctx.result;
}

function executeRoutine(
  routine: Routine,
  tagMap: Map<string, TagDefinition>,
  deltaMs: number,
  ctx: ScanExecutionContext
): void {
  ctx.callStack.push(routine.id);

  for (const rung of routine.rungs) {
    const state = evaluateRung(rung, tagMap, deltaMs, ctx);
    ctx.result.set(rung.id, state);
  }

  ctx.callStack.pop();
}

// ---------------------------------------------------------------------------
// Tag map builder (used by the store to convert array → map for fast lookup)
// ---------------------------------------------------------------------------

export function buildTagMap(tags: TagDefinition[]): Map<string, TagDefinition> {
  const map = new Map<string, TagDefinition>();
  for (const tag of tags) {
    map.set(tag.name, tag);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Default tag value initializers
// ---------------------------------------------------------------------------

export function defaultTimerData(preset = 1000): TimerData {
  return { preset, accum: 0, en: false, tt: false, dn: false };
}

export function defaultCounterData(preset = 10): CounterData {
  return {
    preset, accum: 0,
    cu: false, cd: false, dn: false, ov: false, un: false,
  };
}
