// =============================================================================
// PLC Ladder Logic AST — Core Types
// =============================================================================
// This is the single source of truth for all ladder logic structure.
// The canvas ONLY reads from this model. Nothing in the canvas writes back.
// All mutations go through the store, which calls the validation engine first.
// =============================================================================

// ---------------------------------------------------------------------------
// Tag / Data types
// ---------------------------------------------------------------------------

export type TagDataType = "BOOL" | "DINT" | "INT" | "REAL" | "TIMER" | "COUNTER";

export interface TagDefinition {
  id: string;
  name: string;           // e.g. "Motor_Run", "Sensor_1"
  dataType: TagDataType;
  value: TagValue;
  description?: string;
  /**
   * Array size. When set (>1) and dataType is DINT or INT, `value` holds a
   * number[] of this length. Each element is a 32-bit (DINT) or 16-bit (INT)
   * signed integer. Bit-level access uses `TagName[idx].bitNum` notation.
   */
  size?: number;
  // For TIMER/COUNTER, the structured value lives here
  timerData?: TimerData;
  counterData?: CounterData;
}

export type TagValue = boolean | number | number[];

export interface TimerData {
  /** Preset value in ms */
  preset: number;
  /** Accumulated value in ms */
  accum: number;
  /** Timer Enable bit */
  en: boolean;
  /** Timer Timing bit */
  tt: boolean;
  /** Timer Done bit */
  dn: boolean;
  /** Runtime-only legacy field stripped while loading projects. */
  _startMs?: number;
}

export interface CounterData {
  preset: number;
  accum: number;
  /** Count Up Enable */
  cu: boolean;
  /** Count Down Enable */
  cd: boolean;
  /** Done */
  dn: boolean;
  /** Overflow */
  ov: boolean;
  /** Underflow */
  un: boolean;
}

// ---------------------------------------------------------------------------
// Instruction types
// ---------------------------------------------------------------------------

/**
 * All supported instruction mnemonics.
 * Contacts (examine/read) go on the left side of a rung.
 * Coils (output) go at the right end of a rung path.
 */
export type InstructionType =
  // Examine instructions (contacts) — can appear anywhere in series path
  | "XIC"   // Examine If Closed  — true when tag is TRUE
  | "XIO"   // Examine If Open    — true when tag is FALSE
  | "AFI"   // Always False        — blocks rung power
  | "OSR"   // One-Shot Rising    — true for one scan on rising edge
  | "OSF"   // One-Shot Falling   — true for one scan on falling edge
  | "ONS"   // One-Shot           — passes power for one scan on rising edge of rung condition
  // Compare instructions (contact-class) — conduct when comparison is TRUE
  | "EQU"   // Equal              — Source A == Source B
  | "NEQ"   // Not Equal          — Source A != Source B
  | "LES"   // Less Than          — Source A <  Source B
  | "LEQ"   // Less Than or Equal — Source A <= Source B
  | "GRT"   // Greater Than       — Source A >  Source B
  | "GEQ"   // Greater Than Equal — Source A >= Source B
  | "LIM"   // Limit Test         — Low <= Test <= High
  // Output instructions (coils) — must be at the END of a rung path
  | "OTE"   // Output Energize    — sets tag = rung condition
  | "OTL"   // Output Latch       — sets tag TRUE when rung TRUE
  | "OTU"   // Output Unlatch     — sets tag FALSE when rung TRUE
  // Timer/Counter (output-class — must be at end of rung)
  | "TON"   // Timer On-Delay
  | "TOF"   // Timer Off-Delay
  | "RTO"   // Retentive Timer On
  | "CTU"   // Count Up
  | "CTD"   // Count Down
  | "RES"   // Reset (Timer/Counter)
  // Move/Math (output-class)
  | "MOV"   // Move               — Dest = Source (when rung TRUE)
  | "MVM"   // Masked Move        — Dest = (Source & Mask) | (Dest & ~Mask)
  | "COP"   // Copy File          — copies Source to Dest for Length elements
  | "CPS"   // Synchronous Copy    — copy file without interruption
  | "BSL"   // Bit Shift Left     — shifts bits left on rung false-to-true
  | "BSR"   // Bit Shift Right    — shifts bits right on rung false-to-true
  | "ADD"   // Add                — Dest = Source A + Source B
  | "SUB"   // Subtract           — Dest = Source A - Source B
  | "MUL"   // Multiply           — Dest = Source A * Source B
  | "DIV"   // Divide             — Dest = Source A / Source B
  | "MOD"   // Modulo             — Dest = Source A % Source B
  | "NEG"   // Negate             — Dest = -Source A
  | "ABS"   // Absolute Value     — Dest = abs(Source A)
  | "SQR"   // Square Root
  | "CLR"   // Clear
  | "JSR"   // Jump to Subroutine
  | "NOP";  // No Operation

