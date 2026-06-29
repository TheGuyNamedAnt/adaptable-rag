#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  assertValidProfile,
  buildIngestionIntegrityReport,
  checkGraphIntegrity,
  checkGraphRecall,
  CorpusAdapterRegistry,
  createBestCombinedLocalParserRouter,
  GraphApprovalRunner,
  GraphEntityResolutionRunner,
  GraphIngestionRunner,
  genericDocsProfile,
  InMemoryGraphStore,
  IngestPipeline,
  InMemoryRagIndex,
  LocalFilesCorpusAdapter,
  buildGraphExtractionTrace,
  normalizeEntityName,
  ownershipGraphOntology
} from "../dist/index.js";

const FIXED_REQUESTED_AT = "2026-06-27T00:00:00.000Z";

const options = parseArgs(process.argv.slice(2));
const sourcesPath = options.sourcesPath ?? process.env.RAG_LOCAL_FILES_SOURCES_PATH;
if (!sourcesPath) {
  throw new Error("--sources or RAG_LOCAL_FILES_SOURCES_PATH is required.");
}

const profile = assertValidProfile(genericDocsProfile);
const source = profile.corpusSources.find((candidate) => candidate.id === options.sourceId);
if (!source) {
  throw new Error(`Unknown profile source id "${options.sourceId}".`);
}

const parser = createBestCombinedLocalParserRouter({
  parserId: options.parserId,
  preferTables: true,
  preferVisualAssets: true
});
const localSources = await readLocalFilesSources(sourcesPath, {
  parserId: parser.id,
  forceParserLayout: options.forceParserLayout
});
const index = new InMemoryRagIndex({ now: () => FIXED_REQUESTED_AT });
const adapter = new LocalFilesCorpusAdapter({
  sources: localSources,
  parsers: [parser]
});
const pipeline = new IngestPipeline({
  adapterRegistry: new CorpusAdapterRegistry([adapter]),
  documentStore: index,
  chunkStore: index,
  now: () => FIXED_REQUESTED_AT
});

const ingest = await pipeline.ingest({
  profile,
  sourceIds: [source.id],
  requestedBy: {
    userId: options.userId,
    tenantId: options.tenantId,
    namespaceIds: [profile.namespaceId],
    roles: options.roles,
    tags: options.tags
  },
  overwriteMode: "replace",
  runId: options.runId,
  requestedAt: FIXED_REQUESTED_AT
});
const graphPostIngest = options.requireGraphCoverage
  ? await extractGraphFromAcceptedChunks({
      profile,
      ingest,
      filter: {
        namespaceId: profile.namespaceId,
        tenantId: options.tenantId,
        principal: {
          userId: options.userId,
          tenantId: options.tenantId,
          namespaceIds: [profile.namespaceId],
          teamIds: [],
          roles: options.roles,
          tags: options.tags
        }
      },
      runId: `${options.runId}_graph`,
      requestedAt: FIXED_REQUESTED_AT
    })
  : undefined;
const graphIntegrity =
  graphPostIngest?.extraction?.status === "succeeded"
    ? checkGraphIntegrity({
        batch: graphPostIngest.extraction.batch,
        chunks: acceptedChunks(ingest.chunks)
      })
    : undefined;
const graphRecall =
  options.expectedGraphPath && graphPostIngest?.extraction?.status === "succeeded"
    ? checkGraphRecall({
        batch: graphPostIngest.extraction.batch,
        ...expectedGraphRecallInput(await readExpectedGraph(options.expectedGraphPath))
      })
    : undefined;
const integrity = buildIngestionIntegrityReport({
  ingest,
  ...(graphPostIngest === undefined
    ? {}
    : {
        postIngest: {
          knowledgeEntityCount: graphPostIngest.trace.entityCount,
          knowledgeRelationCount: graphPostIngest.trace.relationCount
        }
      }),
  options: {
    requireLayoutForComplexDocuments: options.requireLayoutForComplexDocuments,
    requireChunkRelationships: options.requireChunkRelationships,
    requireVectorCoverage: options.requireVectorCoverage,
    requireVisualCoverage: options.requireVisualCoverage,
    requireGraphCoverage: options.requireGraphCoverage,
    ocrNeededSeverity: options.allowOcrGaps ? "warning" : "error"
  }
});
const reportStatus =
  integrity.status === "failed" || graphIntegrity?.valid === false || graphRecall?.passed === false
    ? "failed"
    : integrity.status;
