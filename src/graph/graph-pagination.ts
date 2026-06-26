import { Buffer } from "node:buffer";

import type { GraphEntityProposal, GraphRelationProposal } from "./graph-types.js";

export type GraphPageCursor = string;
export type GraphPageTarget = "entity" | "relation";

export interface DecodedGraphPageCursor {
  readonly version: 1;
  readonly target: GraphPageTarget;
  readonly createdAt: string;
  readonly id: string;
}

export type GraphPageableFact = Pick<
  GraphEntityProposal | GraphRelationProposal,
  "id" | "createdAt"
>;

export function encodeGraphPageCursor(
  target: GraphPageTarget,
  fact: GraphPageableFact
): GraphPageCursor {
  return Buffer.from(
    JSON.stringify({
      version: 1,
      target,
      createdAt: fact.createdAt,
      id: fact.id
    }),
    "utf8"
  ).toString("base64url");
}

export function decodeGraphPageCursor(
  cursor: GraphPageCursor | undefined,
  expectedTarget: GraphPageTarget
): DecodedGraphPageCursor | undefined {
  if (cursor === undefined) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid graph page cursor.");
  }

  if (!isDecodedGraphPageCursor(parsed) || parsed.target !== expectedTarget) {
    throw new Error("Invalid graph page cursor.");
  }

  return parsed;
}

export function compareGraphPageFacts(first: GraphPageableFact, second: GraphPageableFact): number {
  const createdAtOrder = first.createdAt.localeCompare(second.createdAt);
  return createdAtOrder === 0 ? first.id.localeCompare(second.id) : createdAtOrder;
}

export function isGraphPageFactAfterCursor(
  fact: GraphPageableFact,
  cursor: DecodedGraphPageCursor | undefined
): boolean {
  return (
    cursor === undefined ||
    fact.createdAt > cursor.createdAt ||
    (fact.createdAt === cursor.createdAt && fact.id > cursor.id)
  );
}

function isDecodedGraphPageCursor(value: unknown): value is DecodedGraphPageCursor {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const record = value as Partial<DecodedGraphPageCursor>;
  return (
    record.version === 1 &&
    (record.target === "entity" || record.target === "relation") &&
    typeof record.createdAt === "string" &&
    record.createdAt.length > 0 &&
    typeof record.id === "string" &&
    record.id.length > 0
  );
}
