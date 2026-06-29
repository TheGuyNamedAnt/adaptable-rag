#!/usr/bin/env node

const MIN_MAJOR = 24;
const MAX_MAJOR_EXCLUSIVE = 27;
const current = process.versions.node;
const major = Number(current.split(".")[0]);
const allowed = Number.isInteger(major) && major >= MIN_MAJOR && major < MAX_MAJOR_EXCLUSIVE;

if (allowed) {
  process.exit(0);
}

const message = `adaptable-rag requires Node >=${MIN_MAJOR} <${MAX_MAJOR_EXCLUSIVE}; current runtime is Node ${current}.`;
if (process.env.RAG_ALLOW_UNSUPPORTED_NODE === "1") {
  console.warn(`${message} Continuing because RAG_ALLOW_UNSUPPORTED_NODE=1.`);
  process.exit(0);
}

console.error(message);
console.error("Use the repo .nvmrc runtime before running build, test, CI, or admin commands.");
process.exit(1);
