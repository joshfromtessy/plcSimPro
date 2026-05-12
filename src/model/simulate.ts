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
  CopyParams,
  BitShiftParams,
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

const bitShiftPrevCondition = new Map<string, boolean>();

function hasReadableTagBit(
  tags: Map<string, TagDefinition>,
  tagName: string
): boolean {
  const ref = parseTagRef(tagName);
  const tag = tags.get(ref.base);
  if (!tag) return false;

  if (tag.dataType === "BOOL" && ref.idx === undefined && ref.bit === undefined && ref.member === undefined) {
    return true;
  }
  if ((tag.dataType === "TIMER" || tag.dataType === "COUNTER") && ref.member) {
    return ["EN", "TT", "DN", "CU", "CD", "OV", "UN"].includes(ref.member);
  }
  if (tag.dataType === "DINT" || tag.dataType === "INT") {
    return true;
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

function readShiftBit(tags: Map<string, TagDefinition>, arrayRef: string, bitIndex: number): boolean {
  const ref = parseTagRef(arrayRef);
  const tag = tags.get(ref.base);
  if (!tag || (tag.dataType !== "DINT" && tag.dataType !== "INT")) return false;
  const wordSize = tag.dataType === "INT" ? 16 : 32;
  const wordIndex = Math.floor(bitIndex / wordSize);
  const bit = bitIndex % wordSize;
  const baseIndex = ref.idx ?? 0;
  const value = getWordValue(tag, baseIndex + wordIndex);
  return ((value >> bit) & 1) === 1;
}

function writeShiftBit(tags: Map<string, TagDefinition>, arrayRef: string, bitIndex: number, value: boolean): void {
  const ref = parseTagRef(arrayRef);
  const tag = tags.get(ref.base);
  if (!tag || (tag.dataType !== "DINT" && tag.dataType !== "INT")) return;
  const wordSize = tag.dataType === "INT" ? 16 : 32;
  const wordIndex = Math.floor(bitIndex / wordSize);
  const bit = bitIndex % wordSize;
  const baseIndex = ref.idx ?? 0;
  const idx = baseIndex + wordIndex;
  const word = getWordValue(tag, idx);
  const next = value ? (word | (1 << bit)) : (word & ~(1 << bit));
  setWordValue(tag, idx, next | 0);
}

function executeBitShift(
  node: InstructionNode,
  params: BitShiftParams,
  conditionIn: boolean,
  tags: Map<string, TagDefinition>
): void {
  const wasTrue = bitShiftPrevCondition.get(node.id) ?? false;
  bitShiftPrevCondition.set(node.id, conditionIn);
  if (!conditionIn || wasTrue || !params?.array) return;

  const length = Math.max(0, Math.min(1024, resolveOperand(params.length || "0", tags) | 0));
  if (length <= 0) return;
  const sourceBit = readTagNumber(params.source ?? "", tags) !== 0;

  if (node.type === "BSL") {
    for (let bit = length - 1; bit >= 1; bit--) {
      writeShiftBit(tags, params.array, bit, readShiftBit(tags, params.array, bit - 1));
    }
    writeShiftBit(tags, params.array, 0, sourceBit);
  } else {
    for (let bit = 0; bit < length - 1; bit++) {
      writeShiftBit(tags, params.array, bit, readShiftBit(tags, params.array, bit + 1));
    }
    writeShiftBit(tags, params.array, length - 1, sourceBit);
  }
}

function readCopyValue(sourceRef: string, offset: number, tags: Map<string, TagDefinition>): number {
  const ref = parseTagRef(sourceRef);
  const tag = tags.get(ref.base);
  if (!tag || ref.bit !== undefined || ref.member !== undefined || !Array.isArray(tag.value)) {
    return resolveOperand(sourceRef, tags);
  }

  return Number((tag.value as number[])[(ref.idx ?? 0) + offset] ?? 0);
}

function writeCopyValue(destRef: string, offset: number, value: number, tags: Map<string, TagDefinition>): void {
  const ref = parseTagRef(destRef);
  const tag = tags.get(ref.base);
  if (!tag || ref.bit !== undefined || ref.member !== undefined || !Array.isArray(tag.value)) {
    if (offset === 0) writeTagNumber(destRef, value, tags);
    return;
  }

  const targetIndex = (ref.idx ?? 0) + offset;
  if (targetIndex < 0 || targetIndex >= (tag.value as number[]).length) return;
  setWordValue(tag, targetIndex, value);
}

function executeCopyFile(params: CopyParams, tags: Map<string, TagDefinition>): void {
  if (!params?.dest) return;
  const length = Math.max(0, Math.min(1024, resolveOperand(params.length || "1", tags) | 0));
  for (let i = 0; i < length; i++) {
    writeCopyValue(params.dest, i, readCopyValue(params.source ?? "", i, tags), tags);
  }
}

// ---------------------------------------------------------------------------
// Preset resolution — literal or DINT/INT tag reference
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Structured Text execution (MVP IEC 61131-3 subset)
// ---------------------------------------------------------------------------

interface StLine {
  text: string;
  lineNumber: number;
}

interface StBlockMarker {
  elseIndex?: number;
  endIndex: number;
}

const ST_LOOP_LIMIT = 10_000;

function executeStructuredText(source: string, tags: Map<string, TagDefinition>): void {
  const lines = normalizeStructuredTextLines(source);
  executeStructuredTextBlock(lines, 0, lines.length, tags);
}

function stripStructuredTextBlockComments(source: string): string {
  return source.replace(/\(\*[\s\S]*?\*\)/g, "");
}

function normalizeStructuredTextLines(source: string): StLine[] {
  return stripStructuredTextBlockComments(source)
    .split(/\r?\n/)
    .map((rawLine, index) => ({
      text: rawLine.replace(/\/\/.*$/, "").trim(),
      lineNumber: index + 1,
    }))
    .filter(line => line.text.length > 0);
}

function executeStructuredTextBlock(
  lines: StLine[],
  start: number,
  end: number,
  tags: Map<string, TagDefinition>
): void {
  let index = start;
  while (index < end) {
    const line = lines[index].text;
    const upper = normalizeStStatement(line);

    if (isIfBranchLine(line) || isCaseBranchLine(line) || isEndStructuredTextStatement(upper)) {
      return;
    }

    const ifMatch = line.match(/^IF\s+(.+?)\s+THEN\s*;?$/i);
    if (ifMatch) {
      const marker = findStructuredTextBlock(lines, index, end, "IF", [], ["END_IF"]);
      executeStructuredTextIf(lines, index, marker.endIndex, ifMatch[1], tags);
      index = marker.endIndex + 1;
      continue;
    }

    const whileMatch = line.match(/^WHILE\s+(.+?)\s+DO\s*;?$/i);
    if (whileMatch) {
      const marker = findStructuredTextBlock(lines, index, end, "WHILE", [], ["END_WHILE"]);
      let guard = 0;
      while (Boolean(evaluateStructuredTextExpression(whileMatch[1], tags)) && guard < ST_LOOP_LIMIT) {
        executeStructuredTextBlock(lines, index + 1, marker.endIndex, tags);
        guard += 1;
      }
      index = marker.endIndex + 1;
      continue;
    }

    const forMatch = line.match(/^FOR\s+([A-Za-z_]\w*(?:\[[^\]]+\])?(?:\.\w+)?)\s*:=\s*(.+?)\s+TO\s+(.+?)(?:\s+BY\s+(.+?))?\s+DO\s*;?$/i);
    if (forMatch) {
      const marker = findStructuredTextBlock(lines, index, end, "FOR", [], ["END_FOR"]);
      const target = forMatch[1];
      const startValue = Number(evaluateStructuredTextExpression(forMatch[2], tags)) || 0;
      const endValue = Number(evaluateStructuredTextExpression(forMatch[3], tags)) || 0;
      const stepValue = Number(forMatch[4] ? evaluateStructuredTextExpression(forMatch[4], tags) : 1) || 1;
      let loopValue = startValue;
      let guard = 0;
      const shouldContinue = () => stepValue >= 0 ? loopValue <= endValue : loopValue >= endValue;
      while (shouldContinue() && guard < ST_LOOP_LIMIT) {
        writeStructuredTextValue(target, loopValue, tags);
        executeStructuredTextBlock(lines, index + 1, marker.endIndex, tags);
        loopValue += stepValue;
        guard += 1;
      }
      writeStructuredTextValue(target, loopValue, tags);
      index = marker.endIndex + 1;
      continue;
    }

    const caseMatch = line.match(/^CASE\s+(.+?)\s+OF\s*;?$/i);
    if (caseMatch) {
      const marker = findStructuredTextBlock(lines, index, end, "CASE", [], ["END_CASE"]);
      executeStructuredTextCase(lines, index + 1, marker.endIndex, evaluateStructuredTextExpression(caseMatch[1], tags), tags);
      index = marker.endIndex + 1;
      continue;
    }

    executeStructuredTextStatement(line, tags);
    index += 1;
  }
}

function executeStructuredTextStatement(line: string, tags: Map<string, TagDefinition>): void {
  const assignMatch = line.match(/^([A-Za-z_]\w*(?:\[[^\]]+\])?(?:\.\w+)?)\s*:=\s*(.+?)\s*;?$/);
  if (!assignMatch) return;
  writeStructuredTextValue(assignMatch[1], evaluateStructuredTextExpression(assignMatch[2], tags), tags);
}

