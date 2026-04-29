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
  InstructionParams,
} from "./types";

import { isInstruction, isBranch } from "./ast";

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
// Preset resolution — literal or DINT/INT tag reference
// ---------------------------------------------------------------------------

function resolvePreset(
  params: InstructionParams,
  tags: Map<string, TagDefinition>,
  defaultMs: number
): number {
  const p = params as TimerParams | CounterParams;
  if (p?.presetTag) {
    const parsed = parseTagRef(p.presetTag);
    const ref = tags.get(parsed.base);
    if (ref && (ref.dataType === "DINT" || ref.dataType === "INT")) {
      return getWordValue(ref, parsed.idx);
    }
  }
  return (p?.preset as number | undefined) ?? defaultMs;
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
    case "OSR":
    case "OSF":
      // One-shots require tracking previous state per node — handled via _osBitMap
      // Simplified: treat as XIC/XIO for now; proper OSR/OSF needs prev-scan state
      return conditionIn && readTagBit(tags, node.tagName);
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
  nowMs: number
): void {
  switch (node.type) {
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
      const preset = resolvePreset(node.params, tags, 1000);
      td.preset = preset; // keep timerData in sync for display

      if (conditionIn) {
        if (!td.en) {
          // Rising edge — start timer
          td.en = true;
          td.tt = true;
          td._startMs = nowMs;
        }
        const elapsed = nowMs - (td._startMs ?? nowMs);
        td.accum = Math.min(elapsed, preset);
        td.dn = td.accum >= preset;
        td.tt = !td.dn;
      } else {
        // Rung goes false — reset timer (TON is non-retentive)
        td.en = false;
        td.tt = false;
        td.dn = false;
        td.accum = 0;
        delete td._startMs;
      }
      break;
    }

    case "TOF": {
      const tag = tags.get(node.tagName);
      if (!tag || tag.dataType !== "TIMER") break;
      const td = tag.timerData!;
      const preset = resolvePreset(node.params, tags, 1000);
      td.preset = preset;

      if (conditionIn) {
        // Rung true — TOF output is ON, timer resets
        td.en = true;
        td.tt = false;
        td.dn = true;
        td.accum = 0;
        delete td._startMs;
      } else {
        if (td.en) {
          // Falling edge — start timing
          td._startMs = td._startMs ?? nowMs;
          const elapsed = nowMs - td._startMs;
          td.accum = Math.min(elapsed, preset);
          td.tt = !td.dn;
          if (elapsed >= preset) {
            td.dn = false;
            td.tt = false;
            td.en = false;
          }
        }
      }
      break;
    }

    case "CTU": {
      const tag = tags.get(node.tagName);
      if (!tag || tag.dataType !== "COUNTER") break;
      const cd = tag.counterData!;
      const preset = resolvePreset(node.params, tags, 10);
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
      const preset = resolvePreset(node.params, tags, 10);
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
  }
}

// Extend TimerData to allow runtime _startMs tracking
declare module "./types" {
  interface TimerData {
    _startMs?: number;
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
  legPowered: Map<string, boolean>,
  nowMs: number,
  insideBranch: boolean
): boolean {
  let condition = conditionIn;

  for (const node of nodes) {
    if (isInstruction(node)) {
      // Contacts: evaluate gate
      // Outputs: will be executed, and count as "always pass through" for power flow
      if (node.type === "ONS") {
        // One-Shot: passes for exactly ONE scan on the rising edge of conditionIn.
        // tagName is the Storage Bit (BOOL) — holds the previous conditionIn state.
        // Read prev state, compute output, then update storage bit.
        const storagePrev = readBool(tags, node.tagName);
        const out = condition && !storagePrev;
        writeBool(tags, node.tagName, condition); // arm/disarm for next scan
        condition = out;
      } else if (node.type === "XIC" || node.type === "XIO" || node.type === "OSR" || node.type === "OSF") {
        condition = evaluateContact(node, tags, condition);
      } else {
        // Output-class: execute side effects, power flows through
        if (!insideBranch) {
          executeOutput(node, condition, tags, nowMs);
        }
        // condition stays as-is for power flow visualization
      }
      nodePowered.set(node.id, condition);
    } else if (isBranch(node)) {
      // Evaluate all legs, OR them together
      condition = evaluateBranch(node, condition, tags, nodePowered, legPowered, nowMs);
      nodePowered.set(node.id, condition);
    }
  }

  return condition;
}

function evaluateBranch(
  branch: { id: string; legs: BranchLeg[] },
  conditionIn: boolean,
  tags: Map<string, TagDefinition>,
  nodePowered: Map<string, boolean>,
  legPowered: Map<string, boolean>,
  nowMs: number
): boolean {
  // Each leg is evaluated independently from conditionIn.
  // The branch is TRUE if ANY leg evaluates TRUE.
  let anyTrue = false;

  for (const leg of branch.legs) {
    const legResult = evaluateSeries(
      leg.nodes,
      conditionIn,
      tags,
      nodePowered,
      legPowered,
      nowMs,
      true
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
  nowMs: number
): RungPowerState {
  const nodePowered = new Map<string, boolean>();
  const legPowered = new Map<string, boolean>();

  if (rung.disabled) {
    return { rungId: rung.id, rungPowered: false, nodePowered, legPowered };
  }

  const rungPowered = evaluateSeries(
    rung.nodes,
    true, // power always starts true at the left rail
    tags,
    nodePowered,
    legPowered,
    nowMs,
    false
  );

  return { rungId: rung.id, rungPowered, nodePowered, legPowered };
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
 * @param nowMs     Current time in ms (for timer evaluation).
 * @returns         ScanResult map of rungId → RungPowerState.
 */
export function executeScan(
  routine: Routine,
  tagMap: Map<string, TagDefinition>,
  nowMs: number
): ScanResult {
  const result: ScanResult = new Map();

  for (const rung of routine.rungs) {
    const state = evaluateRung(rung, tagMap, nowMs);
    result.set(rung.id, state);
  }

  return result;
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
