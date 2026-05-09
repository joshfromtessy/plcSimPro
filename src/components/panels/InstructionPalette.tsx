// =============================================================================
// Instruction Palette — drag source for instructions
// =============================================================================
import { useState } from "react";
import { useEditorStore } from "../../store/editorStore";
import { useProjectStore } from "../../store/projectStore";
import { useSimulationStore } from "../../store/simulationStore";
import type { InsertPosition, InstructionType } from "../../model/types";
import "./InstructionPalette.css";

interface PaletteItem {
  type: InstructionType;
  label: string;
  description: string;
}

const CONTACT_ITEMS: PaletteItem[] = [
  { type: "XIC", label: "XIC", description: "Examine If Closed" },
  { type: "XIO", label: "XIO", description: "Examine If Open" },
  { type: "OSR", label: "OSR", description: "One-Shot Rising" },
  { type: "OSF", label: "OSF", description: "One-Shot Falling" },
  { type: "ONS", label: "ONS", description: "One Shot (inline)" },
  { type: "AFI", label: "AFI", description: "Always False" },
];

const OUTPUT_ITEMS: PaletteItem[] = [
  { type: "OTE", label: "OTE", description: "Output Energize" },
  { type: "OTL", label: "OTL", description: "Output Latch" },
  { type: "OTU", label: "OTU", description: "Output Unlatch" },
];

const TIMER_ITEMS: PaletteItem[] = [
  { type: "TON", label: "TON", description: "Timer On-Delay" },
  { type: "TOF", label: "TOF", description: "Timer Off-Delay" },
  { type: "RTO", label: "RTO", description: "Retentive Timer" },
];

const COUNTER_ITEMS: PaletteItem[] = [
  { type: "CTU", label: "CTU", description: "Count Up" },
  { type: "CTD", label: "CTD", description: "Count Down" },
  { type: "RES", label: "RES", description: "Reset" },
];

const COMPARE_ITEMS: PaletteItem[] = [
  { type: "EQU", label: "EQU", description: "Equal" },
  { type: "NEQ", label: "NEQ", description: "Not Equal" },
  { type: "LES", label: "LES", description: "Less Than" },
  { type: "LEQ", label: "LEQ", description: "Less Than or Equal" },
  { type: "GRT", label: "GRT", description: "Greater Than" },
  { type: "GEQ", label: "GEQ", description: "Greater Than or Equal" },
];

const MOVE_ITEMS: PaletteItem[] = [
  { type: "MOV", label: "MOV", description: "Move" },
  { type: "MVM", label: "MVM", description: "Masked Move" },
];

const MATH_ITEMS: PaletteItem[] = [
  { type: "ADD", label: "ADD", description: "Add" },
  { type: "SUB", label: "SUB", description: "Subtract" },
  { type: "MUL", label: "MUL", description: "Multiply" },
  { type: "DIV", label: "DIV", description: "Divide" },
  { type: "MOD", label: "MOD", description: "Modulo" },
  { type: "NEG", label: "NEG", description: "Negate" },
  { type: "ABS", label: "ABS", description: "Absolute Value" },
  { type: "SQR", label: "SQR", description: "Square Root" },
  { type: "CLR", label: "CLR", description: "Clear" },
];

const PROGRAM_ITEMS: PaletteItem[] = [
  { type: "JSR", label: "JSR", description: "Jump to Subroutine" },
  { type: "NOP", label: "NOP", description: "No Operation" },
];

// ── SVG instruction icons ──────────────────────────────────────────────────
// All use stroke="currentColor" so they inherit the group accent colour.

function XICIcon() {
  return (
    <svg viewBox="0 0 36 18" width="36" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <line x1="0"  y1="9" x2="10" y2="9" />
      <line x1="10" y1="2" x2="10" y2="16" />
      <line x1="26" y1="2" x2="26" y2="16" />
      <line x1="26" y1="9" x2="36" y2="9" />
    </svg>
  );
}

function XIOIcon() {
  return (
    <svg viewBox="0 0 36 18" width="36" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <line x1="0"  y1="9" x2="10" y2="9" />
      <line x1="10" y1="2" x2="10" y2="16" />
      <line x1="26" y1="2" x2="26" y2="16" />
      <line x1="26" y1="9" x2="36" y2="9" />
      {/* diagonal slash */}
      <line x1="14" y1="14" x2="22" y2="4" />
    </svg>
  );
}

function OSRIcon() {
  return (
    <svg viewBox="0 0 36 18" width="36" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <line x1="0"  y1="9" x2="10" y2="9" />
      <line x1="10" y1="2" x2="10" y2="16" />
      <line x1="26" y1="2" x2="26" y2="16" />
      <line x1="26" y1="9" x2="36" y2="9" />
      {/* up arrow */}
      <line x1="18" y1="14" x2="18" y2="5" />
      <polyline points="14,9 18,5 22,9" />
    </svg>
  );
}

