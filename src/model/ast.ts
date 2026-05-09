// =============================================================================
// AST Utilities — traversal, lookup, deep-clone, path resolution
// =============================================================================

import type {
  Rung,
  Routine,
  SeriesNode,
  InstructionNode,
  BranchNode,
  BranchLeg,
  InsertPosition,
  DeleteTarget,
} from "./types";

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

let _counter = 0;
export function genId(prefix = "n"): string {
  return `${prefix}_${Date.now()}_${++_counter}`;
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

export function isInstruction(node: SeriesNode): node is InstructionNode {
  return node.kind === "instruction";
}

export function isBranch(node: SeriesNode): node is BranchNode {
  return node.kind === "branch";
}

// ---------------------------------------------------------------------------
// Deep clone — keeps ids intact (caller remaps if needed)
// ---------------------------------------------------------------------------

export function cloneNode(node: SeriesNode): SeriesNode {
  if (isInstruction(node)) return { ...node, params: { ...node.params } };
  return {
    ...node,
    legs: node.legs.map((leg) => ({
      ...leg,
      nodes: leg.nodes.map(cloneNode),
    })),
  };
}

export function cloneRung(rung: Rung): Rung {
  return {
    ...rung,
    nodes: rung.nodes.map(cloneNode),
  };
}

/**
 * Deep-clone a SeriesNode, assigning fresh IDs to every node, branch, and leg.
 * Used when moving a node so the source and destination never share IDs.
 */
export function cloneNodeWithNewIds(node: SeriesNode): SeriesNode {
  if (isInstruction(node)) {
    return { ...node, id: genId("inst"), params: { ...node.params } };
  }
  return {
    kind: "branch",
    id: genId("br"),
    legs: node.legs.map((leg) => ({
      id: genId("leg"),
      nodes: leg.nodes.map(cloneNodeWithNewIds),
    })),
  };
}

// ---------------------------------------------------------------------------
// Node lookup by id — returns a reference (for reading, NOT mutation)
// ---------------------------------------------------------------------------

export function findNodeInSeries(
  nodes: SeriesNode[],
  id: string
): SeriesNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    if (isBranch(node)) {
      for (const leg of node.legs) {
        const found = findNodeInSeries(leg.nodes, id);
        if (found) return found;
      }
    }
  }
  return undefined;
}

export function findNodeInRung(rung: Rung, id: string): SeriesNode | undefined {
  return findNodeInSeries(rung.nodes, id);
}

export function findBranchInRung(
  rung: Rung,
  branchId: string
): BranchNode | undefined {
  const node = findNodeInRung(rung, branchId);
  return node && isBranch(node) ? node : undefined;
}

export function findLegInBranch(
  branch: BranchNode,
  legId: string
): BranchLeg | undefined {
  return branch.legs.find((l) => l.id === legId);
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Returns the parent series list that directly contains the node with `nodeId`,
 * plus the index of that node.
 * Returns undefined if not found.
 */
export interface NodeLocation {
  /** The array that contains the node */
  list: SeriesNode[];
  index: number;
  /** If the node is inside a branch leg, provides the containing context */
  branchId?: string;
  legId?: string;
}

export function locateNode(
  nodes: SeriesNode[],
  nodeId: string,
  branchId?: string,
  legId?: string
): NodeLocation | undefined {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.id === nodeId) {
      return { list: nodes, index: i, branchId, legId };
    }
    if (isBranch(node)) {
      for (const leg of node.legs) {
        const result = locateNode(leg.nodes, nodeId, node.id, leg.id);
        if (result) return result;
      }
    }
  }
  return undefined;
}

export function locateNodeInRung(rung: Rung, nodeId: string): NodeLocation | undefined {
  return locateNode(rung.nodes, nodeId);
}

// ---------------------------------------------------------------------------
// Immutable helpers — return NEW arrays/rungs; never mutate in place
// ---------------------------------------------------------------------------

/** Insert `newNode` before the node at `index` in `list` */
export function insertBefore(
  list: SeriesNode[],
  index: number,
  newNode: SeriesNode
): SeriesNode[] {
  const next = [...list];
  next.splice(index, 0, newNode);
  return next;
}

