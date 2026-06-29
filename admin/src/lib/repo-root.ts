import "server-only";

import { existsSync } from "node:fs";
import path from "node:path";

export function resolveRagRepoRoot(): string {
  const configured = process.env.RAG_ADMIN_REPO_ROOT?.trim();
  if (configured) {
    return path.resolve(/*turbopackIgnore: true*/ configured);
  }

  const cwd = path.resolve(/*turbopackIgnore: true*/ process.cwd());
  if (looksLikeRagRepoRoot(cwd)) return cwd;

  const parent = path.resolve(/*turbopackIgnore: true*/ cwd, "..");
  if (looksLikeRagRepoRoot(parent)) return parent;

  return cwd;
}

function looksLikeRagRepoRoot(candidate: string): boolean {
  return (
    existsSync(/*turbopackIgnore: true*/ path.join(candidate, "src", "runtime")) &&
    existsSync(/*turbopackIgnore: true*/ path.join(candidate, "admin", "package.json"))
  );
}
