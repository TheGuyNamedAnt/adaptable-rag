#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { JsonFileRagIndex, KeywordRetriever, validateGraphExtractionBatch } from "../dist/index.js";

const DEFAULT_CORPUS_DIR = path.join(".rag", "sec-company-corpus");
const DEFAULT_REPORT_DIR = path.join(DEFAULT_CORPUS_DIR, "deep-eval", "latest");
const DEFAULT_NAMESPACE_ID = "generic-docs";
const DEFAULT_TENANT_ID = "tenant_1";
const DEFAULT_USER_ID = "sec_deep_eval";
const DEFAULT_TOP_K = 20;
const FIXED_CREATED_AT = "2026-06-25T00:00:00.000Z";

const INDEX_SPECS = [
  {
    id: "raw-smoke",
    fileName: "smoke-index.json",
    description: "Raw local-file smoke index."
  },
  {
    id: "sec-html-smoke",
    fileName: "sec-html-smoke-index.json",
    description: "SEC HTML parser index for Exhibit 21 and material-contract HTML."
  },
  {
    id: "sec-html-large-doc",
    fileName: "sec-html-large-doc-index.json",
    description: "SEC HTML parser index for full annual-report HTML."
  },
  {
    id: "full-mixed",
    fileName: "full-mixed-index.json",
    description: "Mixed-format full-corpus index."
  },
  {
    id: "large-doc",
    fileName: "large-doc-index.json",
    description: "Large-document stress index."
  }
];

const SUBSIDIARY_EXHIBITS = [
  {
    companyId: "alphabet-2024",
    parentName: "Alphabet Inc.",
    sourcePath: "alphabet-2024/googexhibit2101q42024.htm",
    expectedRows: [
      ["Google LLC", "Delaware"],
      ["XXVI Holdings Inc.", "Delaware"],
      ["Alphabet Capital US LLC", "Delaware"]
    ],
    minimumRows: 3
  },
  {
    companyId: "berkshire-2024",
    parentName: "Berkshire Hathaway Inc.",
    sourcePath: "berkshire-2024/brka-ex21.htm",
    expectedRows: [
      ["Berkshire Hathaway Homestate Insurance Company", "Nebraska"],
      ["Berkshire Hathaway Life Insurance Company of Nebraska", "Nebraska"],
      ["GEICO Casualty Company", "Nebraska"],
      ["GEICO Corporation", "Delaware"],
      ["GEICO General Insurance Company", "Nebraska"]
    ],
    minimumRows: 250,
    expectedGeicoRows: 11,
    expectedNebraskaRowsAtLeast: 20
  },
  {
    companyId: "microsoft-2025",
    parentName: "Microsoft Corporation",
    sourcePath: "microsoft-2025/msft-ex21.htm",
    expectedRows: [
      ["Microsoft Ireland Operations Limited", "Ireland"],
      ["LinkedIn Corporation", "United States"],
      ["Activision Blizzard, Inc.", "United States"]
    ],
    minimumRows: 8
  }
];

const MICROSOFT_OPENAI_PHRASES = [
  "Microsoft and OpenAI maintain a long-term strategic partnership originally established in 2019",
  "Microsoft is a major investor in OpenAI",
  "reciprocal revenue-sharing arrangements",
  "rights to OpenAI's intellectual property",
  "OpenAI API is exclusive to Azure"
];

const options = parseArgs(process.argv.slice(2));
const checks = [];

try {
  const manifestPath = path.join(options.corpusDir, "manifest.json");
  const seedPath = path.join(options.corpusDir, "ground-truth.seed.json");
  const manifest = await readJson(manifestPath);
  const seedQuestions = await readJson(seedPath);

  await validateManifestFiles(manifest);
  await validateSourceConfigs();
  await validateSeedQuestions(seedQuestions);

  const subsidiaryMaps = await validateSubsidiaryExhibits();
  const loadedIndexes = await validateIndexes();
  await validateRetrievalEvidence(seedQuestions, loadedIndexes);
  await validateAccessDenial(loadedIndexes);

  const derivedGraph = buildDerivedSubsidiaryGraph(subsidiaryMaps, loadedIndexes);
  await validateDerivedGraph(derivedGraph);
  await validateMicrosoftOpenAiRelationship();
  await validateUnsupportedOwnershipPercentages(subsidiaryMaps);

  const report = buildReport({
    manifest,
    seedQuestions,
    subsidiaryMaps,
    loadedIndexes,
    derivedGraph
  });

  await mkdir(options.reportDir, { recursive: true });
  await writeJson(path.join(options.reportDir, "deep-eval.json"), report);
  await writeJson(path.join(options.reportDir, "derived-subsidiary-map.json"), {
    generatedAt: report.generatedAt,
    sources: subsidiaryMaps.map((entry) => ({
      companyId: entry.companyId,
      parentName: entry.parentName,
      sourcePath: entry.sourcePath,
      rows: entry.rows
    })),
    graph: derivedGraph.summary
  });
  await writeFile(path.join(options.reportDir, "deep-eval.md"), renderMarkdown(report), "utf8");

  console.log(JSON.stringify(report.summary, null, 2));
  if (report.summary.failed > 0) {
    process.exitCode = 1;
  }
} catch (error) {
  console.error(
    JSON.stringify(
      {
        status: "failed",
        message: error instanceof Error ? error.message : "SEC deep eval failed."
      },
      null,
      2
    )
  );
  process.exitCode = 1;
}