/** Insert `newNode` after the node at `index` in `list` */
export function insertAfter(
  list: SeriesNode[],
  index: number,
  newNode: SeriesNode
): SeriesNode[] {
  const next = [...list];
  next.splice(index + 1, 0, newNode);
  return next;
}

/** Remove node at `index` from `list` */
export function removeAt(list: SeriesNode[], index: number): SeriesNode[] {
  const next = [...list];
  next.splice(index, 1);
  return next;
}

/**
 * Apply a transform to the series list that directly contains `nodeId`.
 * Walks the tree immutably, returns a new nodes array.
 */
export function transformList(
  nodes: SeriesNode[],
  nodeId: string,
  transform: (list: SeriesNode[], index: number) => SeriesNode[]
): SeriesNode[] | undefined {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.id === nodeId) {
      return transform(nodes, i);
    }
    if (isBranch(node)) {
      let changed = false;
      const newLegs = node.legs.map((leg) => {
        const result = transformList(leg.nodes, nodeId, transform);
        if (result !== undefined) {
          changed = true;
          return { ...leg, nodes: result };
        }
        return leg;
      });
      if (changed) {
        const newNode: BranchNode = { ...node, legs: newLegs };
        const next = [...nodes];
        next[i] = newNode;
        return next;
      }
    }
  }
  return undefined;
}

/**
 * Apply a transform to the list at the end of a specific branch leg.
 * Used for operations targeting a specific leg (append, etc.)
 */
export function transformLegList(
  nodes: SeriesNode[],
  branchId: string,
  legId: string,
  transform: (list: SeriesNode[]) => SeriesNode[]
): SeriesNode[] | undefined {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (isBranch(node)) {
      if (node.id === branchId) {
        const newLegs = node.legs.map((leg) => {
          if (leg.id === legId) {
            return { ...leg, nodes: transform(leg.nodes) };
          }
          return leg;
        });
        const newNode: BranchNode = { ...node, legs: newLegs };
        const next = [...nodes];
        next[i] = newNode;
        return next;
      }
      // Recurse into sub-branches
      let changed = false;
      const newLegs = node.legs.map((leg) => {
        const result = transformLegList(leg.nodes, branchId, legId, transform);
        if (result !== undefined) {
          changed = true;
          return { ...leg, nodes: result };
        }
        return leg;
      });
      if (changed) {
        const newNode: BranchNode = { ...node, legs: newLegs };
        const next = [...nodes];
        next[i] = newNode;
        return next;
      }
    }
  }
  return undefined;
}

/**
 * Apply a transform to a specific BranchNode (by id).
 * Used to add/remove legs.
 */