function OSFIcon() {
  return (
    <svg viewBox="0 0 36 18" width="36" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <line x1="0"  y1="9" x2="10" y2="9" />
      <line x1="10" y1="2" x2="10" y2="16" />
      <line x1="26" y1="2" x2="26" y2="16" />
      <line x1="26" y1="9" x2="36" y2="9" />
      {/* down arrow */}
      <line x1="18" y1="4"  x2="18" y2="13" />
      <polyline points="14,9 18,13 22,9" />
    </svg>
  );
}

function OTEIcon() {
  return (
    <svg viewBox="0 0 36 18" width="36" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <line x1="0"  y1="9" x2="12" y2="9" />
      <circle cx="18" cy="9" r="6" />
      <line x1="24" y1="9" x2="36" y2="9" />
    </svg>
  );
}

function OTLIcon() {
  return (
    <svg viewBox="0 0 36 18" width="36" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <line x1="0"  y1="9" x2="12" y2="9" />
      <circle cx="18" cy="9" r="6" />
      <line x1="24" y1="9" x2="36" y2="9" />
      {/* L glyph */}
      <line x1="15.5" y1="5.5"  x2="15.5" y2="12.5" />
      <line x1="15.5" y1="12.5" x2="20.5" y2="12.5" />
    </svg>
  );
}

function OTUIcon() {
  return (
    <svg viewBox="0 0 36 18" width="36" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <line x1="0"  y1="9" x2="12" y2="9" />
      <circle cx="18" cy="9" r="6" />
      <line x1="24" y1="9" x2="36" y2="9" />
      {/* U glyph */}
      <line x1="15" y1="5.5"  x2="15" y2="12.5" />
      <line x1="15" y1="12.5" x2="21" y2="12.5" />
      <line x1="21" y1="12.5" x2="21" y2="5.5" />
    </svg>
  );
}

function ONSIcon() {
  return (
    <svg viewBox="0 0 36 18" width="36" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <line x1="0"  y1="9" x2="6"  y2="9" />
      <rect x="6" y="1" width="24" height="16" rx="1.5" />
      <line x1="30" y1="9" x2="36" y2="9" />
      {/* rising-pulse step glyph */}
      <polyline points="11,13 11,5 18,5 18,13 25,13" strokeWidth="1.5" />
    </svg>
  );
}

function BlockIcon({ label }: { label: string }) {
  return (
    <svg viewBox="0 0 36 18" width="36" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <line x1="0"  y1="9" x2="6"  y2="9" />
      <rect x="6" y="1" width="24" height="16" rx="1.5" />
      <line x1="30" y1="9" x2="36" y2="9" />
      <text
        x="18" y="12"
        textAnchor="middle"
        fontSize="6.5"
        fontFamily="Consolas, monospace"
        fill="currentColor"
        stroke="none"
        letterSpacing="0.5"
      >{label}</text>
    </svg>
  );
}

// Map every InstructionType to its icon element
const ICONS: Record<string, React.ReactNode> = {
  XIC: <XICIcon />,
  XIO: <XIOIcon />,
  AFI: <BlockIcon label="AFI" />,
  OSR: <OSRIcon />,
  OSF: <OSFIcon />,
  ONS: <ONSIcon />,
  OTE: <OTEIcon />,
  OTL: <OTLIcon />,
  OTU: <OTUIcon />,
  TON: <BlockIcon label="TON" />,
  TOF: <BlockIcon label="TOF" />,
  RTO: <BlockIcon label="RTO" />,
  CTU: <BlockIcon label="CTU" />,
  CTD: <BlockIcon label="CTD" />,
  RES: <BlockIcon label="RES" />,
  EQU: <BlockIcon label="EQU" />,
  NEQ: <BlockIcon label="NEQ" />,
  LES: <BlockIcon label="LES" />,
  LEQ: <BlockIcon label="LEQ" />,
  GRT: <BlockIcon label="GRT" />,
  GEQ: <BlockIcon label="GEQ" />,
  MOV: <BlockIcon label="MOV" />,
  MVM: <BlockIcon label="MVM" />,
  ADD: <BlockIcon label="ADD" />,
  SUB: <BlockIcon label="SUB" />,
  MUL: <BlockIcon label="MUL" />,
  DIV: <BlockIcon label="DIV" />,
  MOD: <BlockIcon label="MOD" />,
  NEG: <BlockIcon label="NEG" />,
  ABS: <BlockIcon label="ABS" />,
  SQR: <BlockIcon label="SQR" />,
  CLR: <BlockIcon label="CLR" />,
  JSR: <BlockIcon label="JSR" />,
  NOP: <BlockIcon label="NOP" />,
};

// ── Component ──────────────────────────────────────────────────────────────