const report = {
  status: reportStatus,
  generatedAt: new Date().toISOString(),
  sourcesPath,
  sourceId: source.id,
  runId: ingest.runId,
  counts: {
    loadedSourceCount: ingest.loadedSourceIds.length,
    acceptedDocumentCount: ingest.documents.length,
    acceptedChunkCount: ingest.chunks.length,
    rejectedRecordCount: ingest.rejectedRecords.length,
    adapterWarningCount: ingest.adapterWarnings.length,
    normalizationIssueCount: ingest.normalizationIssues.length,
    parserQualityWarningCount: ingest.parserQualityWarnings.length,
    searchableArtifactWarningCount: ingest.searchableArtifactWarnings?.length ?? 0,
    chunkingWarningCount: ingest.chunkingWarnings.length
  },
  parserQuality: ingest.parserQuality,
  ...(graphPostIngest === undefined ? {} : { graphIngestion: graphPostIngest.trace }),
  ...(graphIntegrity === undefined
    ? {}
    : { graphIntegrity: summarizeGraphIntegrity(graphIntegrity) }),
  ...(graphRecall === undefined ? {} : { graphRecall: summarizeGraphRecall(graphRecall) }),
  integrity
};

await mkdir(options.reportDir, { recursive: true });
if (graphPostIngest?.extraction?.status === "succeeded") {
  await writeFile(
    path.join(options.reportDir, "graph-facts.json"),
    JSON.stringify(
      {
        trace: graphPostIngest.trace,
        entities: graphPostIngest.extraction.batch.entities,
        relations: graphPostIngest.extraction.batch.relations
      },
      null,
      2
    )
  );
}
await writeFile(
  path.join(options.reportDir, "ingestion-integrity.json"),
  JSON.stringify(report, null, 2)
);
await writeFile(path.join(options.reportDir, "ingestion-integrity.md"), renderMarkdown(report));
console.log(JSON.stringify(report, null, 2));

if (report.status === "failed") {
  process.exitCode = 1;
}

async function readLocalFilesSources(configPath, defaults) {
  const resolvedPath = path.resolve(configPath);
  const parsed = JSON.parse(await readFile(resolvedPath, "utf8"));
  const sources = Array.isArray(parsed) ? parsed : parsed.sources;
  if (!Array.isArray(sources)) {
    throw new Error(`${configPath} must be an array or an object with sources[].`);
  }

  const baseDirectory = path.dirname(resolvedPath);
  return sources.map((source) => ({
    ...source,
    rootDir: path.isAbsolute(source.rootDir)
      ? source.rootDir
      : path.resolve(baseDirectory, source.rootDir),
    parserId: source.parserId ?? defaults.parserId,
    ...(defaults.forceParserLayout ? { parserRequireLayout: true } : {})
  }));
}

