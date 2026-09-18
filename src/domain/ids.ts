import { randomUUID } from "node:crypto";

export const newId = (): string => randomUUID();
export const nowIso = (): string => new Date().toISOString();
