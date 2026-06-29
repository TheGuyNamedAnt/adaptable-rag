#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const args = parseArgs(process.argv.slice(2));
const snapshotPath = requiredArg(args, "snapshot");
const keepHashes = requiredArg(args, "keep-config-hashes")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const outputPath = args.output ?? path.join(".rag", "vector-cleanup", "plan.json");
const cleanedSnapshotPath = args["cleaned-snapshot"];
const apply = args.apply === "true" || args.apply === "1";

if (keepHashes.length === 0) {
  throw new Error("--keep-config-hashes must include at least one hash.");
}

const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
const vectors = snapshotVectors(snapshot);
const inventory = inventoryFor(vectors);
const deleteIds = new Set(
  vectors
    .filter((vector) => {
      if (args["tenant-id"] && vector.tenantId !== args["tenant-id"]) return false;
      if (args["namespace-id"] && vector.namespaceId !== args["namespace-id"]) return false;
      return !keepHashes.includes(vector.embeddingConfigHash ?? "unknown");
    })
    .map((vector) => vector.id)
);
const plan = {
  mode: apply ? "apply" : "dry_run",
  snapshotPath,
  keepEmbeddingConfigHashes: keepHashes,
  tenantId: args["tenant-id"],
  namespaceId: args["namespace-id"],
  inventory,
  deleteVectorIds: [...deleteIds].sort(),
  deleteCount: deleteIds.size,
  keepCount: vectors.length - deleteIds.size
};

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");

if (apply) {
  if (!cleanedSnapshotPath) {
    throw new Error("--apply requires --cleaned-snapshot.");
  }
  const cleaned = {
    ...snapshot,
    vectors: snapshot.vectors.filter((entry) => !deleteIds.has(snapshotVector(entry).id))
  };
  await mkdir(path.dirname(cleanedSnapshotPath), { recursive: true });
  await writeFile(cleanedSnapshotPath, `${JSON.stringify(cleaned, null, 2)}\n`, "utf8");
}

console.log(
  `Vector generation cleanup ${plan.mode}: delete=${plan.deleteCount} keep=${plan.keepCount} plan=${outputPath}`
);

function snapshotVectors(snapshot) {
  if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.vectors)) {
    throw new Error("Snapshot must be a vector snapshot with version 1.");
  }
  return snapshot.vectors.map(snapshotVector);
}

function snapshotVector(entry) {
  const vector = entry?.vector ?? entry?.visualVector;
  if (!vector || typeof vector.id !== "string") {
    throw new Error("Snapshot entry is missing vector or visualVector payload.");
  }
  return vector;
}

function inventoryFor(vectors) {
  const grouped = new Map();
  for (const vector of vectors) {
    const key = JSON.stringify({
      tenantId: vector.tenantId,
      namespaceId: vector.namespaceId,
      embeddingProvider: vector.embeddingProvider ?? "unknown",
      embeddingModel: vector.embeddingModel,
      embeddingConfigHash: vector.embeddingConfigHash ?? "unknown",
      embeddingIndexConfigHash: stringMetadata(vector.metadata, "embeddingIndexConfigHash")
    });
    const current = grouped.get(key) ?? { count: 0, documents: new Set() };
    current.count += 1;
    current.documents.add(vector.documentId);
    grouped.set(key, current);
  }

  return [...grouped.entries()].map(([key, value]) => ({
    ...JSON.parse(key),
    vectorCount: value.count,
    documentCount: value.documents.size
  }));
}

function stringMetadata(metadata, key) {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function parseArgs(rawArgs) {
  const parsed = {};
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (!arg?.startsWith("--")) continue;
    const name = arg.slice(2);
    const next = rawArgs[index + 1];
    if (next === undefined || next.startsWith("--")) {
      parsed[name] = "true";
    } else {
      parsed[name] = next;
      index += 1;
    }
  }
  return parsed;
}

function requiredArg(args, name) {
  const value = args[name];
  if (!value) {
    throw new Error(`Missing --${name}.`);
  }
  return value;
}