function executeStructuredTextIf(
  lines: StLine[],
  ifIndex: number,
  endIndex: number,
  firstCondition: string,
  tags: Map<string, TagDefinition>
): void {
  const branches = collectStructuredTextIfBranches(lines, ifIndex, endIndex, firstCondition);
  const branch = branches.find(candidate =>
    candidate.condition === null || Boolean(evaluateStructuredTextExpression(candidate.condition, tags))
  );
  if (branch) executeStructuredTextBlock(lines, branch.start, branch.end, tags);
}

function collectStructuredTextIfBranches(
  lines: StLine[],
  ifIndex: number,
  endIndex: number,
  firstCondition: string
): Array<{ condition: string | null; start: number; end: number }> {
  const branches: Array<{ condition: string | null; start: number; end: number }> = [];
  let current: { condition: string | null; start: number; end: number } = {
    condition: firstCondition,
    start: ifIndex + 1,
    end: endIndex,
  };
  let depth = 0;

  for (let index = ifIndex + 1; index < endIndex; index += 1) {
    const text = lines[index].text;
    const upper = normalizeStStatement(text);
    if (isStBlockStart(upper)) {
      depth += 1;
      continue;
    }
    if (isEndStructuredTextStatement(upper)) {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth !== 0) continue;

    const elsifMatch = text.match(/^ELSIF\s+(.+?)\s+THEN\s*;?$/i);
    if (elsifMatch || upper === "ELSE") {
      current.end = index;
      branches.push(current);
      current = {
        condition: elsifMatch ? elsifMatch[1] : null,
        start: index + 1,
        end: endIndex,
      };
    }
  }

  branches.push(current);
  return branches;
}