async function validateManifestFiles(manifest) {
  if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.downloads)) {
    addCheck("failed", "manifest", "manifest_shape", "manifest.json must be version 1.");
    return;
  }

  addCheck("passed", "manifest", "manifest_shape", "manifest.json is readable.");

  const missing = [];
  const sizeMismatches = [];
  const byKind = {};

  for (const download of manifest.downloads) {
    byKind[download.kind] = (byKind[download.kind] ?? 0) + 1;
    const filePath = path.join(options.corpusDir, download.relativePath);
    try {
      const info = await stat(filePath);
      if (typeof download.bytes === "number" && info.size !== download.bytes) {
        sizeMismatches.push({
          path: download.relativePath,
          expected: download.bytes,
          actual: info.size
        });
      }
    } catch {
      missing.push(download.relativePath);
    }
  }

  addCheck(
    missing.length === 0 ? "passed" : "failed",
    "manifest",
    "manifest_files_exist",
    missing.length === 0
      ? `All ${manifest.downloads.length} manifest downloads exist locally.`
      : `${missing.length} manifest downloads are missing.`,
    { missing }
  );
  addCheck(
    sizeMismatches.length === 0 ? "passed" : "failed",
    "manifest",
    "manifest_byte_sizes",
    sizeMismatches.length === 0
      ? "All manifest byte sizes match the local files."
      : `${sizeMismatches.length} manifest byte size mismatch(es).`,
    { sizeMismatches }
  );
  addCheck("passed", "manifest", "manifest_kind_coverage", "Manifest file-kind coverage counted.", {
    byKind
  });
}

async function validateSourceConfigs() {
  const entries = await readdir(options.corpusDir);
  const configFiles = entries.filter(
    (entry) => entry.startsWith("local-files.") && entry.endsWith(".sources.json")
  );

  addCheck(
    configFiles.length > 0 ? "passed" : "failed",
    "source_config",
    "source_config_files_present",
    `${configFiles.length} source config file(s) found.`,
    { configFiles: configFiles.sort() }
  );

  for (const fileName of configFiles.sort()) {
    const configPath = path.join(options.corpusDir, fileName);
    const parsed = await readJson(configPath);
    const sources = Array.isArray(parsed) ? parsed : parsed.sources;
    if (!Array.isArray(sources) || sources.length === 0) {
      addCheck(
        "failed",
        "source_config",
        `${fileName}:shape`,
        "Source config must contain at least one source."
      );
      continue;
    }

    let fileCount = 0;
    const failures = [];
    for (const source of sources) {
      const rootDir =
        typeof source.rootDir === "string" && path.isAbsolute(source.rootDir)
          ? source.rootDir
          : path.resolve(path.dirname(configPath), source.rootDir ?? ".");
      const includeExtensions = new Set(source.includeExtensions ?? []);

      if (!source.accessScope?.tenantId || !source.accessScope?.namespaceId) {
        failures.push({
          sourceId: source.sourceId,
          reason: "missing accessScope tenant/namespace"
        });
      }
      if (!Array.isArray(source.accessScope?.roles) || source.accessScope.roles.length === 0) {
        failures.push({ sourceId: source.sourceId, reason: "missing accessScope roles" });
      }
      if (!Array.isArray(source.accessScope?.tags) || source.accessScope.tags.length === 0) {
        failures.push({ sourceId: source.sourceId, reason: "missing accessScope tags" });
      }

      for (const file of source.files ?? []) {
        fileCount += 1;
        const filePath = path.resolve(rootDir, file);
        const extension = path.extname(file).toLowerCase();
        try {
          const info = await stat(filePath);
          if (includeExtensions.size > 0 && !includeExtensions.has(extension)) {
            failures.push({ sourceId: source.sourceId, file, reason: "extension not included" });
          }
          if (typeof source.maxFileBytes === "number" && info.size > source.maxFileBytes) {
            failures.push({
              sourceId: source.sourceId,
              file,
              reason: "file exceeds maxFileBytes",
              maxFileBytes: source.maxFileBytes,
              actualBytes: info.size
            });
          }
        } catch {
          failures.push({ sourceId: source.sourceId, file, reason: "file missing" });
        }
      }
    }

    addCheck(
      failures.length === 0 ? "passed" : "failed",
      "source_config",
      `${fileName}:files`,
      failures.length === 0
        ? `${fileName} references ${fileCount} valid file(s).`
        : `${fileName} has ${failures.length} config/file issue(s).`,
      { fileCount, failures }
    );
  }
}

async function validateSeedQuestions(seedQuestions) {
  if (!Array.isArray(seedQuestions) || seedQuestions.length === 0) {
    addCheck("failed", "seed", "seed_shape", "ground-truth.seed.json must be a non-empty array.");
    return;
  }

  addCheck("passed", "seed", "seed_shape", `${seedQuestions.length} seed question(s) loaded.`);

  for (const question of seedQuestions) {
    const expectedSources = question.expectedSources ?? [];
    if (expectedSources.length === 0) {
      addCheck(
        "passed",
        "seed",
        `${question.id}:no_expected_source`,
        "Seed case intentionally has no expected source.",
        { expectedBehavior: question.expectedBehavior }
      );
      continue;
    }

    const sourceFailures = [];
    const answerFailures = [];
    for (const source of expectedSources) {
      const fileText = await readSourceTextIfExists(source);
      if (fileText === undefined) {
        sourceFailures.push(source);
        continue;
      }

      for (const expected of question.expectedAnswerContains ?? []) {
        if (!includesNormalized(fileText, expected)) {
          answerFailures.push({ source, expected });
        }
      }
    }

    addCheck(
      sourceFailures.length === 0 ? "passed" : "failed",
      "seed",
      `${question.id}:sources_exist`,
      sourceFailures.length === 0
        ? "Expected source file(s) exist."
        : "One or more expected source file(s) are missing.",
      { missing: sourceFailures }
    );
    if ((question.expectedAnswerContains ?? []).length > 0) {
      addCheck(
        answerFailures.length === 0 ? "passed" : "failed",
        "seed",
        `${question.id}:expected_strings_in_source`,
        answerFailures.length === 0
          ? "Expected answer strings are present in the expected source file(s)."
          : "Expected answer strings were not found in expected source file(s).",
        { missing: answerFailures }
      );
    }
  }
}

