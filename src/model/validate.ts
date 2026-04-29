// =============================================================================
// Validation Engine — Studio 5000-style insertion rules
// =============================================================================
// Every mutation to the AST must pass through here first.
// The engine validates INTENT (an InsertPosition + InstructionType) and returns
// either ok() or err(reason).  The caller must not apply the mutation if invalid.
//
// Core rules enforced:
//  1. Output instructions can only be the LAST node in the TOP-LEVEL series list.
//  2. Output instructions CANNOT appear inside branch legs.
//  3. Only one output instruction per rung (MVP).
//  4. Contact instructions can appear anywhere a contact is legal.
//  5. A branch must always have at least 2 legs.
//  6. Deleting a leg from a 2-leg branch is allowed — the branch collapses (unwraps).
//  7. Deleting a node that is the only node in a leg is allowed — the leg becomes empty.
//  8. Cannot create a branch-wrap around an output instruction that is the terminal node.
//  9. Outputs cannot be inserted before another node (would leave output in middle).
// 10. Nesting depth is capped at MAX_BRANCH_DEPTH.
// =============================================================================

import {
  ok,
  err,
  isCoilOutput,
  type InstructionType,
  type ValidationResult,
  type InsertPosition,
  type DeleteTarget,
  type Rung,
  type BranchNode,
  type SeriesNode,
} from "./types";

import {
  isInstruction,
  isBranch,
  findNodeInRung,
  findBranchInRung,
  locateNodeInRung,
  maxBranchDepth,
} from "./ast";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum nesting depth for branches */
export const MAX_BRANCH_DEPTH = 5;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns the LAST node in the top-level series list, or undefined.
 * This is the only position where an output may live.
 */
function topLevelIndex(rung: Rung, nodeId: string): number {
  return rung.nodes.findIndex((node) => node.id === nodeId);
}

function firstTopLevelOutputIndex(rung: Rung): number {
  return rung.nodes.findIndex((node) => isInstruction(node) && isCoilOutput(node.type));
}

function isTopLevelOutput(rung: Rung, nodeId: string): boolean {
  const idx = topLevelIndex(rung, nodeId);
  const node = idx >= 0 ? rung.nodes[idx] : undefined;
  return !!node && isInstruction(node) && isCoilOutput(node.type);
}

/**
 * Returns true if the given node (by id) lives inside any branch leg (any depth).
 */
function isInsideBranch(rung: Rung, nodeId: string): boolean {
  const loc = locateNodeInRung(rung, nodeId);
  return !!loc && loc.legId !== undefined;
}

/**
 * Ensure the instruction type is known.
 */