function writeStructuredTextValue(
  target: string,
  value: number | boolean,
  tags: Map<string, TagDefinition>
): void {
  const targetTag = tags.get(parseStructuredTextRef(target, tags).base);
  const concreteTarget = toConcreteStructuredTextRef(target, tags);
  if (targetTag?.dataType === "BOOL") {
    writeBool(tags, concreteTarget, Boolean(value));
  } else {
    writeTagNumber(concreteTarget, Number(value) || 0, tags);
  }
}

function executeStructuredTextCase(
  lines: StLine[],
  start: number,
  end: number,
  caseValue: number | boolean,
  tags: Map<string, TagDefinition>
): void {
  const branches = collectStructuredTextCaseBranches(lines, start, end);
  const numericCaseValue = Number(caseValue);
  const selected = branches.find(branch =>
    branch.isElse || branch.labels.some(label => isStructuredTextCaseLabelMatch(label, numericCaseValue, tags))
  );
  if (selected) executeStructuredTextBlock(lines, selected.start, selected.end, tags);
}

function collectStructuredTextCaseBranches(lines: StLine[], start: number, end: number) {
  const branches: Array<{ labels: string[]; isElse: boolean; start: number; end: number }> = [];
  let current: { labels: string[]; isElse: boolean; start: number; end: number } | null = null;
  let depth = 0;

  for (let index = start; index < end; index += 1) {
    const text = lines[index].text;
    const upper = normalizeStStatement(text);
    if (isStBlockStart(upper)) depth += 1;
    if (isEndStructuredTextStatement(upper)) depth = Math.max(0, depth - 1);

    if (depth === 0) {
      const branchMatch = text.match(/^(.+?)\s*:(?!=)\s*(.*)$/);
      const isElse = upper === "ELSE";
      if (isElse || branchMatch) {
        if (current) {
          current.end = index;
          branches.push(current);
        }
        current = {
          labels: isElse ? [] : branchMatch![1].split(",").map(label => label.trim()).filter(Boolean),
          isElse,
          start: index + 1,
          end,
        };
        const inlineStatement = isElse ? "" : branchMatch![2].trim();
        if (inlineStatement) {
          lines.splice(index + 1, 0, { text: inlineStatement, lineNumber: lines[index].lineNumber });
          end += 1;
        }
      }
    }
  }

  if (current) {
    current.end = end;
    branches.push(current);
  }
  return branches;
}