/** Instructions that can appear in the middle of a series path */
export const CONTACT_INSTRUCTIONS: ReadonlySet<InstructionType> = new Set([
  "XIC", "XIO", "AFI", "OSR", "OSF", "ONS",
  "EQU", "NEQ", "LES", "LEQ", "GRT", "GEQ", "LIM",
]);

/** Instructions that must be at the end (rightmost) of a rung path */
export const OUTPUT_INSTRUCTIONS: ReadonlySet<InstructionType> = new Set([
  "OTE", "OTL", "OTU", "TON", "TOF", "RTO", "CTU", "CTD", "RES",
  "MOV", "MVM", "COP", "CPS", "BSL", "BSR", "ADD", "SUB", "MUL", "DIV", "MOD", "NEG", "ABS", "SQR", "CLR",
  "JSR", "NOP",
]);

export const COIL_OUTPUT_INSTRUCTIONS: ReadonlySet<InstructionType> = new Set([
  "OTE", "OTL", "OTU", "JSR", "NOP",
]);

export function isContact(type: InstructionType): boolean {
  return CONTACT_INSTRUCTIONS.has(type);
}

export function isOutput(type: InstructionType): boolean {
  return OUTPUT_INSTRUCTIONS.has(type);
}

export function isCoilOutput(type: InstructionType): boolean {
  return COIL_OUTPUT_INSTRUCTIONS.has(type);
}

// ---------------------------------------------------------------------------
// Instruction parameters
// ---------------------------------------------------------------------------

/** Params for timer instructions (TON, TOF, RTO) */
export interface TimerParams {
  preset: number;      // ms (literal preset — used when presetTag is absent)
  accum: number;       // ms (runtime state — stored on the tag)
  presetTag?: string;  // optional DINT/INT tag reference — overrides preset literal
}

/** Params for counter instructions (CTU, CTD) */
export interface CounterParams {
  preset: number;
  accum: number;
  presetTag?: string;  // optional DINT/INT tag reference — overrides preset literal
}

/**
 * Params for compare instructions (EQU, NEQ, LES, LEQ, GRT, GEQ, LIM).
 * Each operand is either a tag name (string) or a numeric literal stored as string.
 */
export interface CompareParams {
  sourceA: string;   // tag name or numeric literal, e.g. "MyTag" or "42"
  sourceB: string;
  sourceC?: string;  // LIM only: high limit
}

/**
 * Params for MOV / MVM instructions.
 * source  — tag name or numeric literal
 * dest    — always a tag name (write target)
 * mask    — MVM only: tag name or hex literal, e.g. "0x00FF"
 */
export interface MoveParams {
  source: string;
  dest: string;
  mask?: string;     // MVM only
}

export interface CopyParams {
  source: string;    // tag name, array element, or literal
  dest: string;      // tag name or array element write target
  length: string;    // number of destination elements to copy
}

export interface BitShiftParams {
  array: string;     // DINT/INT tag or array tag to shift
  source: string;    // BOOL/numeric tag or literal loaded into the vacated bit
  length: string;    // number of bits to shift
}

/**
 * Params for arithmetic instructions.
 * sourceA/sourceB are tag names or numeric literals. sourceB is unused by
 * unary instructions (NEG, ABS, SQR, CLR). dest is always a write target.
 */
export interface MathParams {
  sourceA: string;
  sourceB?: string;
  dest: string;
}

export interface JsrParams {
  routineName: string;
}

export type InstructionParams = TimerParams | CounterParams | CompareParams | MoveParams | CopyParams | BitShiftParams | MathParams | JsrParams | Record<string, never>;

// ---------------------------------------------------------------------------
// AST Node types
// ---------------------------------------------------------------------------

/**
 * A leaf node: a single instruction bound to a tag.
 */
export interface InstructionNode {
  kind: "instruction";
  id: string;
  type: InstructionType;
  /** The tag name this instruction is bound to. May be empty string while editing. */
  tagName: string;
  params: InstructionParams;
  /** Optional user comment shown above the instruction on the canvas. */
  comment?: string;
  /** Runtime: was this node powered (true) in the last scan? Set by simulator. */
  powered?: boolean;
}

/**
 * A single parallel leg inside a branch.
 * Each leg is its own series list, same as a mini-rung.
 * A leg CAN be empty (visually shows as a wire bypass).
 */
export interface BranchLeg {
  id: string;
  nodes: SeriesNode[];
}

/**
 * A parallel branch group — renders as the familiar "rungs within a rung" shape.
 * Has 2 or more legs arranged vertically.
 * The branch as a whole is TRUE if ANY leg evaluates TRUE.
 */
export interface BranchNode {
  kind: "branch";
  id: string;
  legs: BranchLeg[];
  /** Runtime: overall powered state */
  powered?: boolean;
}

/** Union of all node types that can appear in a series list */
export type SeriesNode = InstructionNode | BranchNode;

// ---------------------------------------------------------------------------
// Rung
// ---------------------------------------------------------------------------

