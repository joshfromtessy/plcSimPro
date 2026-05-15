import { genId } from "./ast";
import type {
  BitShiftParams,
  BranchNode,
  CompareParams,
  CopyParams,
  CounterParams,
  InstructionNode,
  InstructionParams,
  InstructionType,
  JsrParams,
  MathParams,
  MoveParams,
  Rung,
  SeriesNode,
  TagDataType,
  TimerParams,
} from "./types";

type TagHint = {
  name: string;
  dataType: TagDataType;
  preset?: number;
};

export type AsciiParseResult = {
  rungs: Rung[];
  tagHints: TagHint[];
};

type BranchFrame = {
  parentList: SeriesNode[];
  branch: BranchNode;
  currentLegIndex: number;
};

const INSTRUCTION_TYPES = new Set<InstructionType>([
  "XIC", "XIO", "AFI", "OSR", "OSF", "ONS",
  "EQU", "NEQ", "LES", "LEQ", "GRT", "GEQ", "LIM",
  "OTE", "OTL", "OTU",
  "TON", "TOF", "RTO", "CTU", "CTD", "RES",
  "MOV", "MVM", "COP", "CPS", "BSL", "BSR",
  "ADD", "SUB", "MUL", "DIV", "MOD", "NEG", "ABS", "SQR", "CLR",
  "JSR", "NOP",
]);

export function parseAsciiRungs(source: string): AsciiParseResult {
  const tagHints = new Map<string, TagHint>();
  const rungs = source
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map((line, index) => parseAsciiRung(line, index + 1, tagHints));

  return { rungs, tagHints: [...tagHints.values()] };
}

function parseAsciiRung(
  line: string,
  lineNumber: number,
  tagHints: Map<string, TagHint>
): Rung {
  const tokens = tokenize(line);
  if (tokens.length === 0) {
    throw new Error(`Line ${lineNumber}: empty rung`);
  }

  const root: SeriesNode[] = [];
  const stack: BranchFrame[] = [];
  let currentList = root;

  const addNode = (node: SeriesNode) => {
    currentList.push(node);
  };

  const read = (idx: number, label: string) => {
    const value = tokens[idx];
    if (!value) throw new Error(`Line ${lineNumber}: missing ${label}`);
    return value;
  };

  for (let i = 0; i < tokens.length;) {
    const token = tokens[i].toUpperCase();

    if (token === "BST") {
      const branch: BranchNode = {
        kind: "branch",
        id: genId("br"),
        legs: [{ id: genId("leg"), nodes: [] }],
      };
      addNode(branch);
      stack.push({ parentList: currentList, branch, currentLegIndex: 0 });
      currentList = branch.legs[0].nodes;
      i += 1;
      continue;
    }

    if (token === "NXB") {
      const frame = stack.at(-1);
      if (!frame) throw new Error(`Line ${lineNumber}: NXB without BST`);
      const nextLeg = { id: genId("leg"), nodes: [] };
      frame.branch.legs.push(nextLeg);
      frame.currentLegIndex = frame.branch.legs.length - 1;
      currentList = nextLeg.nodes;
      i += 1;
      continue;
    }

    if (token === "BND") {
      const frame = stack.pop();
      if (!frame) throw new Error(`Line ${lineNumber}: BND without BST`);
      currentList = frame.parentList;
      i += 1;
      continue;
    }

    if (!INSTRUCTION_TYPES.has(token as InstructionType)) {
      throw new Error(`Line ${lineNumber}: unknown instruction '${tokens[i]}'`);
    }

    const type = token as InstructionType;
    const parsed = parseInstruction(type, tokens, i, lineNumber, tagHints, read);
    addNode(parsed.node);
    i = parsed.nextIndex;
  }

  if (stack.length > 0) {
    throw new Error(`Line ${lineNumber}: missing BND`);
  }

  return {
    id: genId("rung"),
    comment: "",
    nodes: root,
  };
}