export function transformBranch(
  nodes: SeriesNode[],
  branchId: string,
  transform: (branch: BranchNode) => BranchNode
): SeriesNode[] | undefined {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (isBranch(node)) {
      if (node.id === branchId) {
        const next = [...nodes];
        next[i] = transform(node);
        return next;
      }
      let changed = false;
      const newLegs = node.legs.map((leg) => {
        const result = transformBranch(leg.nodes, branchId, transform);
        if (result !== undefined) {
          changed = true;
          return { ...leg, nodes: result };
        }
        return leg;
      });
      if (changed) {
        const newNode: BranchNode = { ...node, legs: newLegs };
        const next = [...nodes];
        next[i] = newNode;
        return next;
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Apply InsertPosition to a rung (returns new rung or throws)
// ---------------------------------------------------------------------------

export function applyInsert(
  rung: Rung,
  position: InsertPosition,
  newNode: SeriesNode
): Rung {
  switch (position.kind) {
    case "series-append": {
      return { ...rung, nodes: [...rung.nodes, newNode] };
    }
    case "series-prepend": {
      return { ...rung, nodes: [newNode, ...rung.nodes] };
    }
    case "series-before": {
      const result = transformList(rung.nodes, position.siblingId, (list, i) =>
        insertBefore(list, i, newNode)
      );
      if (!result) throw new Error(`Node ${position.siblingId} not found in rung`);
      return { ...rung, nodes: result };
    }
    case "series-after": {
      const result = transformList(rung.nodes, position.siblingId, (list, i) =>
        insertAfter(list, i, newNode)
      );
      if (!result) throw new Error(`Node ${position.siblingId} not found in rung`);
      return { ...rung, nodes: result };
    }
    case "branch-leg-before": {
      const result = transformLegList(
        rung.nodes,
        position.branchId,
        position.legId,
        (list) => {
          const idx = list.findIndex((n) => n.id === position.siblingId);
          if (idx === -1) throw new Error(`Sibling ${position.siblingId} not found`);
          return insertBefore(list, idx, newNode);
        }
      );
      if (!result) throw new Error(`Branch/leg not found`);
      return { ...rung, nodes: result };
    }
    case "branch-leg-after": {
      const result = transformLegList(
        rung.nodes,
        position.branchId,
        position.legId,
        (list) => {
          const idx = list.findIndex((n) => n.id === position.siblingId);
          if (idx === -1) throw new Error(`Sibling ${position.siblingId} not found`);
          return insertAfter(list, idx, newNode);
        }
      );
      if (!result) throw new Error(`Branch/leg not found`);
      return { ...rung, nodes: result };
    }
    case "branch-leg-append": {
      const result = transformLegList(
        rung.nodes,
        position.branchId,
        position.legId,
        (list) => [...list, newNode]
      );
      if (!result) throw new Error(`Branch/leg not found`);
      return { ...rung, nodes: result };
    }
    case "branch-wrap": {
      // Wrap the target node in a new 2-leg branch: leg0 = [target], leg1 = [newNode]
      const result = transformList(rung.nodes, position.nodeId, (list, i) => {
        const targetNode = list[i];
        const branch: BranchNode = {
          kind: "branch",
          id: genId("br"),
          legs: [
            { id: genId("leg"), nodes: [targetNode] },
            { id: genId("leg"), nodes: [newNode] },
          ],
        };
        const next = [...list];
        next[i] = branch;
        return next;
      });
      if (!result) throw new Error(`Node ${position.nodeId} not found`);
      return { ...rung, nodes: result };
    }
    case "branch-add-leg": {
      const result = transformBranch(rung.nodes, position.branchId, (branch) => {
        const newLeg: BranchLeg = { id: genId("leg"), nodes: [] };
        if (!position.afterLegId) {
          return { ...branch, legs: [...branch.legs, newLeg] };
        }
        const idx = branch.legs.findIndex((l) => l.id === position.afterLegId);
        const newLegs = [...branch.legs];
        newLegs.splice(idx + 1, 0, newLeg);
        return { ...branch, legs: newLegs };
      });
      if (!result) throw new Error(`Branch ${position.branchId} not found`);
      return { ...rung, nodes: result };
    }
    default:
      throw new Error(`Unhandled insert position kind: ${(position as InsertPosition).kind}`);
  }
}

// ---------------------------------------------------------------------------
// Apply DeleteTarget to a rung (returns new rung or throws)
// ---------------------------------------------------------------------------

export function applyDelete(rung: Rung, target: DeleteTarget): Rung {
  switch (target.kind) {
    case "node": {
      const result = transformList(rung.nodes, target.nodeId, (list, i) =>
        removeAt(list, i)
      );
      if (!result) throw new Error(`Node ${target.nodeId} not found`);
      // After deletion, collapse any branches with only 1 leg left
      return { ...rung, nodes: collapseSingleLegBranches(result) };
    }
    case "leg": {
      const result = transformBranch(rung.nodes, target.branchId, (branch) => {
        const newLegs = branch.legs.filter((l) => l.id !== target.legId);
        return { ...branch, legs: newLegs };
      });
      if (!result) throw new Error(`Branch ${target.branchId} not found`);
      return { ...rung, nodes: collapseSingleLegBranches(result) };
    }
    case "rung": {
      // Handled at the routine level, not here
      throw new Error("Use routine-level delete for rungs");
    }
  }
}

/**
 * After a leg deletion, any branch that is left with exactly one leg
 * gets "unwrapped" — its single leg's nodes are spliced into the parent list.
 */
function collapseSingleLegBranches(nodes: SeriesNode[]): SeriesNode[] {
  const result: SeriesNode[] = [];
  for (const node of nodes) {
    if (isBranch(node)) {
      const cleanedLegs = node.legs.map((leg) => ({
        ...leg,
        nodes: collapseSingleLegBranches(leg.nodes),
      }));
      if (cleanedLegs.length <= 1) {
        // Unwrap: splice the single leg's nodes in place
        result.push(...(cleanedLegs[0]?.nodes ?? []));
      } else {
        result.push({ ...node, legs: cleanedLegs });
      }
    } else {
      result.push(node);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Counting helpers
// ---------------------------------------------------------------------------

/** Total depth of nesting (0 = flat rung, 1 = one branch level, etc.) */
export function maxBranchDepth(nodes: SeriesNode[], current = 0): number {
  let max = current;
  for (const node of nodes) {
    if (isBranch(node)) {
      for (const leg of node.legs) {
        const d = maxBranchDepth(leg.nodes, current + 1);
        if (d > max) max = d;
      }
    }
  }
  return max;
}

/** Count all instruction nodes in a subtree */
export function countInstructions(nodes: SeriesNode[]): number {
  let n = 0;
  for (const node of nodes) {
    if (isInstruction(node)) n++;
    else {
      for (const leg of node.legs) n += countInstructions(leg.nodes);
    }
  }
  return n;
}

/** Collect all node IDs in a subtree */
export function collectIds(nodes: SeriesNode[]): string[] {
  const ids: string[] = [];
  for (const node of nodes) {
    ids.push(node.id);
    if (isBranch(node)) {
      for (const leg of node.legs) {
        ids.push(leg.id);
        ids.push(...collectIds(leg.nodes));
      }
    }
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Branch helpers
// ---------------------------------------------------------------------------

/**
 * Wrap the node with `nodeId` in a new 2-leg branch.
 * Leg 0 gets the original node; Leg 1 starts empty.
 * Returns a new nodes array, or null if nodeId was not found.
 */
export function wrapInEmptyBranch(
  nodes: SeriesNode[],
  nodeId: string
): SeriesNode[] | null {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.id === nodeId) {
      const branch: BranchNode = {
        kind: "branch",
        id: genId("br"),
        legs: [
          { id: genId("leg"), nodes: [node] },
          { id: genId("leg"), nodes: [] },
        ],
      };
      const next = [...nodes];
      next[i] = branch;
      return next;
    }
    if (isBranch(node)) {
      for (let j = 0; j < node.legs.length; j++) {
        const newLegNodes = wrapInEmptyBranch(node.legs[j].nodes, nodeId);
        if (newLegNodes !== null) {
          const newLegs = [...node.legs];
          newLegs[j] = { ...node.legs[j], nodes: newLegNodes };
          const next = [...nodes];
          next[i] = { ...node, legs: newLegs } as BranchNode;
          return next;
        }
      }
    }
  }
  return null;
}

/**
 * Find which branch (if any) directly contains the node with `nodeId`.
 * Returns { branchId, legId } or null.
 */
export function findContainingBranch(
  nodes: SeriesNode[],
  nodeId: string
): { branchId: string; legId: string } | null {
  for (const node of nodes) {
    if (!isBranch(node)) continue;
    for (const leg of node.legs) {
      if (leg.nodes.some(n => n.id === nodeId)) {
        return { branchId: node.id, legId: leg.id };
      }
      const deeper = findContainingBranch(leg.nodes, nodeId);
      if (deeper) return deeper;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Routine helpers
// ---------------------------------------------------------------------------

export function findRung(routine: Routine, rungId: string): Rung | undefined {
  return routine.rungs.find((r) => r.id === rungId);
}

export function updateRung(routine: Routine, updated: Rung): Routine {
  return {
    ...routine,
    rungs: routine.rungs.map((r) => (r.id === updated.id ? updated : r)),
  };
}

export function deleteRung(routine: Routine, rungId: string): Routine {
  return {
    ...routine,
    rungs: routine.rungs.filter((r) => r.id !== rungId),
  };
}