function renderMarkdown(report) {
  const lines = [
    "# Ingestion Integrity Report",
    "",
    `- Status: ${report.status}`,
    `- Sources: \`${report.sourcesPath}\``,
    `- Accepted documents: ${report.counts.acceptedDocumentCount}`,
    `- Accepted chunks: ${report.counts.acceptedChunkCount}`,
    `- Rejected records: ${report.counts.rejectedRecordCount}`,
    `- Integrity errors: ${report.integrity.errorCount}`,
    `- Integrity warnings: ${report.integrity.warningCount}`,
    "",
    "## Coverage",
    "",
    "| Metric | Value |",
    "| --- | ---: |",
    `| Pages | ${report.integrity.counts.pageCount} |`,
    `| Pages needing OCR | ${report.integrity.counts.pagesNeedingOcrCount} |`,
    `| Tables | ${report.integrity.counts.tableCount} |`,
    `| Table rows | ${report.integrity.counts.tableRowCount} |`,
    `| Visual assets | ${report.integrity.counts.visualAssetCount} |`,
    `| Layout relations | ${report.integrity.counts.layoutRelationCount} |`,
    `| Chunk relationships | ${report.integrity.counts.chunkRelationshipCount} |`,
    "",
    "## Searchable Units",
    "",
    "| Unit | Count |",
    "| --- | ---: |",
    ...Object.entries(report.integrity.searchableUnitCounts)
      .sort(([first], [second]) => first.localeCompare(second))
      .map(([unit, count]) => `| ${unit} | ${count} |`)
  ];

  if (report.graphIntegrity) {
    lines.push(
      "",
      "## Graph Integrity",
      "",
      `- Status: ${report.graphIntegrity.status}`,
      `- Checked entities: ${report.graphIntegrity.checkedEntityCount}`,
      `- Checked relations: ${report.graphIntegrity.checkedRelationCount}`,
      `- Checked evidence anchors: ${report.graphIntegrity.checkedEvidenceAnchorCount}`,
      `- Errors: ${report.graphIntegrity.errorCount}`,
      `- Warnings: ${report.graphIntegrity.warningCount}`
    );
  }

  if (report.graphRecall) {
    lines.push(
      "",
      "## Graph Recall",
      "",
      `- Status: ${report.graphRecall.status}`,
      `- Expected entities: ${report.graphRecall.expectedEntityCount}`,
      `- Matched entities: ${report.graphRecall.matchedEntityCount}`,
      `- Entity recall: ${report.graphRecall.entityRecall}`,
      `- Expected relations: ${report.graphRecall.expectedRelationCount}`,
      `- Matched relations: ${report.graphRecall.matchedRelationCount}`,
      `- Relation recall: ${report.graphRecall.relationRecall}`,
      `- Issues: ${report.graphRecall.issueCount}`
    );
  }

  if (report.integrity.issues.length > 0) {
    lines.push("", "## Issues", "");
    for (const issue of report.integrity.issues) {
      const target = [
        issue.documentId ? `doc=${issue.documentId}` : undefined,
        issue.sourceId ? `source=${issue.sourceId}` : undefined,
        issue.pageNumber === undefined ? undefined : `page=${issue.pageNumber}`
      ]
        .filter(Boolean)
        .join(", ");
      lines.push(
        `- ${issue.severity.toUpperCase()} ${issue.code}${target ? ` (${target})` : ""}: ${issue.message}`
      );
    }
  }

  if (report.graphIntegrity?.issues?.length > 0) {
    lines.push("", "## Graph Integrity Issues", "");
    for (const issue of report.graphIntegrity.issues) {
      const target = [
        issue.path,
        issue.entityId ? `entity=${issue.entityId}` : undefined,
        issue.relationId ? `relation=${issue.relationId}` : undefined,
        issue.chunkId ? `chunk=${issue.chunkId}` : undefined
      ]
        .filter(Boolean)
        .join(", ");
      lines.push(
        `- ${issue.severity.toUpperCase()} ${issue.code}${target ? ` (${target})` : ""}: ${issue.message}`
      );
    }
  }

  if (report.graphRecall?.issues?.length > 0) {
    lines.push("", "## Graph Recall Issues", "");
    for (const issue of report.graphRecall.issues) {
      lines.push(`- ${issue.code}: ${issue.message}`);
    }
  }

  lines.push("");
  return lines.join("\n");
}

function summarizeGraphIntegrity(result) {
  return {
    status: result.valid ? "passed" : "failed",
    checkedEntityCount: result.checkedEntityCount,
    checkedRelationCount: result.checkedRelationCount,
    checkedEvidenceAnchorCount: result.checkedEvidenceAnchorCount,
    issueCount: result.issues.length,
    errorCount: result.errors.length,
    warningCount: result.warnings.length,
    issues: result.issues
  };
}

function summarizeGraphRecall(result) {
  return {
    status: result.passed ? "passed" : "failed",
    expectedEntityCount: result.expectedEntityCount,
    matchedEntityCount: result.matchedEntityCount,
    entityRecall: result.entityRecall,
    expectedRelationCount: result.expectedRelationCount,
    matchedRelationCount: result.matchedRelationCount,
    relationRecall: result.relationRecall,
    missingEntityCount: result.missingEntities.length,
    missingRelationCount: result.missingRelations.length,
    extraEntityCount: result.extraEntities.length,
    extraRelationCount: result.extraRelations.length,
    forbiddenRelationCount: result.forbiddenRelations.length,
    issueCount: result.issues.length,
    issues: result.issues
  };
}

function acceptedChunks(chunks) {
  return chunks.map((entry) => entry.chunk ?? entry);
}

async function readExpectedGraph(expectedGraphPath) {
  return JSON.parse(await readFile(path.resolve(expectedGraphPath), "utf8"));
}

function expectedGraphRecallInput(expectedGraph) {
  return {
    expectedEntities: expectedGraph.expectedEntities ?? [],
    expectedRelations: expectedGraph.expectedRelations ?? [],
    ...(expectedGraph.forbiddenRelations === undefined
      ? {}
      : { forbiddenRelations: expectedGraph.forbiddenRelations }),
    ...(expectedGraph.thresholds === undefined ? {} : { thresholds: expectedGraph.thresholds })
  };
}