function isStructuredTextCaseLabelMatch(label: string, caseValue: number, tags: Map<string, TagDefinition>): boolean {
  const rangeMatch = label.match(/^(.+?)\.\.(.+)$/);
  if (rangeMatch) {
    const low = Number(evaluateStructuredTextExpression(rangeMatch[1], tags));
    const high = Number(evaluateStructuredTextExpression(rangeMatch[2], tags));
    return caseValue >= Math.min(low, high) && caseValue <= Math.max(low, high);
  }
  return caseValue === Number(evaluateStructuredTextExpression(label, tags));
}

function findStructuredTextBlock(
  lines: StLine[],
  start: number,
  end: number,
  opener: "IF" | "WHILE" | "FOR" | "CASE",
  middleTokens: string[],
  closeTokens: string[]
): StBlockMarker {
  let depth = 0;
  for (let index = start + 1; index < end; index += 1) {
    const upper = normalizeStStatement(lines[index].text);
    if (isStBlockStart(upper)) {
      depth += 1;
      continue;
    }
    if (isEndStructuredTextStatement(upper)) {
      if (depth > 0) {
        depth -= 1;
        continue;
      }
      if (closeTokens.includes(upper)) return { endIndex: index };
    }
    if (closeTokens.includes(upper)) {
      if (depth === 0) return { endIndex: index };
      depth -= 1;
    }
    if (depth === 0 && middleTokens.includes(upper)) {
      const endMarker = findStructuredTextBlock(lines, index, end, opener, [], closeTokens);
      return { elseIndex: index, endIndex: endMarker.endIndex };
    }
  }
  return { endIndex: end };
}

function normalizeStStatement(line: string): string {
  return line.toUpperCase().replace(/;$/, "").trim();
}

function isStBlockStart(upper: string): boolean {
  return /^(IF\b.*\bTHEN|WHILE\b.*\bDO|FOR\b.*\bDO|CASE\b.*\bOF)/.test(upper);
}

function isEndStructuredTextStatement(upper: string): boolean {
  return ["END_IF", "END_WHILE", "END_FOR", "END_CASE"].includes(upper);
}

function isCaseBranchLine(line: string): boolean {
  const upper = normalizeStStatement(line);
  const colonIndex = line.indexOf(":");
  return upper === "ELSE" || (colonIndex >= 0 && line[colonIndex + 1] !== "=");
}

function isIfBranchLine(line: string): boolean {
  const upper = normalizeStStatement(line);
  return upper === "ELSE" || /^ELSIF\b.*\bTHEN$/.test(upper);
}

function evaluateStructuredTextExpression(expr: string, tags: Map<string, TagDefinition>): number | boolean {
  const jsExpr = toStructuredTextJavaScriptExpression(expr);
  try {
    const fn = new Function("__read", "__fn", `return (${jsExpr});`) as (
      reader: (ref: string) => number | boolean,
      fnReader: (name: string) => (...args: number[]) => number
    ) => unknown;
    const result = fn(
      (ref) => readStructuredTextValue(ref, tags),
      (name) => getStructuredTextFunction(name)
    );
    return typeof result === "boolean" ? result : Number(result) || 0;
  } catch {
    return 0;
  }
}

function toStructuredTextJavaScriptExpression(expr: string): string {
  const keywords = new Set(["AND", "OR", "NOT", "MOD", "TRUE", "FALSE"]);
  const functions = new Set([
    "ABS", "SQR", "SQRT", "MIN", "MAX", "LIMIT",
    "BAND", "BOR", "BXOR", "BNOT", "SHL", "SHR",
  ]);
  let out = expr
    .replace(/<>/g, "!==")
    .replace(/\bAND\b/gi, "&&")
    .replace(/\bOR\b/gi, "||")
    .replace(/\bNOT\b/gi, "!")
    .replace(/\bMOD\b/gi, "%")
    .replace(/\bTRUE\b/gi, "true")
    .replace(/\bFALSE\b/gi, "false");

  out = out.replace(/(^|[^<>=!])=([^=])/g, "$1===$2");

  return out.replace(/\b[A-Za-z_]\w*(?:\[[^\]]+\])?(?:\.\w+)?\b/g, (token, offset, fullExpr) => {
    if (keywords.has(token.toUpperCase()) || token === "true" || token === "false") return token;
    if (functions.has(token.toUpperCase()) && /^\s*\(/.test(fullExpr.slice(offset + token.length))) {
      return `__fn(${JSON.stringify(token.toUpperCase())})`;
    }
    if (/^\d/.test(token)) return token;
    return `__read(${JSON.stringify(token)})`;
  });
}