/**
 * A single rung in a routine.
 * nodes is a flat series list — executed left-to-right.
 * The rung is powered (conditioned) when all series nodes evaluate TRUE.
 *
 * Rules enforced at insertion time:
 *  - Output instructions may only appear at the END of the top-level nodes list.
 *  - Output instructions may NOT appear inside branch legs.
 *  - At most one output instruction per rung (MVP).
 *  - A rung with zero nodes is valid (represents an empty rung / placeholder).
 */
export interface Rung {
  id: string;
  comment: string;
  nodes: SeriesNode[];
  /** Runtime: was the rung fully powered in the last scan? */
  powered?: boolean;
  /** If true, rung is disabled (greyed out, not scanned) */
  disabled?: boolean;
  /** Online edit state: pending edits are visible but not scanned until accepted. */
  onlineEditStatus?: "pending" | "pending-delete";
  /** Snapshot of the live rung before online edits, used for scan/cancel. */
  onlineEditOriginal?: {
    comment: string;
    nodes: SeriesNode[];
    disabled?: boolean;
  };
}

// ---------------------------------------------------------------------------
// Routine
// ---------------------------------------------------------------------------

/**
 * A named collection of rungs — analogous to a Studio 5000 Routine.
 */
export type RoutineLanguage = "LAD" | "ST";

export interface Routine {
  id: string;
  name: string;
  language: RoutineLanguage;
  rungs: Rung[];
  /** IEC 61131-3 Structured Text source for ST routines. */
  structuredText?: string;
}

// ---------------------------------------------------------------------------
// Program / Project
// ---------------------------------------------------------------------------

export interface PlcProgram {
  id: string;
  name: string;
  routines: Routine[];
}

export interface PlcProject {
  id: string;
  name: string;
  programs: PlcProgram[];
  /** Global tag database */
  tags: TagDefinition[];
  /** Project metadata */
  createdAt: string;
  modifiedAt: string;
}

// ---------------------------------------------------------------------------
// Insertion / Edit intent types (used by validation engine)
// ---------------------------------------------------------------------------

/**
 * Describes where in the AST to insert a new node.
 *
 * "series-before" / "series-after": insert adjacent to a sibling in a series list.
 * "branch-leg-insert": insert at a position within a specific branch leg.
 * "branch-wrap": wrap an existing node (or range) in a new 2-leg branch.
 * "branch-add-leg": add a new parallel leg to an existing branch.
 * "branch-nest": insert a new branch inside a specific leg.
 */
export type InsertPosition =
  | { kind: "series-before";    rungId: string; siblingId: string }
  | { kind: "series-after";     rungId: string; siblingId: string }
  | { kind: "series-append";    rungId: string }            // after last node
  | { kind: "series-prepend";   rungId: string }            // before first node
  | { kind: "branch-leg-before"; rungId: string; branchId: string; legId: string; siblingId: string }
  | { kind: "branch-leg-after";  rungId: string; branchId: string; legId: string; siblingId: string }
  | { kind: "branch-leg-append"; rungId: string; branchId: string; legId: string }
  | { kind: "branch-wrap";       rungId: string; nodeId: string }
  | { kind: "branch-add-leg";    rungId: string; branchId: string; afterLegId?: string }
  | { kind: "rung-append" };     // brand-new rung at end of routine

/** Describes a deletion */
export type DeleteTarget =
  | { kind: "node";   rungId: string; nodeId: string }
  | { kind: "leg";    rungId: string; branchId: string; legId: string }
  | { kind: "rung";   rungId: string };

/** Describes a move — same as delete + insert */
export interface MoveIntent {
  source: DeleteTarget;
  dest: InsertPosition;
}

// ---------------------------------------------------------------------------
// Validation result types (returned by the validation engine)
// ---------------------------------------------------------------------------

export type ValidationOK = { valid: true };
export type ValidationErr = { valid: false; reason: string };
export type ValidationResult = ValidationOK | ValidationErr;

export function ok(): ValidationOK {
  return { valid: true };
}

export function err(reason: string): ValidationErr {
  return { valid: false, reason };
}

// ---------------------------------------------------------------------------
// Runtime / Simulation types
// ---------------------------------------------------------------------------

/**
 * Snapshot of a single rung's power-flow after a scan.
 * Used to drive canvas colouring without re-deriving from the AST.
 */
export interface RungPowerState {
  rungId: string;
  /** Top-level rung powered */
  rungPowered: boolean;
  /** Per-node powered states — keyed by node id (drives block border colour) */
  nodePowered: Map<string, boolean>;
  /**
   * Per-node OUTPUT power — the condition that exits the right side of a node.
   * Usually equals nodePowered, but differs for terminal blocks like TON/CTU
   * where the block lights up (nodePowered=true) yet passes no power downstream
   * (nodeOutputPowered=false).  Used to colour the wire to the right of a node.
   * Falls back to nodePowered when absent.
   */
  nodeOutputPowered: Map<string, boolean>;
  /** Per-leg powered states — keyed by legId */
  legPowered: Map<string, boolean>;
}

export type ScanResult = Map<string, RungPowerState>;

