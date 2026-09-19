import type { TaskTreeDocument } from "./task-tree.js";

export type ConfirmationState = "draft" | "pending_user_confirmation" | "confirmed" | "partial_confirmed";

export function resolveConfirmationScope(document: TaskTreeDocument, rootNodeId?: string): string[] | null {
  if (!rootNodeId) return document.nodes.map((node) => node.id);
  const byId = new Map(document.nodes.map((node) => [node.id, node]));
  if (!byId.has(rootNodeId)) return null;

  const included = new Set<string>();
  const visit = (nodeId: string): void => {
    if (included.has(nodeId)) return;
    const node = byId.get(nodeId);
    if (!node) return;
    included.add(nodeId);
    node.children.forEach(visit);
  };
  visit(rootNodeId);
  return document.nodes.flatMap((node) => included.has(node.id) ? [node.id] : []);
}

export function deriveConfirmationStates(
  document: TaskTreeDocument,
  confirmedNodeIds: ReadonlySet<string>,
  pendingNodeIds: ReadonlySet<string>,
): Record<string, ConfirmationState> {
  const byId = new Map(document.nodes.map((node) => [node.id, node]));
  const memo = new Map<string, boolean>();
  const visiting = new Set<string>();

  const hasConfirmedDescendant = (nodeId: string): boolean => {
    const cached = memo.get(nodeId);
    if (cached !== undefined) return cached;
    if (visiting.has(nodeId)) return false;
    visiting.add(nodeId);
    const result = (byId.get(nodeId)?.children ?? []).some((childId) =>
      confirmedNodeIds.has(childId) || hasConfirmedDescendant(childId));
    visiting.delete(nodeId);
    memo.set(nodeId, result);
    return result;
  };

  return Object.fromEntries(document.nodes.map((node) => {
    const state: ConfirmationState = pendingNodeIds.has(node.id)
      ? "pending_user_confirmation"
      : confirmedNodeIds.has(node.id)
        ? "confirmed"
        : hasConfirmedDescendant(node.id)
          ? "partial_confirmed"
          : "draft";
    return [node.id, state];
  }));
}