function parseArgs(args) {
  const options = {
    sourceId: "curated_docs",
    reportDir: path.join(".rag", "ingestion-integrity", "latest"),
    tenantId: "tenant_1",
    userId: "rag_integrity",
    roles: ["reader"],
    tags: ["curated", "docs"],
    runId: "ingestion_integrity",
    parserId: "ingestion-integrity-local-parser",
    requireLayoutForComplexDocuments: true,
    requireChunkRelationships: true,
    requireVectorCoverage: false,
    requireVisualCoverage: false,
    requireGraphCoverage: false,
    allowOcrGaps: false,
    forceParserLayout: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--sources":
        options.sourcesPath = requiredValue(args, ++index, arg);
        break;
      case "--source-id":
        options.sourceId = requiredValue(args, ++index, arg);
        break;
      case "--report-dir":
        options.reportDir = requiredValue(args, ++index, arg);
        break;
      case "--tenant-id":
        options.tenantId = requiredValue(args, ++index, arg);
        break;
      case "--user-id":
        options.userId = requiredValue(args, ++index, arg);
        break;
      case "--role":
        options.roles = [...options.roles, requiredValue(args, ++index, arg)];
        break;
      case "--tag":
        options.tags = [...options.tags, requiredValue(args, ++index, arg)];
        break;
      case "--run-id":
        options.runId = requiredValue(args, ++index, arg);
        break;
      case "--parser-id":
        options.parserId = requiredValue(args, ++index, arg);
        break;
      case "--expected-graph":
        options.expectedGraphPath = requiredValue(args, ++index, arg);
        break;
      case "--require-layout-for-complex":
        options.requireLayoutForComplexDocuments = parseBoolean(
          requiredValue(args, ++index, arg),
          arg
        );
        break;
      case "--require-chunk-relationships":
        options.requireChunkRelationships = parseBoolean(requiredValue(args, ++index, arg), arg);
        break;
      case "--require-vectors":
        options.requireVectorCoverage = parseBoolean(requiredValue(args, ++index, arg), arg);
        break;
      case "--require-visual-vectors":
        options.requireVisualCoverage = parseBoolean(requiredValue(args, ++index, arg), arg);
        break;
      case "--require-graph":
        options.requireGraphCoverage = parseBoolean(requiredValue(args, ++index, arg), arg);
        break;
      case "--allow-ocr-gaps":
        options.allowOcrGaps = parseBoolean(requiredValue(args, ++index, arg), arg);
        break;
      case "--force-parser-layout":
        options.forceParserLayout = parseBoolean(requiredValue(args, ++index, arg), arg);
        break;
      default:
        throw new Error(`Unknown ingestion integrity argument "${arg}".`);
    }
  }

  if (options.expectedGraphPath) {
    options.requireGraphCoverage = true;
  }

  return options;
}