function getStructuredTextFunction(name: string): (...args: number[]) => number {
  switch (name.toUpperCase()) {
    case "ABS": return (value) => Math.abs(value);
    case "SQR":
    case "SQRT": return (value) => value < 0 ? 0 : Math.sqrt(value);
    case "MIN": return (...values) => Math.min(...values);
    case "MAX": return (...values) => Math.max(...values);
    case "LIMIT": return (low, value, high) => Math.min(Math.max(value, low), high);
    case "BAND": return (...values) => values.reduce((acc, value) => (acc & value) | 0, -1);
    case "BOR": return (...values) => values.reduce((acc, value) => (acc | value) | 0, 0);
    case "BXOR": return (...values) => values.reduce((acc, value) => (acc ^ value) | 0, 0);
    case "BNOT": return (value) => (~value) | 0;
    case "SHL": return (value, shift) => (value << (shift & 31)) | 0;
    case "SHR": return (value, shift) => (value >>> (shift & 31)) | 0;
    default: return () => 0;
  }
}

function readStructuredTextValue(ref: string, tags: Map<string, TagDefinition>): number | boolean {
  const tag = tags.get(parseStructuredTextRef(ref, tags).base);
  const concreteRef = toConcreteStructuredTextRef(ref, tags);
  if (!tag) return 0;
  if (tag.dataType === "BOOL") return readTagBit(tags, concreteRef);
  return readTagNumber(concreteRef, tags);
}

function parseStructuredTextRef(refText: string, tags: Map<string, TagDefinition>): ParsedTagRef {
  const match = refText.trim().match(/^([A-Za-z_]\w*)(?:\[([^\]]+)\])?(?:\.(\w+))?$/);
  if (!match) return { base: refText };
  const [, base, indexExpr, suffix] = match;
  const tag = tags.get(base);
  const ref: ParsedTagRef = { base };

  if (indexExpr !== undefined) {
    ref.idx = Number(evaluateStructuredTextExpression(indexExpr, tags)) | 0;
  }

  if (suffix !== undefined) {
    const literalBit = Number(suffix);
    if (!Number.isNaN(literalBit)) {
      ref.bit = literalBit | 0;
    } else if (tag?.dataType === "DINT" || tag?.dataType === "INT") {
      ref.bit = Number(evaluateStructuredTextExpression(suffix, tags)) | 0;
    } else {
      ref.member = suffix.toUpperCase();
    }
  }

  return ref;
}

function toConcreteStructuredTextRef(refText: string, tags: Map<string, TagDefinition>): string {
  const ref = parseStructuredTextRef(refText, tags);
  const index = ref.idx !== undefined ? `[${ref.idx}]` : "";
  const suffix = ref.bit !== undefined
    ? `.${ref.bit}`
    : ref.member !== undefined
      ? `.${ref.member}`
      : "";
  return `${ref.base}${index}${suffix}`;
}

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
      return conditionIn && hasReadableTagBit(tags, node.tagName) && !readTagBit(tags, node.tagName);
    case "AFI":
      return false;
    case "OSR":
    case "OSF":
      // One-shots require tracking previous state per node — handled via _osBitMap
      // Simplified: treat as XIC/XIO for now; proper OSR/OSF needs prev-scan state
      return conditionIn && readTagBit(tags, node.tagName);

    // ── Compare instructions ──────────────────────────────────────────────
    case "EQU": case "NEQ": case "LES": case "LEQ": case "GRT": case "GEQ": case "LIM": {
      if (!conditionIn) return false;
      const p = node.params as CompareParams;
      const a = resolveOperand(p?.sourceA ?? "", tags);
      const b = resolveOperand(p?.sourceB ?? "", tags);
      const c = resolveOperand(p?.sourceC ?? "", tags);
      switch (node.type) {
        case "EQU": return a === b;
        case "NEQ": return a !== b;
        case "LES": return a <   b;
        case "LEQ": return a <=  b;
        case "GRT": return a >   b;
        case "GEQ": return a >=  b;
        case "LIM": return b >= a && b <= c;
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

    case "COP":
    case "CPS": {
      if (!conditionIn) break;
      executeCopyFile(node.params as CopyParams, tags);
      break;
    }

    case "BSL":
    case "BSR": {
      executeBitShift(node, node.params as BitShiftParams, conditionIn, tags);
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
        node.type === "GRT" || node.type === "GEQ" ||
        node.type === "LIM"
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

  if (routine.language === "ST") {
    executeStructuredText(routine.structuredText ?? "", tagMap);
    ctx.callStack.pop();
    return;
  }

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
