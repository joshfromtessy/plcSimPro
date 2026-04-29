// =============================================================================
// LadderCanvas — placeholder for the PixiJS canvas
// =============================================================================
// For now this renders a simple DOM-based ladder view so you can see the model
// in action before PixiJS is wired up.
// =============================================================================

import { useProjectStore } from "../../store/projectStore";
import { useSimulationStore } from "../../store/simulationStore";
import { useEditorStore } from "../../store/editorStore";
import type { Rung, SeriesNode, InstructionNode, BranchNode, InsertPosition } from "../../model/types";
import { isInstruction, isBranch } from "../../model/ast";
import "./LadderCanvas.css";

export function LadderCanvas() {
  const { project, activeRoutineId, insertInstruction, deleteNode } = useProjectStore();
  const { scanResult } = useSimulationStore();
  const { drag, endDrag } = useEditorStore();

  // Find active routine
  const routine = activeRoutineId
    ? project.programs.flatMap(p => p.routines).find(r => r.id === activeRoutineId)
    : null;

  function handleCanvasDrop(e: React.DragEvent) {
    e.preventDefault();
    endDrag();
  }

  function handleCanvasDragOver(e: React.DragEvent) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }

  if (!routine) {
    return (
      <div className="ladder-canvas ladder-canvas--empty">
        <span>No routine selected</span>
      </div>
    );
  }

  return (
    <div
      className="ladder-canvas"
      onDrop={handleCanvasDrop}
      onDragOver={handleCanvasDragOver}
    >
      <div className="ladder-routine-header">
        <span className="ladder-routine-name">{routine.name}</span>
        <button
          className="ladder-add-rung-btn"
          onClick={() => insertInstruction(routine.id, { kind: "rung-append" }, "XIC")}
        >
          + Add Rung
        </button>
      </div>

      <div className="ladder-rungs">
        {routine.rungs.map((rung, idx) => {
          const powerState = scanResult.get(rung.id);
          return (
            <RungView
              key={rung.id}
              rung={rung}
              rungNumber={idx + 1}
              routineId={routine.id}
              powered={powerState?.rungPowered ?? false}
              nodePowered={powerState?.nodePowered ?? new Map()}
              legPowered={powerState?.legPowered ?? new Map()}
              onInsert={(pos, type) => insertInstruction(routine.id, pos, type)}
              onDelete={(target) => deleteNode(routine.id, target)}
              dragType={drag.active ? drag.instructionType : null}
            />
          );
        })}
        {routine.rungs.length === 0 && (
          <div className="ladder-empty-hint">
            Drag instructions here or click "+ Add Rung"
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rung view
// ---------------------------------------------------------------------------

interface RungViewProps {
  rung: Rung;
  rungNumber: number;
  routineId: string;
  powered: boolean;
  nodePowered: Map<string, boolean>;
  legPowered: Map<string, boolean>;
  onInsert: (pos: InsertPosition, type: string) => void;
  onDelete: (target: any) => void;
  dragType: string | null;
}

function RungView({ rung, rungNumber, routineId, powered, nodePowered, legPowered, onInsert, onDelete, dragType }: RungViewProps) {
  return (
    <div className={`rung ${powered ? "rung--powered" : ""} ${rung.disabled ? "rung--disabled" : ""}`}>
      <div className="rung-number">{rungNumber}</div>
      <div className="rung-body">
        {rung.comment && <div className="rung-comment">{rung.comment}</div>}
        <div className="rung-rail rung-rail--left" />
        <div className="rung-series">
          {/* Drop zone before first node */}
          {dragType && (
            <DropZone
              label="→"
              valid={true}
              onDrop={() => onInsert({ kind: "series-prepend", rungId: rung.id }, dragType)}
            />
          )}
          {rung.nodes.map((node) => (
            <NodeView
              key={node.id}
              node={node}
              rungId={rung.id}
              powered={nodePowered.get(node.id) ?? false}
              legPowered={legPowered}
              nodePowered={nodePowered}
              onDelete={onDelete}
              dragType={dragType}
              onInsert={onInsert}
            />
          ))}
          {/* Append drop zone */}
          {dragType && (
            <DropZone
              label="+"
              valid={true}
              onDrop={() => onInsert({ kind: "series-append", rungId: rung.id }, dragType)}
            />
          )}
        </div>
        <div className={`rung-rail rung-rail--right ${powered ? "rail--powered" : ""}`} />
      </div>
      <button
        className="rung-delete-btn"
        onClick={() => onDelete({ kind: "rung", rungId: rung.id })}
        title="Delete rung"
      >✕</button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Node view (dispatches to InstructionView or BranchView)
// ---------------------------------------------------------------------------

interface NodeViewProps {
  node: SeriesNode;
  rungId: string;
  powered: boolean;
  nodePowered: Map<string, boolean>;
  legPowered: Map<string, boolean>;
  onDelete: (target: any) => void;
  dragType: string | null;
  onInsert: (pos: InsertPosition, type: string) => void;
}

function NodeView(props: NodeViewProps) {
  if (isInstruction(props.node)) {
    return <InstructionView {...props} node={props.node} />;
  }
  if (isBranch(props.node)) {
    return <BranchView {...props} node={props.node} />;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Instruction view
// ---------------------------------------------------------------------------

function InstructionView({
  node, rungId, powered, onDelete, dragType, onInsert
}: NodeViewProps & { node: InstructionNode }) {
  const isOut = ["OTE", "OTL", "OTU", "TON", "TOF", "RTO", "CTU", "CTD", "RES"].includes(node.type);

  return (
    <div className={`instr ${powered ? "instr--powered" : ""} ${isOut ? "instr--output" : "instr--contact"}`}>
      {dragType && (
        <DropZone
          label="←"
          valid={!["OTE","OTL","OTU","TON","TOF","RTO","CTU","CTD","RES"].includes(dragType)}
          onDrop={() => onInsert({ kind: "series-before", rungId, siblingId: node.id }, dragType)}
        />
      )}
      <div
        className="instr-body"
        onDoubleClick={() => onDelete({ kind: "node", rungId, nodeId: node.id })}
        title={`${node.type}: ${node.tagName || "(no tag)"}\nDouble-click to delete`}
      >
        <div className="instr-symbol">{instrSymbol(node.type)}</div>
        <div className="instr-type">{node.type}</div>
        <div className="instr-tag">{node.tagName || "?"}</div>
      </div>
      {dragType && (
        <DropZone
          label="→"
          valid={true}
          onDrop={() => onInsert({ kind: "series-after", rungId, siblingId: node.id }, dragType)}
        />
      )}
    </div>
  );
}

function instrSymbol(type: string): string {
  switch (type) {
    case "XIC": return "─┤ ├─";
    case "XIO": return "─┤/├─";
    case "OSR": return "─┤↑├─";
    case "OSF": return "─┤↓├─";
    case "OTE": return "─( )─";
    case "OTL": return "─(L)─";
    case "OTU": return "─(U)─";
    case "TON": return "[TON]";
    case "TOF": return "[TOF]";
    case "RTO": return "[RTO]";
    case "CTU": return "[CTU]";
    case "CTD": return "[CTD]";
    case "RES": return "[RES]";
    default:    return `[${type}]`;
  }
}

// ---------------------------------------------------------------------------
// Branch view
// ---------------------------------------------------------------------------

function BranchView({
  node, rungId, powered, nodePowered, legPowered, onDelete, dragType, onInsert
}: NodeViewProps & { node: BranchNode }) {
  return (
    <div className={`branch ${powered ? "branch--powered" : ""}`}>
      {/* Left vertical bar */}
      <div className="branch-rail branch-rail--left" />

      <div className="branch-legs">
        {node.legs.map((leg, legIdx) => {
          const legPow = legPowered.get(leg.id) ?? false;
          return (
            <div key={leg.id} className={`branch-leg ${legPow ? "branch-leg--powered" : ""}`}>
              {leg.nodes.length === 0 && (
                <div className="branch-leg-empty">── (empty) ──</div>
              )}
              {leg.nodes.map((n) => (
                <NodeView
                  key={n.id}
                  node={n}
                  rungId={rungId}
                  powered={nodePowered.get(n.id) ?? false}
                  nodePowered={nodePowered}
                  legPowered={legPowered}
                  onDelete={onDelete}
                  dragType={dragType}
                  onInsert={onInsert}
                />
              ))}
              {dragType && (
                <DropZone
                  label="+"
                  valid={true}
                  onDrop={() => onInsert(
                    { kind: "branch-leg-append", rungId, branchId: node.id, legId: leg.id },
                    dragType
                  )}
                />
              )}
              {leg.nodes.length > 0 && (
                <button
                  className="leg-delete-btn"
                  onClick={() => onDelete({ kind: "leg", rungId, branchId: node.id, legId: leg.id })}
                  title="Delete leg"
                >✕</button>
              )}
            </div>
          );
        })}
        {/* Add leg button */}
        <button
          className="branch-add-leg-btn"
          onClick={() => onInsert({ kind: "branch-add-leg", rungId, branchId: node.id }, dragType ?? "XIC")}
          title="Add parallel leg"
        >+ leg</button>
      </div>

      {/* Right vertical bar */}
      <div className="branch-rail branch-rail--right" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Drop zone indicator
// ---------------------------------------------------------------------------

function DropZone({ label, valid, onDrop }: { label: string; valid: boolean; onDrop: () => void }) {
  return (
    <div
      className={`drop-zone ${valid ? "drop-zone--valid" : "drop-zone--invalid"}`}
      onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
      onDrop={(e) => { e.preventDefault(); e.stopPropagation(); if (valid) onDrop(); }}
    >
      {label}
    </div>
  );
}