function requiredValue(args, index, flag) {
  const value = args[index];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function parseBoolean(value, flag) {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new Error(`${flag} must be true or false.`);
}

async function extractGraphFromAcceptedChunks(input) {
  const graphStore = new InMemoryGraphStore();
  const extractor = createHeuristicChunkGraphExtractor({
    ontology: ownershipGraphOntology,
    requestedAt: input.requestedAt
  });
  const runner = new GraphIngestionRunner({
    extractor,
    graphStore,
    approvalRunner: new GraphApprovalRunner({ graphStore, now: () => input.requestedAt }),
    now: () => input.requestedAt
  });
  const result = await runner.ingest({
    profile: {
      id: input.profile.id,
      namespaceId: input.profile.namespaceId
    },
    ontology: ownershipGraphOntology,
    documents: input.ingest.documents,
    chunks: input.ingest.chunks,
    approvalFilter: input.filter,
    ingestionId: input.runId,
    requestedAt: input.requestedAt
  });

  new GraphEntityResolutionRunner({
    graphStore,
    now: () => input.requestedAt
  }).resolve({
    filter: input.filter,
    runId: `${input.runId}_entity_resolution`,
    requestedAt: input.requestedAt
  });

  return result;
}

function createHeuristicChunkGraphExtractor(options) {
  return {
    id: "heuristic-chunk-graph-extractor",
    supportedOntologyIds: [ownershipGraphOntology.id],
    async extract(request) {
      const startedAt = request.requestedAt ?? options.requestedAt;
      const extractionId =
        request.extractionId ?? `heuristic_graph_${startedAt.replace(/[^0-9a-z]/gi, "")}`;
      const builder = createHeuristicGraphBatchBuilder({
        request,
        extractionId,
        ontology: options.ontology,
        createdAt: options.requestedAt
      });

      for (const document of request.documents) {
        builder.extractFromDocument(document);
      }
      for (const chunk of request.chunks) {
        builder.extractFromChunk(chunk);
      }

      const batch = builder.batch();
      return {
        status: "succeeded",
        batch,
        validationIssues: [],
        trace: buildGraphExtractionTrace({
          request,
          extractionId,
          startedAt,
          finishedAt: options.requestedAt,
          status: "succeeded",
          entityCount: batch.entities.length,
          relationCount: batch.relations.length
        })
      };
    }
  };
}

function createHeuristicGraphBatchBuilder(options) {
  const entitiesByKey = new Map();
  const relationsByKey = new Map();
  const aliasDefinitionsByAliasKey = new Map();
  const aliasesByCanonicalKey = new Map();
  const chunksByDocumentId = new Map();
  for (const chunk of options.request.chunks) {
    chunksByDocumentId.set(chunk.documentId, [
      ...(chunksByDocumentId.get(chunk.documentId) ?? []),
      chunk
    ]);
  }

  function extractFromDocument(document) {
    const body = normalizeWhitespace(document.body);
    if (!isSubsidiaryTableDocument(body)) {
      return;
    }

    const parentName = subsidiaryTableParentName(document, body);
    if (!parentName) {
      return;
    }

    const tableRows = subsidiaryTableRows(document.body);
    if (tableRows.length === 0) {
      return;
    }

    const parentChunk =
      evidenceChunkForDocumentText(document.id, parentName) ?? firstChunkForDocument(document.id);
    if (!parentChunk) {
      return;
    }
    const tableContextChunk = subsidiaryTableContextChunk(document.id) ?? parentChunk;
    const parent = entity(parentName, parentChunk);

    for (const row of tableRows) {
      const chunk = evidenceChunkForDocumentText(document.id, `${row.name} ${row.location}`);
      if (!chunk) {
        continue;
      }
      const child = entity(row.name, chunk);
      const location = entity(row.location, chunk, "location");
      relation("owns", parent.id, child.id, [parentChunk, chunk], 0.86);
      relation("registered_in", child.id, location.id, [tableContextChunk, chunk], 0.9);
    }
  }

  function extractFromChunk(chunk) {
    const text = normalizeWhitespace(chunk.text);
    if (!text) {
      return;
    }

    extractAliasDefinitions(chunk, text);
    extractOwnership(chunk, text);
  }

  function extractAliasDefinitions(chunk, text) {
    for (const match of text.matchAll(
      /(?<canonical>.{0,180}?)\s*\(\s*['"“](?<alias>[A-Z][A-Za-z0-9&.,' -]{1,60})['"”]\s*\)/gu
    )) {
      const canonicalName = entityNameBeforeAliasDefinition(match.groups?.canonical ?? "");
      const aliasName = cleanEntityName(match.groups?.alias ?? "");
      if (!isSafeExplicitAlias(canonicalName, aliasName)) {
        continue;
      }

      const aliasKey = stableEntityNameKey(aliasName);
      const canonicalKey = stableEntityNameKey(canonicalName);
      aliasDefinitionsByAliasKey.set(aliasKey, { canonicalName, aliasName, chunk });
      aliasesByCanonicalKey.set(canonicalKey, [
        ...new Set([...(aliasesByCanonicalKey.get(canonicalKey) ?? []), aliasName])
      ]);
    }
  }

  function extractOwnership(chunk, text) {
    for (const match of text.matchAll(
      /\b(?<parent>[A-Z][A-Za-z0-9&.,' -]{2,90}?)\s+(?:owns|controls|is the parent of|is parent of)\s+(?<child>[A-Z][A-Za-z0-9&.,' -]{2,90}?)(?=\.|;|,|\n|$)/giu
    )) {
      const parentName = cleanEntityName(match.groups?.parent ?? "");
      const childName = cleanEntityName(match.groups?.child ?? "");
      addOwnershipRelation(parentName, childName, chunk);
    }

    for (const match of text.matchAll(
      /(?<left>.{0,240}?)\s+is\s+(?:a\s+)?(?:(?:wholly|majority)[ -]owned\s+)?subsidiary\s+of\s+(?<parent>[A-Z][A-Za-z0-9&.,' -]{2,90}?)(?=\.|;|,|\n|$)/giu
    )) {
      const childName = entityNameBeforeRelation(match.groups?.left ?? "");
      const parentName = cleanEntityName(match.groups?.parent ?? "");
      addOwnershipRelation(parentName, childName, chunk);
    }
  }

  function addOwnershipRelation(parentName, childName, chunk) {
    if (!isLikelyEntityName(parentName) || !isLikelyEntityName(childName)) {
      return;
    }
    const parent = entity(parentName, chunk);
    const child = entity(childName, chunk);
    relation("owns", parent.id, child.id, chunk, 0.82);
  }

  function entity(name, chunk, kind = "legal_entity") {
    const aliasDefinition =
      kind === "legal_entity"
        ? aliasDefinitionsByAliasKey.get(stableEntityNameKey(name))
        : undefined;
    const canonicalName = aliasDefinition?.canonicalName ?? name;
    const normalized = normalizeEntityName(canonicalName);
    const canonicalAliasKey = stableEntityNameKey(canonicalName);
    const aliases = uniqueStrings([
      ...(aliasesByCanonicalKey.get(canonicalAliasKey) ?? []),
      ...(aliasDefinition === undefined ? [] : [aliasDefinition.aliasName])
    ]).filter((alias) => stableEntityNameKey(alias) !== canonicalAliasKey);
    const key = `${kind}:${canonicalAliasKey}`;
    const existing = entitiesByKey.get(key);
    if (existing) {
      if (aliases.length > 0) {
        existing.aliases = uniqueStrings([...(existing.aliases ?? []), ...aliases]);
      }
      if (aliasDefinition) {
        existing.evidence = uniqueEvidenceAnchors([
          ...existing.evidence,
          evidenceAnchor(aliasDefinition.chunk),
          evidenceAnchor(chunk)
        ]);
      }
      return existing;
    }

    const proposal = {
      id: `entity_${safeIdSegment(key)}`,
      namespaceId: options.request.profile.namespaceId,
      kind,
      name: canonicalName,
      normalizedName: normalized,
      ...(aliases.length === 0 ? {} : { aliases }),
      confidence: 0.8,
      trustTier: chunk.provenance.trustTier,
      accessScope: chunk.accessScope,
      evidence: uniqueEvidenceAnchors([
        ...(aliasDefinition === undefined ? [] : [evidenceAnchor(aliasDefinition.chunk)]),
        evidenceAnchor(chunk)
      ]),
      status: "approved",
      createdAt: options.createdAt,
      metadata: {
        extractor: "heuristic",
        ...(aliasDefinition === undefined ? {} : { aliasResolution: "explicit_parenthetical" })
      }
    };
    entitiesByKey.set(key, proposal);
    return proposal;
  }

  function relation(relationKind, sourceEntityId, targetEntityId, evidenceChunks, confidence) {
    if (sourceEntityId === targetEntityId) {
      return;
    }
    const chunks = uniqueChunks(Array.isArray(evidenceChunks) ? evidenceChunks : [evidenceChunks]);
    const primaryChunk = chunks[0];
    if (!primaryChunk) {
      return;
    }
    const key = `${relationKind}:${sourceEntityId}:${targetEntityId}`;
    const existing = relationsByKey.get(key);
    if (existing) {
      const evidenceByChunkId = new Map(
        existing.evidence.map((anchor) => [anchor.chunkId, anchor])
      );
      for (const chunk of chunks) {
        const anchor = evidenceAnchor(chunk);
        evidenceByChunkId.set(anchor.chunkId, anchor);
      }
      existing.evidence = [...evidenceByChunkId.values()];
      existing.confidence = Math.max(existing.confidence, confidence);
      return;
    }
    relationsByKey.set(key, {
      id: `relation_${safeIdSegment(key)}`,
      namespaceId: options.request.profile.namespaceId,
      relationKind,
      sourceEntityId,
      targetEntityId,
      factStrength: "explicit_fact",
      confidence,
      trustTier: primaryChunk.provenance.trustTier,
      accessScope: primaryChunk.accessScope,
      evidence: chunks.map(evidenceAnchor),
      temporal: { observedAt: options.createdAt },
      verificationStatus: "supported",
      status: "approved",
      createdAt: options.createdAt,
      metadata: { extractor: "heuristic" }
    });
  }

  return {
    extractFromDocument,
    extractFromChunk,
    batch() {
      return {
        id: options.extractionId,
        namespaceId: options.request.profile.namespaceId,
        ontology: options.ontology,
        entities: [...entitiesByKey.values()],
        relations: [...relationsByKey.values()],
        createdAt: options.createdAt
      };
    }
  };

  function evidenceChunkForDocumentText(documentId, text) {
    const normalizedNeedle = evidenceSearchText(text);
    if (!normalizedNeedle) {
      return undefined;
    }
    const chunks = chunksByDocumentId.get(documentId) ?? [];
    return chunks.find((chunk) => evidenceSearchText(chunk.text).includes(normalizedNeedle));
  }

  function firstChunkForDocument(documentId) {
    return (chunksByDocumentId.get(documentId) ?? [])[0];
  }

  function subsidiaryTableContextChunk(documentId) {
    return (
      evidenceChunkForDocumentText(
        documentId,
        "Name of Subsidiary Jurisdiction of Incorporation or Organization"
      ) ??
      evidenceChunkForDocumentText(documentId, "Company Name Domicile or State of Incorporation") ??
      evidenceChunkForDocumentText(documentId, "Name Where Incorporated")
    );
  }
}

function isSubsidiaryTableDocument(body) {
  return (
    /\bSUBSIDIARIES OF (?:THE )?REGISTRANT\b/u.test(body) ||
    /\bSubsidiaries of Registrant\b/u.test(body) ||
    /\bfollowing is a list of subsidiaries of\b/iu.test(body) ||
    /\bName of Subsidiary\s*\|\s*Jurisdiction of Incorporation or Organization\b/iu.test(body) ||
    /\bCompany Name\s*\|\s*(?:\S+\s*\|\s*)?Domicile or State of Incorporation\b/iu.test(body) ||
    /\bName\s*\|\s*Where Incorporated\b/iu.test(body)
  );
}

function subsidiaryTableParentName(document, body) {
  const listParent = body.match(
    /\bfollowing is a list of subsidiaries of (?<parent>[A-Z][A-Za-z0-9&.,' -]+?)(?:\s+as of|,|\.|\n|$)/iu
  )?.groups?.parent;
  if (listParent) {
    return cleanEntityName(listParent);
  }

  const lines = document.body
    .split(/\r?\n/u)
    .map((line) => cleanEntityName(line))
    .filter(Boolean);
  for (const [index, line] of lines.entries()) {
    if (!/^Subsidiaries of Registrant\b/iu.test(line)) {
      continue;
    }
    for (let previousIndex = index - 1; previousIndex >= 0; previousIndex -= 1) {
      const candidate = lines[previousIndex];
      if (isLikelyRegistrantName(candidate)) {
        return titleCaseEntityName(candidate);
      }
    }
  }

  const title = cleanEntityName(document.title || "");
  return title.length >= 3 ? title : undefined;
}

function subsidiaryTableRows(body) {
  const rows = [];
  for (const rawLine of body.split(/\r?\n/u)) {
    const line = normalizeWhitespace(rawLine);
    if (!line.includes("|")) {
      continue;
    }
    const columns = line
      .split("|")
      .map((column) => cleanEntityName(column.replace(/\u00a0/gu, " ")))
      .filter(Boolean);
    if (columns.length < 2) {
      continue;
    }
    const name = columns[0];
    const location = cleanLocationName(columns[columns.length - 1] ?? "");
    if (!isLikelySubsidiaryRow(name, location)) {
      continue;
    }
    rows.push({ name, location });
  }
  return rows;
}

function evidenceAnchor(chunk) {
  return {
    chunkId: chunk.id,
    documentId: chunk.documentId,
    sourceId: chunk.provenance.sourceId,
    citation: chunk.citation,
    quoteHash: chunk.textHash,
    characterStart: chunk.characterStart,
    characterEnd: chunk.characterEnd
  };
}

function uniqueChunks(chunks) {
  return [...new Map(chunks.map((chunk) => [chunk.id, chunk])).values()];
}

function uniqueStrings(values) {
  return [...new Map(values.map((value) => [stableEntityNameKey(value), value])).values()];
}

function uniqueEvidenceAnchors(anchors) {
  return [...new Map(anchors.map((anchor) => [anchor.chunkId, anchor])).values()];
}

function normalizeWhitespace(value) {
  return String(value ?? "")
    .replace(/\s+/gu, " ")
    .trim();
}

function evidenceSearchText(value) {
  return decodeTextEntities(String(value ?? ""))
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .replace(/[’‘]/gu, "'")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function cleanEntityName(value) {
  return decodeTextEntities(normalizeWhitespace(value))
    .replace(/^(?:and|or|a|an)\s+/iu, "")
    .replace(/\s+(?:and|or|a|an)$/iu, "")
    .replace(/["“”[\]{}]+/gu, "")
    .trim();
}

function entityNameBeforeRelation(value) {
  const fragment = lastSentenceFragment(value)
    .replace(/\s*\([^)]*\)\s*,?\s*$/gu, "")
    .replace(
      /^(?:the\s+)?(?:complainant|respondent|defendant|plaintiff|applicant|registrant|petitioner)s?,?\s+/iu,
      ""
    );
  return cleanEntityName(fragment).replace(/,+$/u, "").trim();
}

function entityNameBeforeAliasDefinition(value) {
  const fragment = lastSentenceFragment(value)
    .replace(
      /^(?:the\s+)?(?:complainant|respondent|defendant|plaintiff|applicant|registrant|petitioner)s?,?\s+/iu,
      ""
    )
    .replace(/,+$/u, "")
    .trim();
  const legalName = fragment.match(
    /(?<name>[A-Z][A-Za-z0-9&.' -]{1,90}(?:,\s*)?(?:Inc\.?|LLC|L\.L\.C\.|Corporation|Corp\.?|Company|Co\.?|Ltd\.?|Limited|PLC|S\.A\.|N\.V\.))$/u
  )?.groups?.name;
  return cleanEntityName(legalName ?? fragment)
    .replace(/,+$/u, "")
    .trim();
}

function isSafeExplicitAlias(canonicalName, aliasName) {
  if (!isLikelyEntityName(canonicalName) || !isLikelyEntityName(aliasName)) {
    return false;
  }
  if (!hasLegalEntitySuffix(canonicalName)) {
    return false;
  }
  if (stableEntityNameKey(canonicalName) === stableEntityNameKey(aliasName)) {
    return false;
  }
  if (aliasName.length > canonicalName.length) {
    return false;
  }
  return true;
}

function lastSentenceFragment(value) {
  const normalized = normalizeWhitespace(value);
  const boundary = Math.max(normalized.lastIndexOf(". "), normalized.lastIndexOf("; "));
  return boundary === -1 ? normalized : normalized.slice(boundary + 2).trim();
}

function cleanLocationName(value) {
  return cleanEntityName(value)
    .replace(/\s+(?:respectively|jurisdiction)$/iu, "")
    .trim();
}

function isLikelySubsidiaryRow(name, location) {
  if (!isLikelyEntityName(name) || !isLikelyLocationName(location)) {
    return false;
  }
  const combined = `${name} ${location}`;
  if (
    /\b(name|subsidiary|subsidiaries|jurisdiction|where incorporated|domicile|state of incorporation|company name)\b/iu.test(
      combined
    )
  ) {
    return false;
  }
  return true;
}

function isLikelyEntityName(value) {
  if (value.length < 3 || value.length > 100) {
    return false;
  }
  if (!/[A-Za-z]/u.test(value)) {
    return false;
  }
  if (/^(?:the|and|or|company|subsidiary|subsidiaries|jurisdiction|state|country)$/iu.test(value)) {
    return false;
  }
  return true;
}

function isLikelyRegistrantName(value) {
  if (!isLikelyEntityName(value)) {
    return false;
  }
  if (/^(?:ex-\d|item \d|reg\. s-k|document|exhibit \d|december \d)/iu.test(value)) {
    return false;
  }
  return /\b(?:inc\.?|corporation|corp\.?|company|llc|l\.p\.|plc\.?)\b/iu.test(value);
}

function hasLegalEntitySuffix(value) {
  return /\b(?:inc\.?|corporation|corp\.?|company|co\.?|llc|l\.l\.c\.|ltd\.?|limited|plc|s\.a\.|n\.v\.)\b/iu.test(
    value
  );
}

function isLikelyLocationName(value) {
  if (value.length < 2 || value.length > 80) {
    return false;
  }
  if (!/[A-Za-z]/u.test(value)) {
    return false;
  }
  if (/[|@]/u.test(value)) {
    return false;
  }
  return true;
}

function titleCaseEntityName(value) {
  return value
    .toLowerCase()
    .replace(/\b([a-z])/gu, (match) => match.toUpperCase())
    .replace(/\b(Inc|Llc|Lp|Plc|Corp)\b/gu, (match) => match.toUpperCase().replace("LLC", "LLC"))
    .replace(/\bL\.p\./giu, "L.P.")
    .replace(/\bInc\./giu, "Inc.")
    .replace(/\bCorp\./giu, "Corp.");
}

function decodeTextEntities(value) {
  const namedEntities = {
    amp: "&",
    agrave: "à",
    egrave: "è",
    eacute: "é",
    nbsp: " ",
    ouml: "ö"
  };
  return value
    .replace(/&([a-z]+);/giu, (match, name) => namedEntities[name.toLowerCase()] ?? match)
    .replace(/&#(\d+);/gu, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/giu, (_match, code) => String.fromCodePoint(parseInt(code, 16)));
}

function safeIdSegment(value) {
  const hash = createHash("sha256")
    .update(String(value ?? ""), "utf8")
    .digest("hex")
    .slice(0, 12);
  const prefix =
    String(value ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "_")
      .replace(/^_+|_+$/gu, "")
      .slice(0, 80) || "fact";
  return `${prefix}_${hash}`;
}

function stableEntityNameKey(value) {
  return decodeTextEntities(String(value ?? ""))
    .toLowerCase()
    .replace(/[’‘]/gu, "'")
    .replace(/\s+/gu, " ")
    .trim();
}
