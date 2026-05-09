import type { TagDataType } from "../model/types";

export interface DraggedTagPayload {
  name: string;
  dataType: TagDataType;
}

let draggedTag: DraggedTagPayload | null = null;

export function setDraggedTagPayload(payload: DraggedTagPayload): void {
  draggedTag = payload;
}

export function getDraggedTagPayload(): DraggedTagPayload | null {
  return draggedTag;
}

export function clearDraggedTagPayload(): void {
  draggedTag = null;
}