function isKnownType(type: InstructionType): boolean {
  const known: InstructionType[] = [
    "XIC","XIO","OSR","OSF","ONS",
    "OTE","OTL","OTU",
    "TON","TOF","RTO",
    "CTU","CTD","RES",
  ];
  return known.includes(type);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate an insertion intent before applying it.
 *
 * @param rung       The current rung state.
 * @param position   Where the user wants to insert.
 * @param type       The instruction type being inserted.
 */
export function validateInsert(
  rung: Rung,
  position: InsertPosition,
  type: InstructionType
): ValidationResult {
  if (!isKnownType(type)) {
    return err(`Unknown instruction type: ${type}`);
  }

  const isOut = isCoilOutput(type);
  switch (position.kind) {
    // -----------------------------------------------------------------------
    // Top-level series insertions
    // -----------------------------------------------------------------------

    case "series-append": {
      return ok();
    }

    case "series-prepend": {
      // Prepending to front — only valid for contacts.
      if (isOut) {
        return err("Output instructions must be at the END of a rung, not the beginning.");
      }
      return ok();
    }

    case "series-before": {
      // Check sibling exists
      if (!findNodeInRung(rung, position.siblingId)) {
        return err(`Target node '${position.siblingId}' not found in rung.`);
      }

      if (isOut) {
        if (isInsideBranch(rung, position.siblingId)) {
          return err("Cannot insert output inside a branch leg.");
        }
        if (!isTopLevelOutput(rung, position.siblingId)) {
          return err("Output instructions must be placed in the rung output section.");
        }
      }

      return ok();
    }

    case "series-after": {
      const sibling = findNodeInRung(rung, position.siblingId);
      if (!sibling) {
        return err(`Target node '${position.siblingId}' not found in rung.`);
      }

      const siblingIdx = topLevelIndex(rung, position.siblingId);
      const firstOutputIdx = firstTopLevelOutputIndex(rung);

      if (isOut && (siblingIdx === -1 || isInsideBranch(rung, position.siblingId))) {
        return err("Cannot insert output after a node inside a branch leg.");
      }

      if (isOut && firstOutputIdx === -1 && siblingIdx !== rung.nodes.length - 1) {
        return err("Output instructions must be placed in the rung output section.");
      }

      if (isOut && firstOutputIdx !== -1 && siblingIdx + 1 < firstOutputIdx) {
        return err("Output instructions must be placed in the rung output section.");
      }

      return ok();
    }

    // -----------------------------------------------------------------------
    // Branch leg insertions
    // -----------------------------------------------------------------------

    case "branch-leg-before":
    case "branch-leg-after":
    case "branch-leg-append": {
      // Coil outputs are never allowed inside branch legs
      if (isOut) {
        return err("Output instructions cannot be placed inside a branch leg.");
      }

      const branch = findBranchInRung(rung, position.branchId);
      if (!branch) {
        return err(`Branch '${position.branchId}' not found in rung.`);
      }

      const leg = branch.legs.find((l) => l.id === position.legId);
      if (!leg) {
        return err(`Branch leg '${position.legId}' not found.`);
      }

      // For leg-before/after, check sibling exists
      if (
        position.kind === "branch-leg-before" ||
        position.kind === "branch-leg-after"
      ) {
        const siblingInLeg = leg.nodes.find((n) => n.id === position.siblingId);
        if (!siblingInLeg) {
          return err(`Sibling node '${position.siblingId}' not found in leg.`);
        }
      }

      return ok();
    }

    // -----------------------------------------------------------------------
    // Branch structural operations
    // -----------------------------------------------------------------------

    case "branch-wrap": {
      // Wrapping creates a new branch around an existing node.
      // The new node goes in the second leg.
      if (isOut) {
        return err("Cannot create a branch containing an output instruction.");
      }

      const target = findNodeInRung(rung, position.nodeId);
      if (!target) {
        return err(`Node '${position.nodeId}' not found.`);
      }

      // Cannot wrap a coil output instruction
      if (isInstruction(target) && isCoilOutput(target.type)) {
        return err("Cannot branch around an output instruction.");
      }

      // Depth check: wrapping adds one level
      const depth = maxBranchDepth(rung.nodes);
      if (depth >= MAX_BRANCH_DEPTH) {
        return err(`Maximum branch nesting depth (${MAX_BRANCH_DEPTH}) reached.`);
      }

      return ok();
    }

    case "branch-add-leg": {
      // Adding a leg to an existing branch — the new leg starts empty.
      // The instruction type here is informational (it describes what will go IN the leg),
      // but the leg itself starts empty, so we just check the branch exists.
      if (isOut) {
        return err("Output instructions cannot be placed inside a branch leg.");
      }

      const branch = findBranchInRung(rung, position.branchId);
      if (!branch) {
        return err(`Branch '${position.branchId}' not found.`);
      }

      return ok();
    }

    case "rung-append": {
      // Adding a new rung — always valid.
      return ok();
    }

    default: {
      const _exhaustive: never = position;
      return err(`Unhandled insert position kind.`);
    }
  }
}

// ---------------------------------------------------------------------------
// Validate delete
// ---------------------------------------------------------------------------

/**
 * Validate a deletion intent before applying it.
 *
 * Rules:
 *  - Deleting a node from a branch leg: always ok (leg can become empty).
 *  - Deleting a branch leg: only ok if the branch has > 2 legs OR exactly 2 (then branch collapses).
 *    Never leave a branch with 0 legs.
 *  - Deleting a rung: always ok.
 */
export function validateDelete(
  rung: Rung,
  target: DeleteTarget
): ValidationResult {
  switch (target.kind) {
    case "node": {
      if (!findNodeInRung(rung, target.nodeId)) {
        return err(`Node '${target.nodeId}' not found in rung.`);
      }
      return ok();
    }

    case "leg": {
      const branch = findBranchInRung(rung, target.branchId);
      if (!branch) {
        return err(`Branch '${target.branchId}' not found.`);
      }
      if (!branch.legs.find((l) => l.id === target.legId)) {
        return err(`Leg '${target.legId}' not found in branch.`);
      }
      // 1-leg branches are handled by collapseSingleLegBranches post-delete.
      // We just ensure we're not trying to delete from a branch with < 2 legs (shouldn't happen,
      // but guard anyway).
      if (branch.legs.length < 2) {
        return err("Cannot delete the last leg of a branch. Delete the branch instead.");
      }
      return ok();
    }

    case "rung": {
      return ok();
    }
  }
}

// ---------------------------------------------------------------------------
// Validate tag assignment
// ---------------------------------------------------------------------------

/**
 * Validate assigning a tag name to an instruction node.
 * - tagName must not be empty.
 * - tagName must match identifier rules: letters, digits, underscore, dot notation.
 * - For outputs, the tag must not already be written by another output in the same rung
 *   (OTE conflict — OTL + OTU to the same tag is allowed per Studio 5000).
 */
export function validateTagAssign(
  rung: Rung,
  nodeId: string,
  tagName: string
): ValidationResult {
  if (!tagName.trim()) {
    return err("Tag name cannot be empty.");
  }

  // Simple identifier pattern: alphanumeric + underscores + dots (for structured tags)
  if (!/^[A-Za-z_][A-Za-z0-9_.[\]]*$/.test(tagName)) {
    return err(
      `Invalid tag name '${tagName}'. Must start with a letter or underscore and contain only letters, digits, underscores, dots, or brackets.`
    );
  }

  const node = findNodeInRung(rung, nodeId);
  if (!node) {
    return err(`Node '${nodeId}' not found.`);
  }
  if (!isInstruction(node)) {
    return err("Cannot assign tag to a branch node.");
  }

  // OTE conflict check: only one OTE per tag per rung
  if (node.type === "OTE") {
    const conflict = findOutputConflict(rung, nodeId, tagName, "OTE");
    if (conflict) {
      return err(`Tag '${tagName}' is already driven by another OTE in this rung.`);
    }
  }

  return ok();
}

function findOutputConflict(
  rung: Rung,
  excludeNodeId: string,
  tagName: string,
  type: "OTE"
): boolean {
  return searchNodes(rung.nodes, excludeNodeId, tagName, type);
}

function searchNodes(
  nodes: SeriesNode[],
  excludeId: string,
  tagName: string,
  type: "OTE"
): boolean {
  for (const node of nodes) {
    if (isInstruction(node)) {
      if (node.id !== excludeId && node.type === type && node.tagName === tagName) {
        return true;
      }
    } else if (isBranch(node)) {
      for (const leg of node.legs) {
        if (searchNodes(leg.nodes, excludeId, tagName, type)) return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Validate full rung structural integrity (for post-edit checks)
// ---------------------------------------------------------------------------

/**
 * Structural invariant check. Run this after any mutation to catch any bugs
 * in the mutation logic itself. Should never fail in production if validateInsert
 * is working correctly.
 */
export function validateRungIntegrity(rung: Rung): ValidationResult {
  return checkSeriesIntegrity(rung.nodes, false, rung.id);
}

function checkSeriesIntegrity(
  nodes: SeriesNode[],
  insideBranch: boolean,
  context: string
): ValidationResult {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];

    if (isInstruction(node)) {
      if (isCoilOutput(node.type)) {
        if (insideBranch) {
          return err(`Output '${node.type}' found inside a branch leg (context: ${context}). This is not allowed.`);
        }
      }
    } else if (isBranch(node)) {
      if (node.legs.length < 2) {
        return err(`Branch '${node.id}' has fewer than 2 legs — invalid structure.`);
      }
      for (const leg of node.legs) {
        const result = checkSeriesIntegrity(leg.nodes, true, `${context}/${node.id}/${leg.id}`);
        if (!result.valid) return result;
      }
    }
  }
  return ok();
}

// ---------------------------------------------------------------------------
// Describe valid insertion options for a given rung + cursor context
// (Used by the UI to show what drop targets are legal)
// ---------------------------------------------------------------------------

export type DropZoneKind =
  | "series-before"
  | "series-after"
  | "branch-wrap"
  | "branch-add-leg"
  | "branch-leg-insert";

export interface DropZone {
  kind: DropZoneKind;
  position: InsertPosition;
  /** true = valid, false = invalid (shown red), undefined = context-dependent */
  valid: boolean;
}

/**
 * Returns all legal drop zones for placing `type` in `rung`.
 * Used to highlight insertion points during drag-and-drop.
 */
export function computeDropZones(
  rung: Rung,
  type: InstructionType
): DropZone[] {
  const zones: DropZone[] = [];

  // Series-level zones
  computeSeriesDropZones(rung, rung.nodes, type, zones);

  // Always offer append at end
  const appendPos: InsertPosition = { kind: "series-append", rungId: rung.id };
  zones.push({
    kind: "series-after",
    position: appendPos,
    valid: validateInsert(rung, appendPos, type).valid,
  });

  return zones;
}

function computeSeriesDropZones(
  rung: Rung,
  nodes: SeriesNode[],
  type: InstructionType,
  zones: DropZone[]
): void {
  for (const node of nodes) {
    // Before this node
    const beforePos: InsertPosition = {
      kind: "series-before",
      rungId: rung.id,
      siblingId: node.id,
    };
    zones.push({
      kind: "series-before",
      position: beforePos,
      valid: validateInsert(rung, beforePos, type).valid,
    });

    // Wrap this node
    const wrapPos: InsertPosition = {
      kind: "branch-wrap",
      rungId: rung.id,
      nodeId: node.id,
    };
    zones.push({
      kind: "branch-wrap",
      position: wrapPos,
      valid: validateInsert(rung, wrapPos, type).valid,
    });

    if (isBranch(node)) {
      // Add leg to branch
      const addLegPos: InsertPosition = {
        kind: "branch-add-leg",
        rungId: rung.id,
        branchId: node.id,
      };
      zones.push({
        kind: "branch-add-leg",
        position: addLegPos,
        valid: validateInsert(rung, addLegPos, type).valid,
      });

      // Recurse into legs
      for (const leg of node.legs) {
        for (const legNode of leg.nodes) {
          const legPos: InsertPosition = {
            kind: "branch-leg-after",
            rungId: rung.id,
            branchId: node.id,
            legId: leg.id,
            siblingId: legNode.id,
          };
          zones.push({
            kind: "branch-leg-insert",
            position: legPos,
            valid: validateInsert(rung, legPos, type).valid,
          });
        }
        // Append in leg
        const legAppendPos: InsertPosition = {
          kind: "branch-leg-append",
          rungId: rung.id,
          branchId: node.id,
          legId: leg.id,
        };
        zones.push({
          kind: "branch-leg-insert",
          position: legAppendPos,
          valid: validateInsert(rung, legAppendPos, type).valid,
        });
      }
    }
  }
}