async function validateSubsidiaryExhibits() {
  const maps = [];

  for (const exhibit of SUBSIDIARY_EXHIBITS) {
    const html = await readFile(path.join(options.corpusDir, exhibit.sourcePath), "utf8");
    const rows = extractSubsidiaryRows(html);
    const rowKeys = new Set(rows.map((row) => rowKey(row.name, row.jurisdiction)));
    const missingExpectedRows = exhibit.expectedRows.filter(
      ([name, jurisdiction]) => !rowKeys.has(rowKey(name, jurisdiction))
    );
    const geicoRows = rows.filter((row) => /\bGEICO\b/i.test(row.name));
    const nebraskaRows = rows.filter((row) => row.jurisdiction === "Nebraska");

    addCheck(
      rows.length >= exhibit.minimumRows ? "passed" : "failed",
      "entity_mapping",
      `${exhibit.companyId}:row_count`,
      `${exhibit.parentName} Exhibit 21 produced ${rows.length} subsidiary row(s).`,
      { minimumRows: exhibit.minimumRows }
    );
    addCheck(
      missingExpectedRows.length === 0 ? "passed" : "failed",
      "entity_mapping",
      `${exhibit.companyId}:expected_rows`,
      missingExpectedRows.length === 0
        ? "Expected subsidiary/jurisdiction rows are present."
        : `${missingExpectedRows.length} expected row(s) missing.`,
      { missingExpectedRows }
    );

    if (typeof exhibit.expectedGeicoRows === "number") {
      addCheck(
        geicoRows.length === exhibit.expectedGeicoRows ? "passed" : "failed",
        "entity_mapping",
        `${exhibit.companyId}:geico_rows`,
        `Found ${geicoRows.length} GEICO row(s).`,
        {
          expected: exhibit.expectedGeicoRows,
          rows: geicoRows
        }
      );
    }

    if (typeof exhibit.expectedNebraskaRowsAtLeast === "number") {
      addCheck(
        nebraskaRows.length >= exhibit.expectedNebraskaRowsAtLeast ? "passed" : "failed",
        "entity_mapping",
        `${exhibit.companyId}:nebraska_rows`,
        `Found ${nebraskaRows.length} Nebraska row(s).`,
        { expectedAtLeast: exhibit.expectedNebraskaRowsAtLeast }
      );
    }

    maps.push({
      ...exhibit,
      rows,
      geicoRows,
      nebraskaRows,
      jurisdictionCounts: countBy(rows.map((row) => row.jurisdiction))
    });
  }

  return maps;
}

