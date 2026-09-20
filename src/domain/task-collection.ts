export type TaskTreeCollectionAction = "selected" | "archived" | "restored";

export interface TaskTreeCollectionTransitionView {
  transitionId: string;
  treeId: string;
  action: TaskTreeCollectionAction;
  fromStatus: string | null;
  toStatus: string;
  previousSelectedTreeId: string | null;
  selectedTreeId: string | null;
  createdAt: string;
}

export function restoredTaskTreeStatus(archivedFromStatus: string | null | undefined): string {
  const normalized = archivedFromStatus?.trim();
  return !normalized || normalized === "archived" ? "draft" : normalized;
}
