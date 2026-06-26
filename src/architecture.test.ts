import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";

type Layer =
  | "shared"
  | "security"
  | "documents"
  | "parsing"
  | "profiles"
  | "corpus"
  | "sync"
  | "ingestion"
  | "chunking"
  | "indexing"
  | "embeddings"
  | "graph"
  | "query"
  | "retrieval"
  | "context"
  | "answer"
  | "model"
  | "budget"
  | "generation"
  | "observability"
  | "support-bridge"
  | "runtime"
  | "evals";

const SOURCE_ROOT = path.join(process.cwd(), "src");
const LAYERS = new Set<Layer>([
  "shared",
  "security",
  "documents",
  "parsing",
  "profiles",
  "corpus",
  "sync",
  "ingestion",
  "chunking",
  "indexing",
  "embeddings",
  "graph",
  "query",
  "retrieval",
  "context",
  "answer",
  "model",
  "budget",
  "generation",
  "observability",
  "support-bridge",
  "runtime",
  "evals"
]);

const ALLOWED_DEPENDENCIES: Record<Layer, readonly Layer[]> = {
  shared: [],
  security: ["shared"],
  documents: ["security"],
  parsing: ["documents", "shared"],
  profiles: ["documents", "shared"],
  corpus: ["documents", "parsing", "profiles", "security", "shared", "support-bridge"],
  sync: ["corpus", "profiles", "security", "shared"],
  ingestion: ["chunking", "corpus", "documents", "indexing", "profiles", "security"],
  chunking: ["documents", "shared"],
  indexing: ["chunking", "documents", "security", "shared"],
  embeddings: ["documents", "indexing", "shared"],
  graph: ["documents", "indexing", "security", "shared"],
  query: ["profiles", "shared"],
  retrieval: ["documents", "embeddings", "graph", "indexing", "shared"],
  context: ["documents", "profiles", "retrieval"],
  answer: ["context", "documents", "profiles"],
  model: ["answer", "profiles", "shared"],
  budget: ["profiles"],
  generation: ["answer", "budget", "context", "model", "profiles"],
  observability: ["documents"],
  "support-bridge": ["shared"],
  runtime: [
    "budget",
    "chunking",
    "context",
    "corpus",
    "documents",
    "generation",
    "graph",
    "indexing",
    "embeddings",
    "ingestion",
    "model",
    "observability",
    "parsing",
    "profiles",
    "query",
    "retrieval",
    "security",
    "shared",
    "support-bridge",
    "sync"
  ],
  evals: [
    "context",
    "corpus",
    "documents",
    "graph",
    "indexing",
    "ingestion",
    "model",
    "observability",
    "profiles",
    "retrieval",
    "runtime",
    "security",
    "support-bridge"
  ]
};

test("production source layers follow the acyclic architecture DAG", () => {
  const violations: string[] = [];
  const layerEdges = new Map<Layer, Set<Layer>>();

  for (const file of productionSourceFiles(SOURCE_ROOT)) {
    const fromLayer = layerForFile(file);
    if (!fromLayer) {
      continue;
    }

    for (const importPath of importSpecifiers(file)) {
      const target = resolveSourceImport(file, importPath);
      if (!target) {
        continue;
      }

      const toLayer = layerForFile(target);
      if (!toLayer || toLayer === fromLayer) {
        continue;
      }

      addEdge(layerEdges, fromLayer, toLayer);
      if (!ALLOWED_DEPENDENCIES[fromLayer].includes(toLayer)) {
        violations.push(
          `${relative(file)} imports ${relative(target)}; ${fromLayer} cannot depend on ${toLayer}`
        );
      }
    }
  }

  const cycles = findCycles(layerEdges);
  assert.deepEqual([...violations, ...cycles], []);
});

test("public barrel keeps raw corpus normalization internal", () => {
  const publicExports = readFileSync(path.join(SOURCE_ROOT, "index.ts"), "utf8");

  assert.equal(publicExports.includes("normalizeCorpusRecord"), false);
  assert.equal(publicExports.includes("normalizeCorpusRecords"), false);
});

function productionSourceFiles(directory: string): readonly string[] {
  const files: string[] = [];

  for (const entry of readdirSync(directory)) {
    const fullPath = path.join(directory, entry);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      if (entry === "test-support") {
        continue;
      }
      files.push(...productionSourceFiles(fullPath));
      continue;
    }

    if (entry.endsWith(".ts") && !entry.endsWith(".test.ts") && entry !== "index.ts") {
      files.push(fullPath);
    }
  }

  return files;
}

function importSpecifiers(file: string): readonly string[] {
  const source = readFileSync(file, "utf8");
  const imports: string[] = [];
  const importPattern =
    /import\s+(?:type\s+)?(?:[^"']+\s+from\s+)?["']([^"']+)["']|export\s+(?:type\s+)?(?:[^"']+\s+from\s+)["']([^"']+)["']/g;
  let match: RegExpExecArray | null;

  while ((match = importPattern.exec(source)) !== null) {
    const specifier = match[1] ?? match[2];
    if (specifier?.startsWith(".")) {
      imports.push(specifier);
    }
  }

  return imports;
}

function resolveSourceImport(fromFile: string, importPath: string): string | undefined {
  const resolved = path.resolve(path.dirname(fromFile), importPath.replace(/\.js$/, ".ts"));
  const candidates = [resolved, `${resolved}.ts`, path.join(resolved, "index.ts")];

  return candidates.find((candidate) => {
    try {
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}

function layerForFile(file: string): Layer | undefined {
  const relativePath = path.relative(SOURCE_ROOT, file);
  const [layer] = relativePath.split(path.sep);
  return layer && LAYERS.has(layer as Layer) ? (layer as Layer) : undefined;
}

function addEdge(edges: Map<Layer, Set<Layer>>, from: Layer, to: Layer): void {
  const existing = edges.get(from) ?? new Set<Layer>();
  existing.add(to);
  edges.set(from, existing);
}

function findCycles(edges: Map<Layer, Set<Layer>>): readonly string[] {
  const cycles: string[] = [];
  const visiting = new Set<Layer>();
  const visited = new Set<Layer>();

  for (const layer of LAYERS) {
    visit(layer, [], edges, visiting, visited, cycles);
  }

  return cycles;
}

function visit(
  layer: Layer,
  stack: readonly Layer[],
  edges: Map<Layer, Set<Layer>>,
  visiting: Set<Layer>,
  visited: Set<Layer>,
  cycles: string[]
): void {
  if (visiting.has(layer)) {
    cycles.push(`cycle: ${[...stack, layer].join(" -> ")}`);
    return;
  }

  if (visited.has(layer)) {
    return;
  }

  visiting.add(layer);
  for (const next of edges.get(layer) ?? []) {
    visit(next, [...stack, layer], edges, visiting, visited, cycles);
  }
  visiting.delete(layer);
  visited.add(layer);
}

function relative(file: string): string {
  return path.relative(process.cwd(), file);
}