function parseInstruction(
  type: InstructionType,
  tokens: string[],
  index: number,
  lineNumber: number,
  tagHints: Map<string, TagHint>,
  read: (idx: number, label: string) => string
): { node: InstructionNode; nextIndex: number } {
  let tagName = "";
  let params: InstructionParams = defaultParams(type);
  let nextIndex = index + 1;

  const next = (label: string) => read(nextIndex++, `${label} for ${type}`);
  const hintBool = (value: string) => rememberTag(tagHints, value, "BOOL");
  const hintNumeric = (value: string) => rememberTag(tagHints, value, "DINT");

  switch (type) {
    case "AFI":
    case "NOP":
      break;

    case "XIC":
    case "XIO":
    case "OSR":
    case "OSF":
    case "ONS":
    case "OTE":
    case "OTL":
    case "OTU":
      tagName = next("tag");
      hintBool(tagName);
      break;

    case "TON":
    case "TOF":
    case "RTO": {
      tagName = next("timer tag");
      const presetValue = consumeOptionalNumber(tokens, nextIndex, 1000);
      nextIndex = presetValue.nextIndex;
      const accumValue = consumeOptionalNumber(tokens, nextIndex, 0);
      nextIndex = accumValue.nextIndex;
      const preset = presetValue.value;
      const accum = accumValue.value;
      params = { preset, accum } satisfies TimerParams;
      rememberTag(tagHints, tagName, "TIMER", preset);
      break;
    }

    case "CTU":
    case "CTD": {
      tagName = next("counter tag");
      const presetValue = consumeOptionalNumber(tokens, nextIndex, 10);
      nextIndex = presetValue.nextIndex;
      const accumValue = consumeOptionalNumber(tokens, nextIndex, 0);
      nextIndex = accumValue.nextIndex;
      const preset = presetValue.value;
      const accum = accumValue.value;
      params = { preset, accum } satisfies CounterParams;
      rememberTag(tagHints, tagName, "COUNTER", preset);
      break;
    }

    case "RES":
      tagName = next("tag");
      rememberTag(tagHints, tagName, "TIMER");
      break;

    case "EQU":
    case "NEQ":
    case "LES":
    case "LEQ":
    case "GRT":
    case "GEQ": {
      const sourceA = next("source A");
      const sourceB = next("source B");
      params = { sourceA, sourceB } satisfies CompareParams;
      hintNumeric(sourceA);
      hintNumeric(sourceB);
      break;
    }

    case "LIM": {
      const sourceA = next("low limit");
      const sourceB = next("test");
      const sourceC = next("high limit");
      params = { sourceA, sourceB, sourceC } satisfies CompareParams;
      hintNumeric(sourceA);
      hintNumeric(sourceB);
      hintNumeric(sourceC);
      break;
    }

    case "MOV": {
      const source = next("source");
      const dest = next("destination");
      params = { source, dest } satisfies MoveParams;
      hintNumeric(source);
      hintNumeric(dest);
      break;
    }

    case "MVM": {
      const source = next("source");
      const dest = next("destination");
      const mask = next("mask");
      params = { source, dest, mask } satisfies MoveParams;
      hintNumeric(source);
      hintNumeric(dest);
      hintNumeric(mask);
      break;
    }

    case "COP":
    case "CPS": {
      const source = next("source");
      const dest = next("destination");
      const length = next("length");
      params = { source, dest, length } satisfies CopyParams;
      hintNumeric(source);
      hintNumeric(dest);
      break;
    }

    case "BSL":
    case "BSR": {
      const array = next("array");
      const source = next("source");
      const length = next("length");
      params = { array, source, length } satisfies BitShiftParams;
      hintNumeric(array);
      hintNumeric(source);
      break;
    }

    case "ADD":
    case "SUB":
    case "MUL":
    case "DIV":
    case "MOD": {
      const sourceA = next("source A");
      const sourceB = next("source B");
      const dest = next("destination");
      params = { sourceA, sourceB, dest } satisfies MathParams;
      hintNumeric(sourceA);
      hintNumeric(sourceB);
      hintNumeric(dest);
      break;
    }

    case "NEG":
    case "ABS":
    case "SQR": {
      const sourceA = next("source A");
      const dest = next("destination");
      params = { sourceA, dest } satisfies MathParams;
      hintNumeric(sourceA);
      hintNumeric(dest);
      break;
    }

    case "CLR": {
      const dest = next("destination");
      params = { sourceA: "", dest } satisfies MathParams;
      hintNumeric(dest);
      break;
    }

    case "JSR": {
      const routineName = next("routine");
      params = { routineName } satisfies JsrParams;
      break;
    }

    default:
      throw new Error(`Line ${lineNumber}: unsupported instruction '${type}'`);
  }

  return {
    node: {
      kind: "instruction",
      id: genId("inst"),
      type,
      tagName,
      params,
    },
    nextIndex,
  };
}