export function InstructionPalette() {
  const { selection, startDrag, endDrag } = useEditorStore();
  const { project, activeRoutineId, insertInstruction } = useProjectStore();
  const { mode } = useSimulationStore();

  function handleDragStart(e: React.DragEvent, type: InstructionType) {
    e.dataTransfer.effectAllowed = "copy";
    e.dataTransfer.setData("application/plc-instruction", type);
    startDrag(type);
  }

  function handleDragEnd() {
    endDrag();
  }

  function handlePaletteClick(type: InstructionType) {
    if (!activeRoutineId) return;
    const routine = project.programs
      .flatMap(program => program.routines)
      .find(r => r.id === activeRoutineId);
    if (!routine) return;

    let position: InsertPosition;
    if (routine.rungs.length === 0) {
      position = { kind: "rung-append" };
    } else if (selection?.kind === "node") {
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
      position = { kind: "series-append", rungId: routine.rungs[routine.rungs.length - 1].id };
    }

    if (mode === "running") {
      if (position.kind === "rung-append") {
        useProjectStore.setState({ lastError: "Double-click a rung gutter to start online edit before changing logic in Run." });
        return;
      }
      const targetRung = routine.rungs.find(r => r.id === position.rungId);
      if (!targetRung?.onlineEditStatus || targetRung.onlineEditStatus === "pending-delete") {
        useProjectStore.setState({ lastError: "Double-click the rung gutter to start online edit before changing logic in Run." });
        return;
      }
    }

    insertInstruction(activeRoutineId, position, type);
  }

  return (
    <div className="palette">
      <div className="palette-header">Instructions</div>

      <PaletteGroup label="Contacts" colorClass="palette-group--contact" items={CONTACT_ITEMS}
        onDragStart={handleDragStart} onDragEnd={handleDragEnd} onClick={handlePaletteClick} />
      <PaletteGroup label="Outputs"  colorClass="palette-group--output"  items={OUTPUT_ITEMS}
        onDragStart={handleDragStart} onDragEnd={handleDragEnd} onClick={handlePaletteClick} />
      <PaletteGroup label="Compare"  colorClass="palette-group--compare" items={COMPARE_ITEMS}
        onDragStart={handleDragStart} onDragEnd={handleDragEnd} onClick={handlePaletteClick} />
      <PaletteGroup label="Move"     colorClass="palette-group--move"    items={MOVE_ITEMS}
        onDragStart={handleDragStart} onDragEnd={handleDragEnd} onClick={handlePaletteClick} />
      <PaletteGroup label="Math"     colorClass="palette-group--math"    items={MATH_ITEMS}
        onDragStart={handleDragStart} onDragEnd={handleDragEnd} onClick={handlePaletteClick} />
      <PaletteGroup label="Program"  colorClass="palette-group--program" items={PROGRAM_ITEMS}
        onDragStart={handleDragStart} onDragEnd={handleDragEnd} onClick={handlePaletteClick} />
      <PaletteGroup label="Timers"   colorClass="palette-group--timer"   items={TIMER_ITEMS}
        onDragStart={handleDragStart} onDragEnd={handleDragEnd} onClick={handlePaletteClick} />
      <PaletteGroup label="Counters" colorClass="palette-group--counter" items={COUNTER_ITEMS}
        onDragStart={handleDragStart} onDragEnd={handleDragEnd} onClick={handlePaletteClick} />
    </div>
  );
}

function PaletteGroup({
  label, colorClass, items, onDragStart, onDragEnd, onClick,
}: {
  label: string;
  colorClass: string;
  items: PaletteItem[];
  onDragStart: (e: React.DragEvent, type: InstructionType) => void;
  onDragEnd: () => void;
  onClick: (type: InstructionType) => void;
}) {
  const [open, setOpen] = useState(true);

  return (
    <div className={`palette-group ${colorClass}`}>
      <button
        className="palette-group-label"
        onClick={() => setOpen(o => !o)}
        type="button"
      >
        <span>{label}</span>
        <span className={`palette-group-chevron${open ? "" : " palette-group-chevron--closed"}`}>▾</span>
      </button>

      {/* CSS grid trick: grid-template-rows 0fr→1fr gives a smooth height transition */}
      <div className={`palette-group-body${open ? "" : " palette-group-body--closed"}`}>
        <div className="palette-group-body-inner">
          {items.map((item) => (
            <div
              key={item.type}
              className="palette-item"
              draggable
              onDragStart={(e) => onDragStart(e, item.type)}
              onDragEnd={onDragEnd}
              onClick={() => onClick(item.type)}
              title={`${item.label} — ${item.description}`}
            >
              <span className="palette-item-icon">{ICONS[item.type]}</span>
              <span className="palette-item-mnemonic">{item.label}</span>
              <span className="palette-item-sep">·</span>
              <span className="palette-item-desc">{item.description}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