async function validateIndexes() {
  const loaded = [];

  for (const spec of INDEX_SPECS) {
    const indexPath = path.join(options.corpusDir, spec.fileName);
    try {
      await stat(indexPath);
    } catch {
      addCheck("warning", "index", `${spec.id}:missing`, `${spec.fileName} does not exist.`);
      continue;
    }

    try {
      const index = new JsonFileRagIndex({ filePath: indexPath, autosave: false });
      const snapshot = index.snapshot();
      const docPaths = snapshot.documents
        .map((entry) => entry.document.provenance.path)
        .filter(Boolean)
        .sort();
      const chunksByPath = countBy(
        snapshot.chunks.map((entry) => entry.chunk.provenance.path ?? "unknown")
      );

      loaded.push({
        ...spec,
        path: indexPath,
        index,
        snapshot,
        docPaths,
        chunksByPath,
        stats: index.stats()
      });

      addCheck("passed", "index", `${spec.id}:load`, `${spec.fileName} loaded.`, {
        documentCount: snapshot.documents.length,
        chunkCount: snapshot.chunks.length,
        docPaths
      });

      if (snapshot.documents.length > 0 && snapshot.chunks.length === 0) {
        addCheck(
          "warning",
          "index",
          `${spec.id}:empty_chunks`,
          `${spec.fileName} has document metadata but zero chunks.`,
          { description: spec.description }
        );
      }

      await validateIndexDocumentFiles(spec.id, snapshot);
      validateIndexChunkPaths(spec.id, snapshot);
      validateSecHtmlParserMetadata(spec.id, snapshot);
      validateTablePreservation(spec.id, snapshot);
    } catch (error) {
      addCheck("failed", "index", `${spec.id}:load`, `${spec.fileName} failed to load.`, {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return loaded;
}

async function validateIndexDocumentFiles(indexId, snapshot) {
  const failures = [];
  for (const entry of snapshot.documents) {
    const relativePath = entry.document.provenance.path;
    if (!relativePath) {
      failures.push({ documentId: entry.document.id, reason: "missing provenance.path" });
      continue;
    }
    const filePath = path.join(options.corpusDir, relativePath);
    const metadataSize = entry.document.metadata?.fileSizeBytes;
    try {
      const info = await stat(filePath);
      if (typeof metadataSize === "number" && metadataSize !== info.size) {
        failures.push({
          documentId: entry.document.id,
          path: relativePath,
          reason: "metadata fileSizeBytes mismatch",
          metadataSize,
          actualSize: info.size
        });
      }
    } catch {
      failures.push({
        documentId: entry.document.id,
        path: relativePath,
        reason: "source file missing"
      });
    }
  }

  addCheck(
    failures.length === 0 ? "passed" : "failed",
    "index",
    `${indexId}:document_files`,
    failures.length === 0
      ? "All indexed documents point to existing files with matching metadata sizes."
      : `${failures.length} indexed document file issue(s).`,
    { failures }
  );
}

function validateIndexChunkPaths(indexId, snapshot) {
  const docPaths = new Set(
    snapshot.documents.map((entry) => entry.document.provenance.path).filter(Boolean)
  );
  const orphanChunks = snapshot.chunks
    .filter((entry) => !docPaths.has(entry.chunk.provenance.path))
    .map((entry) => ({
      chunkId: entry.chunk.id,
      path: entry.chunk.provenance.path
    }));

  addCheck(
    orphanChunks.length === 0 ? "passed" : "failed",
    "index",
    `${indexId}:chunk_paths`,
    orphanChunks.length === 0
      ? "All chunk provenance paths map to indexed documents."
      : `${orphanChunks.length} chunk(s) point to paths not present in documents.`,
    { orphanChunks: orphanChunks.slice(0, 20) }
  );
}

function validateSecHtmlParserMetadata(indexId, snapshot) {
  if (!indexId.startsWith("sec-html")) {
    return;
  }

  const failures = [];
  for (const entry of snapshot.documents) {
    const metadata = entry.document.metadata ?? {};
    if (metadata.parserKind !== "sec_html") {
      failures.push({ path: entry.document.provenance.path, reason: "parserKind is not sec_html" });
    }
    if (metadata.parserRouterSelectedParserId !== "sec-html-parser") {
      failures.push({
        path: entry.document.provenance.path,
        reason: "parser router did not select sec-html-parser"
      });
    }
    if (!(metadata.parserLayoutRegionCount > 0)) {
      failures.push({ path: entry.document.provenance.path, reason: "missing layout regions" });
    }
    if (!(metadata.parserTableRegionCount > 0)) {
      failures.push({ path: entry.document.provenance.path, reason: "missing table regions" });
    }
  }

  addCheck(
    failures.length === 0 ? "passed" : "failed",
    "parser",
    `${indexId}:sec_html_metadata`,
    failures.length === 0
      ? "SEC HTML documents carry parser, layout, and table metadata."
      : `${failures.length} SEC HTML parser metadata issue(s).`,
    { failures }
  );
}

function validateTablePreservation(indexId, snapshot) {
  const expected = [
    {
      indexId: "sec-html-smoke",
      id: "alphabet_table_row",
      path: "alphabet-2024/googexhibit2101q42024.htm",
      needles: [
        "Name of Subsidiary | Jurisdiction of Incorporation or Organization",
        "Google LLC | Delaware",
        "Alphabet Capital US LLC | Delaware"
      ]
    },
    {
      indexId: "sec-html-smoke",
      id: "berkshire_geico_table_row",
      path: "berkshire-2024/brka-ex21.htm",
      needles: ["GEICO Corporation | Delaware", "GEICO General Insurance Company | Nebraska"]
    },
    {
      indexId: "sec-html-large-doc",
      id: "microsoft_openai_chunk",
      path: "microsoft-2025/msft-20250630.htm",
      needles: ["Microsoft and OpenAI maintain a long-term strategic partnership"]
    }
  ].filter((entry) => entry.indexId === indexId);

  for (const expectation of expected) {
    const chunks = snapshot.chunks.filter(
      (entry) => entry.chunk.provenance.path === expectation.path
    );
    const joined = normalizeForCompare(chunks.map((entry) => entry.chunk.text).join("\n"));
    const missing = expectation.needles.filter(
      (needle) => !joined.includes(normalizeForCompare(needle))
    );
    const chunksWithLayout = chunks.filter(
      (entry) => (entry.chunk.layoutRegionIds ?? []).length > 0
    );

    addCheck(
      missing.length === 0 && chunksWithLayout.length > 0 ? "passed" : "failed",
      "parser",
      `${indexId}:${expectation.id}`,
      missing.length === 0
        ? "Expected preserved table/evidence text exists in parser chunks."
        : "Expected preserved table/evidence text is missing from parser chunks.",
      {
        missing,
        chunksChecked: chunks.length,
        chunksWithLayout: chunksWithLayout.length
      }
    );
  }
}

async function validateRetrievalEvidence(seedQuestions, loadedIndexes) {
  const retrievableSeedQuestions = seedQuestions.filter(
    (question) => (question.expectedSources ?? []).length > 0
  );

  for (const question of retrievableSeedQuestions) {
    const expectedSources = question.expectedSources ?? [];
    const expectedAnswerContains = question.expectedAnswerContains ?? [];
    const candidateIndexes = loadedIndexes.filter((entry) =>
      expectedSources.some((source) => entry.docPaths.includes(source))
    );

    if (candidateIndexes.length === 0) {
      addCheck(
        "failed",
        "retrieval",
        `${question.id}:indexed_somewhere`,
        "No available index contains this seed case's expected source.",
        { expectedSources }
      );
      continue;
    }

    let passedAny = false;
    for (const indexEntry of candidateIndexes) {
      const retriever = new KeywordRetriever({ chunkStore: indexEntry.index });
      const result = await retriever.retrieve({
        query: question.question,
        filter: adminFilter(),
        topK: options.topK,
        candidatePoolLimit: 1000,
        mode: "keyword"
      });
      const expectedCandidates = result.candidates.filter((candidate) =>
        expectedSources.includes(candidate.chunk.provenance.path)
      );
      const combinedEvidence = normalizeForCompare(
        expectedCandidates.map((candidate) => candidate.chunk.text).join("\n")
      );
      const missingTerms = expectedAnswerContains.filter(
        (term) => !combinedEvidence.includes(normalizeForCompare(term))
      );
      const firstExpected = expectedCandidates[0];
      const firstEvidence = result.candidates.find(
        (candidate) =>
          expectedSources.includes(candidate.chunk.provenance.path) &&
          expectedAnswerContains.every((term) =>
            normalizeForCompare(candidate.chunk.text).includes(normalizeForCompare(term))
          )
      );
      const evidenceStatus =
        expectedCandidates.length > 0 && missingTerms.length === 0 ? "passed" : "failed";
      const status =
        evidenceStatus === "passed"
          ? "passed"
          : indexEntry.id === "raw-smoke"
            ? "warning"
            : "failed";
      passedAny ||= evidenceStatus === "passed";

      addCheck(
        status,
        "retrieval",
        `${question.id}:${indexEntry.id}:evidence`,
        evidenceStatus === "passed"
          ? "Retrieval returned expected source chunks containing the required evidence terms."
          : "Retrieval did not return enough expected-source evidence in topK.",
        {
          indexId: indexEntry.id,
          expectedSources,
          expectedSourceRank: firstExpected?.rank,
          exactEvidenceRank: firstEvidence?.rank,
          missingTerms,
          top: result.candidates.slice(0, 8).map(summarizeCandidate)
        }
      );

      if (firstExpected && firstEvidence && firstExpected.rank < firstEvidence.rank) {
        addCheck(
          "warning",
          "retrieval",
          `${question.id}:${indexEntry.id}:source_before_evidence`,
          "The correct document ranked before the exact evidence chunk.",
          {
            expectedSourceRank: firstExpected.rank,
            exactEvidenceRank: firstEvidence.rank
          }
        );
      }
    }

    addCheck(
      passedAny ? "passed" : "failed",
      "retrieval",
      `${question.id}:evidence_available_in_any_index`,
      passedAny
        ? "At least one available index can retrieve source-backed evidence for this seed case."
        : "No available index retrieved source-backed evidence for this seed case."
    );
  }
}

async function validateAccessDenial(loadedIndexes) {
  for (const indexEntry of loadedIndexes) {
    const hasBerkshire = indexEntry.docPaths.includes("berkshire-2024/brka-ex21.htm");
    if (!hasBerkshire) {
      continue;
    }

    const retriever = new KeywordRetriever({ chunkStore: indexEntry.index });
    const result = await retriever.retrieve({
      query: "What subsidiaries does Berkshire list?",
      filter: deniedFilter(),
      topK: 5,
      candidatePoolLimit: 1000,
      mode: "keyword"
    });
    addCheck(
      result.candidates.length === 0 ? "passed" : "failed",
      "acl",
      `${indexEntry.id}:denied_principal`,
      result.candidates.length === 0
        ? "Denied principal received zero Berkshire chunks."
        : "Denied principal received restricted chunks.",
      { returnedCount: result.candidates.length, top: result.candidates.map(summarizeCandidate) }
    );
  }
}

function buildDerivedSubsidiaryGraph(subsidiaryMaps, loadedIndexes) {
  const secHtmlIndex = loadedIndexes.find((entry) => entry.id === "sec-html-smoke");
  const entityMap = new Map();
  const entities = [];
  const relations = [];
  const evidenceMisses = [];

  for (const map of subsidiaryMaps) {
    const parentEvidence = evidenceForSource(map.sourcePath, map.parentName, secHtmlIndex);
    const parent = upsertEntity({
      entityMap,
      entities,
      name: map.parentName,
      kind: "organization",
      evidence: parentEvidence.evidence
    });

    for (const row of map.rows) {
      const evidenceLookup = evidenceForSource(
        map.sourcePath,
        `${row.name} | ${row.jurisdiction}`,
        secHtmlIndex
      );
      if (!evidenceLookup.found) {
        evidenceMisses.push({
          sourcePath: map.sourcePath,
          name: row.name,
          jurisdiction: row.jurisdiction
        });
      }

      const child = upsertEntity({
        entityMap,
        entities,
        name: row.name,
        kind: "legal_entity",
        evidence: evidenceLookup.evidence
      });
      const jurisdiction = upsertEntity({
        entityMap,
        entities,
        name: row.jurisdiction,
        kind: "location",
        evidence: evidenceLookup.evidence
      });

      relations.push(
        relationProposal({
          id: `rel_${safeId(map.companyId)}_${safeId(row.name)}_listed_subsidiary`,
          relationKind: "related_to",
          sourceEntityId: parent.id,
          targetEntityId: child.id,
          evidence: evidenceLookup.evidence,
          metadata: {
            relationLabel: "listed_subsidiary",
            sourcePath: map.sourcePath
          }
        })
      );
      relations.push(
        relationProposal({
          id: `rel_${safeId(row.name)}_${safeId(row.jurisdiction)}_registered_in`,
          relationKind: "registered_in",
          sourceEntityId: child.id,
          targetEntityId: jurisdiction.id,
          evidence: evidenceLookup.evidence,
          metadata: {
            sourcePath: map.sourcePath
          }
        })
      );
    }
  }

  const batch = {
    id: "sec_company_corpus_derived_subsidiary_graph",
    namespaceId: options.namespaceId,
    ontology: {
      id: "sec-subsidiary-list-v1",
      entityKinds: ["organization", "legal_entity", "location"],
      relationKinds: ["related_to", "registered_in"],
      requiredEvidenceForRelations: true,
      allowInferredRelations: false
    },
    entities,
    relations,
    createdAt: FIXED_CREATED_AT
  };

  return {
    batch,
    evidenceMisses,
    summary: {
      entityCount: entities.length,
      relationCount: relations.length,
      evidenceMissCount: evidenceMisses.length,
      parentCount: subsidiaryMaps.length,
      subsidiaryRowCount: subsidiaryMaps.reduce((sum, map) => sum + map.rows.length, 0)
    }
  };
}

async function validateDerivedGraph(derivedGraph) {
  const validation = validateGraphExtractionBatch(derivedGraph.batch);
  addCheck(
    validation.valid ? "passed" : "failed",
    "graph_mapping",
    "derived_graph_validation",
    validation.valid
      ? "Derived subsidiary/jurisdiction graph passes graph proposal validation."
      : "Derived subsidiary/jurisdiction graph failed graph proposal validation.",
    {
      summary: derivedGraph.summary,
      errors: validation.errors,
      warnings: validation.warnings
    }
  );
  addCheck(
    derivedGraph.evidenceMisses.length === 0 ? "passed" : "failed",
    "graph_mapping",
    "derived_graph_evidence_links",
    derivedGraph.evidenceMisses.length === 0
      ? "Every derived graph row links back to an indexed evidence chunk."
      : `${derivedGraph.evidenceMisses.length} derived graph row(s) lacked indexed evidence chunks.`,
    { evidenceMisses: derivedGraph.evidenceMisses.slice(0, 50) }
  );
}

async function validateMicrosoftOpenAiRelationship() {
  const sourcePath = "microsoft-2025/msft-20250630.htm";
  const text = await readSourceTextIfExists(sourcePath);
  const missing = MICROSOFT_OPENAI_PHRASES.filter(
    (phrase) => !includesNormalized(text ?? "", phrase)
  );

  addCheck(
    missing.length === 0 ? "passed" : "failed",
    "relationship_mapping",
    "microsoft_openai_direct_source",
    missing.length === 0
      ? "Microsoft/OpenAI relationship phrases are directly present in the annual report."
      : "Microsoft/OpenAI relationship phrases are missing from the annual report text.",
    { missing }
  );
}

async function validateUnsupportedOwnershipPercentages(subsidiaryMaps) {
  const berkshire = subsidiaryMaps.find((entry) => entry.companyId === "berkshire-2024");
  const geicoRows = berkshire?.geicoRows ?? [];
  const rowsWithPercentages = geicoRows.filter((row) =>
    percentagePattern().test(`${row.name} ${row.jurisdiction}`)
  );

  addCheck(
    rowsWithPercentages.length === 0 ? "passed" : "failed",
    "grounding",
    "berkshire_geico_no_percentages_in_rows",
    rowsWithPercentages.length === 0
      ? "GEICO subsidiary rows have names and jurisdictions, not ownership percentages."
      : "One or more GEICO rows appear to contain percentage claims.",
    { rowsWithPercentages }
  );

  const sourceText = await readSourceTextIfExists("berkshire-2024/brka-ex21.htm");
  const geicoContexts = geicoRows.map((row) => contextAround(sourceText ?? "", row.name, 180));
  const contextsWithPercentages = geicoContexts.filter((context) =>
    percentagePattern().test(context)
  );
  addCheck(
    contextsWithPercentages.length === 0 ? "passed" : "failed",
    "grounding",
    "berkshire_geico_no_percentages_in_context",
    contextsWithPercentages.length === 0
      ? "Nearby source context does not support exact GEICO ownership percentages."
      : "Nearby GEICO context contains percentage-like text.",
    { contextsWithPercentages }
  );
}

function buildReport(input) {
  const summary = summarizeChecks(checks);
  const indexSummaries = input.loadedIndexes.map((entry) => ({
    id: entry.id,
    fileName: entry.fileName,
    description: entry.description,
    documentCount: entry.stats.documentCount,
    chunkCount: entry.stats.chunkCount,
    docPaths: entry.docPaths,
    chunksByPath: entry.chunksByPath
  }));
  const entitySummaries = input.subsidiaryMaps.map((entry) => ({
    companyId: entry.companyId,
    parentName: entry.parentName,
    sourcePath: entry.sourcePath,
    rowCount: entry.rows.length,
    geicoRowCount: entry.geicoRows.length,
    nebraskaRowCount: entry.nebraskaRows.length,
    jurisdictionCounts: entry.jurisdictionCounts
  }));

  return {
    generatedAt: new Date().toISOString(),
    corpusDir: options.corpusDir,
    seedQuestionCount: input.seedQuestions.length,
    summary,
    checks: sortChecks(checks),
    indexes: indexSummaries,
    entityMappings: entitySummaries,
    derivedGraph: input.derivedGraph.summary
  };
}

function renderMarkdown(report) {
  const lines = [
    "# SEC Corpus Deep Eval",
    "",
    `Generated: ${report.generatedAt}`,
    `Corpus: \`${report.corpusDir}\``,
    "",
    "## Summary",
    "",
    `- Status: ${report.summary.status}`,
    `- Passed: ${report.summary.passed}`,
    `- Failed: ${report.summary.failed}`,
    `- Warnings: ${report.summary.warning}`,
    `- Skipped: ${report.summary.skipped}`,
    `- Total checks: ${report.summary.total}`,
    "",
    "## What This Checks",
    "",
    "- Manifest files exist and match byte sizes.",
    "- Source configs reference real files and preserve access-scope filters.",
    "- Seed expected answers are actually present in the expected source documents.",
    "- Exhibit 21 subsidiary rows map to entities and jurisdictions.",
    "- SEC HTML parser output preserves table rows and layout links.",
    "- Retrieval returns chunks that contain answer evidence, not just the right document.",
    "- ACL-denied principals cannot retrieve restricted Berkshire chunks.",
    "- Derived subsidiary/jurisdiction graph relations validate and link to evidence chunks.",
    "- Unsupported GEICO ownership-percentage questions are unsupported by the source rows.",
    "",
    "## Indexes",
    "",
    "| Index | Documents | Chunks | Paths |",
    "| --- | ---: | ---: | --- |",
    ...report.indexes.map(
      (entry) =>
        `| ${entry.id} | ${entry.documentCount} | ${entry.chunkCount} | ${entry.docPaths.join("<br>")} |`
    ),
    "",
    "## Entity Mapping",
    "",
    "| Company | Rows | GEICO rows | Nebraska rows | Source |",
    "| --- | ---: | ---: | ---: | --- |",
    ...report.entityMappings.map(
      (entry) =>
        `| ${entry.parentName} | ${entry.rowCount} | ${entry.geicoRowCount} | ${entry.nebraskaRowCount} | ${entry.sourcePath} |`
    ),
    "",
    "## Derived Graph",
    "",
    `- Entities: ${report.derivedGraph.entityCount}`,
    `- Relations: ${report.derivedGraph.relationCount}`,
    `- Subsidiary rows: ${report.derivedGraph.subsidiaryRowCount}`,
    `- Evidence misses: ${report.derivedGraph.evidenceMissCount}`,
    "",
    "## Failed Checks",
    ""
  ];

  const failed = report.checks.filter((check) => check.status === "failed");
  if (failed.length === 0) {
    lines.push("None.", "");
  } else {
    for (const check of failed) {
      lines.push(`- ${check.category}/${check.id}: ${check.message}`);
    }
    lines.push("");
  }

  const warnings = report.checks.filter((check) => check.status === "warning");
  lines.push("## Warnings", "");
  if (warnings.length === 0) {
    lines.push("None.", "");
  } else {
    for (const check of warnings) {
      lines.push(`- ${check.category}/${check.id}: ${check.message}`);
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

function extractSubsidiaryRows(html) {
  return [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map((match) => extractCells(match[1]))
    .filter((cells) => cells.length >= 2)
    .map((cells) => ({
      name: cells[0],
      jurisdiction: cells[cells.length - 1]
    }))
    .filter((row) => row.name && row.jurisdiction && !isSubsidiaryHeader(row))
    .filter((row) => !/^reg\.?\s*s-k/i.test(row.name));
}

function extractCells(rowHtml) {
  return [...rowHtml.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)]
    .map((match) => stripHtmlToText(match[1]))
    .map((cell) => cell.trim())
    .filter(Boolean);
}

function isSubsidiaryHeader(row) {
  const name = normalizeForCompare(row.name);
  const jurisdiction = normalizeForCompare(row.jurisdiction);
  return (
    name === "name" ||
    name === "company name" ||
    name === "name of subsidiary" ||
    jurisdiction === "where incorporated" ||
    jurisdiction === "domicile or state of incorporation" ||
    jurisdiction === "jurisdiction of incorporation or organization"
  );
}

function evidenceForSource(sourcePath, textNeedle, indexEntry) {
  const fallback = syntheticEvidence(sourcePath, textNeedle);
  if (!indexEntry) {
    return { found: false, evidence: [fallback] };
  }

  const normalizedNeedle = normalizeForCompare(textNeedle);
  const chunks = indexEntry.snapshot.chunks.filter(
    (entry) => entry.chunk.provenance.path === sourcePath
  );
  const exact = chunks.find((entry) =>
    normalizeForCompare(entry.chunk.text).includes(normalizedNeedle)
  );
  const loose = chunks.find((entry) =>
    textNeedle
      .split("|")
      .map((part) => normalizeForCompare(part))
      .filter(Boolean)
      .every((part) => normalizeForCompare(entry.chunk.text).includes(part))
  );
  const match = exact ?? loose;
  if (!match) {
    return { found: false, evidence: [fallback] };
  }

  return {
    found: true,
    evidence: [
      {
        chunkId: match.chunk.id,
        documentId: match.chunk.documentId,
        sourceId: match.chunk.provenance.sourceId,
        citation: match.chunk.citation,
        quoteHash: hashText(textNeedle),
        characterStart: match.chunk.characterStart,
        characterEnd: match.chunk.characterEnd
      }
    ]
  };
}

function syntheticEvidence(sourcePath, textNeedle) {
  return {
    chunkId: `missing_chunk_${safeId(sourcePath)}_${safeId(textNeedle).slice(0, 24)}`,
    documentId: `missing_document_${safeId(sourcePath)}`,
    sourceId: "curated_docs",
    citation: {
      sourceId: "curated_docs",
      chunkId: `missing_chunk_${safeId(sourcePath)}_${safeId(textNeedle).slice(0, 24)}`,
      title: sourcePath,
      locator: "source file"
    },
    quoteHash: hashText(textNeedle)
  };
}

function upsertEntity(input) {
  const key = `${input.kind}:${normalizeEntityName(input.name)}`;
  const existing = input.entityMap.get(key);
  if (existing) {
    return existing;
  }

  const entity = {
    id: `ent_${safeId(input.kind)}_${safeId(input.name)}`,
    namespaceId: options.namespaceId,
    kind: input.kind,
    name: input.name,
    normalizedName: normalizeEntityName(input.name),
    confidence: 1,
    trustTier: "trusted_internal",
    accessScope: accessScope(),
    evidence: input.evidence,
    status: "verified",
    createdAt: FIXED_CREATED_AT,
    metadata: {
      source: "sec_company_corpus_deep_eval"
    }
  };
  input.entityMap.set(key, entity);
  input.entities.push(entity);
  return entity;
}

function relationProposal(input) {
  return {
    id: input.id.slice(0, 120),
    namespaceId: options.namespaceId,
    relationKind: input.relationKind,
    sourceEntityId: input.sourceEntityId,
    targetEntityId: input.targetEntityId,
    factStrength: "explicit_fact",
    confidence: 1,
    trustTier: "trusted_internal",
    accessScope: accessScope(),
    evidence: input.evidence,
    temporal: {
      observedAt: FIXED_CREATED_AT
    },
    verificationStatus: "supported",
    status: "verified",
    createdAt: FIXED_CREATED_AT,
    metadata: input.metadata
  };
}

async function readSourceTextIfExists(relativePath) {
  try {
    const raw = await readFile(path.join(options.corpusDir, relativePath), "utf8");
    return stripHtmlToText(raw);
  } catch {
    return undefined;
  }
}

function stripHtmlToText(raw) {
  return decodeHtmlEntities(
    raw
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtmlEntities(value) {
  const named = {
    amp: "&",
    apos: "'",
    gt: ">",
    ldquo: '"',
    lsquo: "'",
    lt: "<",
    nbsp: " ",
    quot: '"',
    rdquo: '"',
    rsquo: "'"
  };

  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (_, entity) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith("#x")) {
      return String.fromCodePoint(Number.parseInt(lower.slice(2), 16));
    }
    if (lower.startsWith("#")) {
      return String.fromCodePoint(Number.parseInt(lower.slice(1), 10));
    }
    return named[lower] ?? " ";
  });
}

function rowKey(name, jurisdiction) {
  return `${normalizeForCompare(name)}|${normalizeForCompare(jurisdiction)}`;
}

function includesNormalized(haystack, needle) {
  return normalizeForCompare(haystack).includes(normalizeForCompare(needle));
}

function normalizeForCompare(value) {
  return String(value)
    .replace(/[’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizeEntityName(value) {
  return String(value).replace(/[’]/g, "'").replace(/\s+/g, " ").trim().toLowerCase();
}

function contextAround(text, needle, radius) {
  const normalized = normalizeForCompare(text);
  const normalizedNeedle = normalizeForCompare(needle);
  const index = normalized.indexOf(normalizedNeedle);
  if (index < 0) {
    return "";
  }
  return normalized.slice(
    Math.max(0, index - radius),
    Math.min(normalized.length, index + normalizedNeedle.length + radius)
  );
}

function percentagePattern() {
  return /\b\d{1,3}(?:\.\d+)?\s*%/u;
}

function summarizeCandidate(candidate) {
  return {
    rank: candidate.rank,
    score: Math.round(candidate.score * 1000) / 1000,
    path: candidate.chunk.provenance.path,
    locator: candidate.citation.locator,
    matchedTerms: candidate.matchedTerms,
    preview: candidate.chunk.text.slice(0, 220).replace(/\s+/g, " ")
  };
}

function adminFilter() {
  return {
    namespaceId: options.namespaceId,
    tenantId: options.tenantId,
    principal: {
      userId: options.userId,
      tenantId: options.tenantId,
      namespaceIds: [options.namespaceId],
      teamIds: [],
      roles: ["admin"],
      tags: ["sec-test-corpus"]
    },
    limit: 1000
  };
}

function deniedFilter() {
  return {
    namespaceId: options.namespaceId,
    tenantId: options.tenantId,
    principal: {
      userId: "denied_user",
      tenantId: options.tenantId,
      namespaceIds: [options.namespaceId],
      teamIds: [],
      roles: ["viewer"],
      tags: []
    },
    limit: 1000
  };
}

function accessScope() {
  return {
    tenantId: options.tenantId,
    namespaceId: options.namespaceId,
    roles: ["admin"],
    tags: ["sec-test-corpus"]
  };
}

function countBy(values) {
  return values.reduce((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

function addCheck(status, category, id, message, details = {}) {
  checks.push({
    status,
    category,
    id,
    message,
    ...(Object.keys(details).length === 0 ? {} : { details })
  });
}

function summarizeChecks(values) {
  const counts = values.reduce(
    (total, check) => {
      total[check.status] = (total[check.status] ?? 0) + 1;
      return total;
    },
    { passed: 0, failed: 0, warning: 0, skipped: 0 }
  );

  return {
    status: counts.failed > 0 ? "failed" : counts.warning > 0 ? "warning" : "passed",
    passed: counts.passed,
    failed: counts.failed,
    warning: counts.warning,
    skipped: counts.skipped,
    total: values.length
  };
}

function sortChecks(values) {
  return [...values].sort(
    (first, second) =>
      first.category.localeCompare(second.category) || first.id.localeCompare(second.id)
  );
}

function safeId(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

function hashText(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function parseArgs(args) {
  const parsed = {
    corpusDir: DEFAULT_CORPUS_DIR,
    reportDir: DEFAULT_REPORT_DIR,
    namespaceId: DEFAULT_NAMESPACE_ID,
    tenantId: DEFAULT_TENANT_ID,
    userId: DEFAULT_USER_ID,
    topK: DEFAULT_TOP_K
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--corpus-dir":
        parsed.corpusDir = requiredValue(args, ++index, arg);
        break;
      case "--report-dir":
        parsed.reportDir = requiredValue(args, ++index, arg);
        break;
      case "--namespace-id":
        parsed.namespaceId = requiredValue(args, ++index, arg);
        break;
      case "--tenant-id":
        parsed.tenantId = requiredValue(args, ++index, arg);
        break;
      case "--user-id":
        parsed.userId = requiredValue(args, ++index, arg);
        break;
      case "--top-k":
        parsed.topK = Number.parseInt(requiredValue(args, ++index, arg), 10);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isInteger(parsed.topK) || parsed.topK < 1 || parsed.topK > 100) {
    throw new Error("--top-k must be an integer between 1 and 100.");
  }

  return parsed;
}

function requiredValue(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }

  return value;
}