function defaultParams(type: InstructionType): InstructionParams {
  if (type === "TON" || type === "TOF" || type === "RTO") {
    return { preset: 1000, accum: 0 } satisfies TimerParams;
  }
  if (type === "CTU" || type === "CTD") {
    return { preset: 10, accum: 0 } satisfies CounterParams;
  }
  if (type === "LIM") {
    return { sourceA: "", sourceB: "", sourceC: "" } satisfies CompareParams;
  }
  if (["EQU", "NEQ", "LES", "LEQ", "GRT", "GEQ"].includes(type)) {
    return { sourceA: "", sourceB: "" } satisfies CompareParams;
  }
  if (type === "MOV") return { source: "", dest: "" } satisfies MoveParams;
  if (type === "MVM") return { source: "", dest: "", mask: "0xFFFFFFFF" } satisfies MoveParams;
  if (type === "COP" || type === "CPS") return { source: "", dest: "", length: "1" } satisfies CopyParams;
  if (type === "BSL" || type === "BSR") return { array: "", source: "", length: "32" } satisfies BitShiftParams;
  if (["ADD", "SUB", "MUL", "DIV", "MOD"].includes(type)) {
    return { sourceA: "", sourceB: "", dest: "" } satisfies MathParams;
  }
  if (["NEG", "ABS", "SQR", "CLR"].includes(type)) {
    return { sourceA: "", dest: "" } satisfies MathParams;
  }
  if (type === "JSR") return { routineName: "" } satisfies JsrParams;
  return {};
}

function tokenize(line: string): string[] {
  return line.match(/"[^"]*"|\S+/g)?.map(token => {
    if (token.startsWith('"') && token.endsWith('"')) return token.slice(1, -1);
    return token;
  }) ?? [];
}

function rememberTag(
  tags: Map<string, TagHint>,
  ref: string,
  dataType: TagDataType,
  preset?: number
): void {
  const base = baseTagName(ref);
  if (!base || isLiteral(base)) return;

  const existing = tags.get(base);
  if (existing) {
    if (existing.dataType === "BOOL" && dataType !== "BOOL") {
      tags.set(base, { name: base, dataType, preset });
    } else if (preset !== undefined && existing.preset === undefined) {
      tags.set(base, { ...existing, preset });
    }
    return;
  }

  tags.set(base, { name: base, dataType, preset });
}

function baseTagName(ref: string): string {
  const match = ref.match(/^([A-Za-z_]\w*)/);
  return match?.[1] ?? "";
}

function isLiteral(value: string): boolean {
  return /^-?\d+(?:\.\d+)?$/.test(value) || /^0x[0-9a-f]+$/i.test(value);
}

function consumeOptionalNumber(
  tokens: string[],
  index: number,
  fallback: number
): { value: number; nextIndex: number } {
  const value = tokens[index];
  if (!value || isInstructionBoundary(value)) {
    return { value: fallback, nextIndex: index };
  }
  const parsed = Number(value);
  return {
    value: Number.isFinite(parsed) ? parsed : fallback,
    nextIndex: index + 1,
  };
}

function isInstructionBoundary(value: string): boolean {
  const upper = value.toUpperCase();
  return upper === "BST" || upper === "NXB" || upper === "BND" || INSTRUCTION_TYPES.has(upper as InstructionType);
}
