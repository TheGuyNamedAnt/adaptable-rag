import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { sampleSupportProfile } from "../profiles/examples/sample-support.profile.js";
import { genericDocsProfile } from "../profiles/examples/generic-docs.profile.js";
import { ultimateDefaultProfile } from "../profiles/presets/ultimate-default.profile.js";
import type { RagProfile } from "../profiles/profile.js";
import {
  loadJsonlEvalCases,
  RagEvalParseError,
  runProfileEvalSuites,
  runProfileEvalSuite
} from "./eval-runner.js";

test("declared profile eval suites pass and cover every required check", async () => {
  const summary = await runProfileEvalSuites({
    profiles: [genericDocsProfile, sampleSupportProfile, ultimateDefaultProfile],
    projectRoot: process.cwd()
  });

  assert.equal(summary.passed, true, summary.failures.join("\n"));
  assert.equal(summary.suiteCount, 3);
  assert.equal(summary.caseCount, 20);
  for (const suite of summary.suites) {
    assert.deepEqual(suite.missingRequiredChecks, []);
    assert.ok(suite.cases.every((evalCase) => evalCase.passed));
  }
});

test("profile eval suite fails when declared required checks are not covered", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "rag-evals-"));
  try {
    await writeFile(
      path.join(tempDir, "golden.jsonl"),
      `${JSON.stringify(minimalPassingCase("missing-check-coverage"))}\n`
    );
    await writeFile(
      path.join(tempDir, "adversarial.jsonl"),
      `${JSON.stringify(minimalPassingCase("missing-check-coverage-adversarial"))}\n`
    );

    const profile: RagProfile = {
      ...genericDocsProfile,
      evals: {
        ...genericDocsProfile.evals,
        goldenSetPath: path.join(tempDir, "golden.jsonl"),
        adversarialSetPath: path.join(tempDir, "adversarial.jsonl")
      }
    };
    const suite = await runProfileEvalSuite({ profile, projectRoot: process.cwd() });

    assert.equal(suite.passed, false);
    assert.ok(suite.missingRequiredChecks.includes("refusal_when_unsupported"));
    assert.ok(suite.missingRequiredChecks.includes("access_boundary"));
    assert.ok(suite.missingRequiredChecks.includes("prompt_injection_resistance"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("JSONL eval parser reports file and line for malformed cases", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "rag-evals-"));
  const filePath = path.join(tempDir, "bad.jsonl");
  try {
    await writeFile(filePath, '\n{"id":"ok"}\n{not-json}\n');
    await assert.rejects(
      () => loadJsonlEvalCases(filePath),
      (error: unknown) =>
        error instanceof RagEvalParseError && error.filePath === filePath && error.lineNumber === 2
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("JSONL eval parser preserves visual mode and layout evidence", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "rag-evals-"));
  const filePath = path.join(tempDir, "visual.jsonl");
  try {
    await writeFile(filePath, `${JSON.stringify(visualEvalCase("visual-parser"))}\n`);

    const cases = await loadJsonlEvalCases(filePath);

    assert.equal(cases[0]?.retrievalMode, "visual");
    assert.equal(cases[0]?.expect.requiredRetrievalMode, "visual");
    assert.equal(cases[0]?.expect.minimumVisualCitations, 1);
    assert.deepEqual(cases[0]?.expect.requiredCitationLayoutRegionIds, ["region_visual_eval"]);
    assert.equal(cases[0]?.corpus[0]?.layout?.regions[0]?.id, "region_visual_eval");
    assert.equal(cases[0]?.corpus[0]?.layout?.visualAssets?.[0]?.id, "asset_visual_eval");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("JSONL eval parser preserves layout relations", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "rag-evals-"));
  const filePath = path.join(tempDir, "relations.jsonl");
  try {
    await writeFile(filePath, `${JSON.stringify(layoutRelationEvalCase("relation-parser"))}\n`);

    const cases = await loadJsonlEvalCases(filePath);

    assert.equal(cases[0]?.checks.includes("layout_relation_recall"), true);
    assert.equal(cases[0]?.expect.requiredLayoutRelationIds?.[0], "relation_explains_figure");
    assert.equal(cases[0]?.corpus[0]?.layout?.relations?.[0]?.kind, "explains");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("JSONL eval parser preserves knowledge-map fixtures", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "rag-evals-"));
  const filePath = path.join(tempDir, "knowledge-map.jsonl");
  try {
    await writeFile(filePath, `${JSON.stringify(knowledgeMapEvalCase("knowledge-map-parser"))}\n`);

    const cases = await loadJsonlEvalCases(filePath);

    assert.equal(cases[0]?.checks.includes("relationship_claim_grounding"), true);
    assert.equal(cases[0]?.knowledgeMap?.entities[0]?.id, "entity_parent");
    assert.equal(cases[0]?.knowledgeMap?.relations[0]?.relationKind, "owns");
    assert.equal(
      cases[0]?.expect.requiredRelationshipPaths?.[0]?.edges[0]?.fromEntityId,
      "entity_parent"
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("JSONL eval parser preserves extraction-quality fixtures", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "rag-evals-"));
  const filePath = path.join(tempDir, "extraction-quality.jsonl");
  try {
    await writeFile(filePath, `${JSON.stringify(extractionQualityEvalCase("extract-parser"))}\n`);

    const cases = await loadJsonlEvalCases(filePath);

    assert.equal(cases[0]?.checks.includes("extraction_quality"), true);
    assert.equal(cases[0]?.extraction?.expectedEntities[0]?.id, "entity_parent");
    assert.equal(cases[0]?.extraction?.expectedRelations[0]?.relationKind, "owns");
    assert.equal(cases[0]?.extraction?.forbiddenRelations?.[0]?.toName, "Operating LLC");
    assert.equal(cases[0]?.extraction?.minimumRelationRecall, 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("JSONL eval parser preserves query planning and evidence strategy expectations", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "rag-evals-"));
  const filePath = path.join(tempDir, "planner.jsonl");
  try {
    await writeFile(
      filePath,
      `${JSON.stringify(queryPlanningEvalCase("planner-parser", { requiredGraphRoute: "graph_optional" }))}\n`
    );

    const cases = await loadJsonlEvalCases(filePath);

    assert.equal(cases[0]?.checks.includes("query_planning"), true);
    assert.equal(cases[0]?.expect.requiredPrimaryIntent, "freshness");
    assert.deepEqual(cases[0]?.expect.requiredSecondaryIntents, ["troubleshooting"]);
    assert.deepEqual(cases[0]?.expect.requiredSourceHints, ["recent", "support"]);
    assert.equal(cases[0]?.expect.requiredGraphRoute, "graph_optional");
    assert.equal(cases[0]?.expect.requiredAdaptiveRetryStrategy, "freshness_expansion");
    assert.equal(cases[0]?.expect.requiredAdaptiveDiagnosisCode, "freshness_requested");
    assert.equal(cases[0]?.expect.requiredFreshnessTraceApplied, true);
    assert.equal(cases[0]?.expect.minimumFreshnessBoostedCandidates, 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("runtime evals can enforce layout relation recall and table caption preservation", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "rag-evals-"));
  try {
    const existingGolden = await readFile("profiles/generic-docs/evals/golden.jsonl", "utf8");
    const existingAdversarial = await readFile(
      "profiles/generic-docs/evals/adversarial.jsonl",
      "utf8"
    );
    await writeFile(
      path.join(tempDir, "golden.jsonl"),
      `${existingGolden.trim()}\n${JSON.stringify(
        layoutRelationEvalCase("relation-recall")
      )}\n${JSON.stringify(tableCaptionEvalCase("table-caption"))}\n`
    );
    await writeFile(path.join(tempDir, "adversarial.jsonl"), `${existingAdversarial.trim()}\n`);
    const profile: RagProfile = {
      ...genericDocsProfile,
      evals: {
        ...genericDocsProfile.evals,
        goldenSetPath: path.join(tempDir, "golden.jsonl"),
        adversarialSetPath: path.join(tempDir, "adversarial.jsonl"),
        requiredChecks: [
          ...genericDocsProfile.evals.requiredChecks,
          "layout_relation_recall",
          "table_caption_preservation"
        ]
      }
    };

    const suite = await runProfileEvalSuite({ profile, projectRoot: process.cwd() });

    assert.equal(suite.passed, true, suite.failures.join("\n"));
    assert.equal(suite.coveredChecks.includes("layout_relation_recall"), true);
    assert.equal(suite.coveredChecks.includes("table_caption_preservation"), true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("runtime evals can enforce query planning expectations", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "rag-evals-"));
  try {
    const existingAdversarial = await readFile(
      "profiles/generic-docs/evals/adversarial.jsonl",
      "utf8"
    );
    await writeFile(
      path.join(tempDir, "golden.jsonl"),
      `${JSON.stringify(
        queryPlanningEvalCase("planner-runtime", {
          requiredAdaptiveRetryStrategy: undefined,
          requiredAdaptiveDiagnosisCode: undefined
        })
      )}\n`
    );
    await writeFile(path.join(tempDir, "adversarial.jsonl"), `${existingAdversarial.trim()}\n`);
    const profile: RagProfile = {
      ...genericDocsProfile,
      evals: {
        ...genericDocsProfile.evals,
        goldenSetPath: path.join(tempDir, "golden.jsonl"),
        adversarialSetPath: path.join(tempDir, "adversarial.jsonl"),
        requiredChecks: [
          ...genericDocsProfile.evals.requiredChecks,
          "query_planning",
          "evidence_strategy"
        ]
      }
    };

    const suite = await runProfileEvalSuite({ profile, projectRoot: process.cwd() });

    assert.equal(suite.passed, true, suite.failures.join("\n"));
    assert.equal(suite.coveredChecks.includes("query_planning"), true);
    assert.equal(suite.coveredChecks.includes("evidence_strategy"), true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("runtime evals can enforce extraction quality", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "rag-evals-"));
  try {
    const existingAdversarial = await readFile(
      "profiles/generic-docs/evals/adversarial.jsonl",
      "utf8"
    );
    await writeFile(
      path.join(tempDir, "golden.jsonl"),
      `${JSON.stringify(extractionQualityEvalCase("extract-runtime"))}\n`
    );
    await writeFile(path.join(tempDir, "adversarial.jsonl"), `${existingAdversarial.trim()}\n`);
    const profile: RagProfile = {
      ...genericDocsProfile,
      evals: {
        ...genericDocsProfile.evals,
        goldenSetPath: path.join(tempDir, "golden.jsonl"),
        adversarialSetPath: path.join(tempDir, "adversarial.jsonl"),
        requiredChecks: [
          "retrieval_recall",
          "citation_required",
          "refusal_when_unsupported",
          "access_boundary",
          "prompt_injection_resistance",
          "extraction_quality"
        ]
      }
    };

    const suite = await runProfileEvalSuite({ profile, projectRoot: process.cwd() });

    assert.equal(suite.passed, true, suite.failures.join("\n"));
    assert.equal(suite.coveredChecks.includes("extraction_quality"), true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("runtime evals fail extraction quality for missing or invented relationships", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "rag-evals-"));
  try {
    const existingAdversarial = await readFile(
      "profiles/generic-docs/evals/adversarial.jsonl",
      "utf8"
    );
    await writeFile(
      path.join(tempDir, "golden.jsonl"),
      `${JSON.stringify(
        extractionQualityEvalCase("extract-runtime-fail", {
          actualEntities: [
            {
              id: "entity_parent_actual",
              kind: "legal_entity",
              name: "Parent LLC",
              evidenceDocumentIds: ["extract-runtime-fail_ownership_doc"]
            },
            {
              id: "entity_operating_actual",
              kind: "legal_entity",
              name: "Operating LLC",
              evidenceDocumentIds: ["extract-runtime-fail_ownership_doc"]
            }
          ],
          actualRelations: [
            {
              id: "rel_invented_parent_operating",
              relationKind: "owns",
              sourceEntityId: "entity_parent_actual",
              targetEntityId: "entity_operating_actual",
              evidenceDocumentIds: ["extract-runtime-fail_ownership_doc"]
            }
          ]
        })
      )}\n`
    );
    await writeFile(path.join(tempDir, "adversarial.jsonl"), `${existingAdversarial.trim()}\n`);
    const profile: RagProfile = {
      ...genericDocsProfile,
      evals: {
        ...genericDocsProfile.evals,
        goldenSetPath: path.join(tempDir, "golden.jsonl"),
        adversarialSetPath: path.join(tempDir, "adversarial.jsonl"),
        requiredChecks: [
          "retrieval_recall",
          "citation_required",
          "refusal_when_unsupported",
          "access_boundary",
          "prompt_injection_resistance",
          "extraction_quality"
        ]
      }
    };

    const suite = await runProfileEvalSuite({ profile, projectRoot: process.cwd() });

    assert.equal(suite.passed, false);
    assert.ok(suite.failures.some((failure) => failure.includes("relation recall")));
    assert.ok(suite.failures.some((failure) => failure.includes("extra relation")));
    assert.ok(suite.failures.some((failure) => failure.includes("forbidden relation")));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("runtime evals can enforce relationship claim grounding from a JSONL knowledge map", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "rag-evals-"));
  try {
    const existingAdversarial = await readFile(
      "profiles/generic-docs/evals/adversarial.jsonl",
      "utf8"
    );
    await writeFile(
      path.join(tempDir, "golden.jsonl"),
      `${JSON.stringify(knowledgeMapEvalCase("relationship-grounding-runtime"))}\n`
    );
    await writeFile(path.join(tempDir, "adversarial.jsonl"), `${existingAdversarial.trim()}\n`);
    const profile: RagProfile = {
      ...genericDocsProfile,
      evals: {
        ...genericDocsProfile.evals,
        goldenSetPath: path.join(tempDir, "golden.jsonl"),
        adversarialSetPath: path.join(tempDir, "adversarial.jsonl"),
        requiredChecks: [
          "retrieval_recall",
          "citation_required",
          "refusal_when_unsupported",
          "access_boundary",
          "prompt_injection_resistance",
          "relationship_claim_grounding"
        ]
      }
    };

    const suite = await runProfileEvalSuite({ profile, projectRoot: process.cwd() });

    assert.equal(suite.passed, true, suite.failures.join("\n"));
    assert.equal(suite.coveredChecks.includes("relationship_claim_grounding"), true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("JSONL eval parser rejects invalid visual layout enums", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "rag-evals-"));
  const filePath = path.join(tempDir, "bad-visual.jsonl");
  try {
    await writeFile(
      filePath,
      `${JSON.stringify(
        visualEvalCase("visual-parser-bad", {
          strategy: "unsupported_visual_strategy"
        })
      )}\n`
    );

    await assert.rejects(
      () => loadJsonlEvalCases(filePath),
      (error: unknown) =>
        error instanceof RagEvalParseError && error.filePath === filePath && error.lineNumber === 1
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

function minimalPassingCase(id: string): unknown {
  return {
    id,
    checks: ["retrieval_recall", "citation_required"],
    query: "What does the deployment approval policy require before release?",
    principal: {
      userId: "eval_user",
      tenantId: "tenant_eval",
      namespaceIds: ["generic-docs"],
      teamIds: ["docs"],
      roles: ["reader"],
      tags: ["curated"]
    },
    corpus: [
      {
        id: `${id}_doc`,
        sourceId: "curated_docs",
        sourceKind: "local_file",
        title: "Deployment Approval Policy",
        body: "Deployment approval policy: every release requires a change owner, rollback note, and approval recorded before release.",
        trustTier: "trusted_internal",
        sensitivity: "internal",
        accessScope: {
          tenantId: "tenant_eval",
          namespaceId: "generic-docs",
          teamIds: ["docs"],
          roles: ["reader"],
          tags: ["curated"]
        },
        capturedAt: "2026-06-20T00:00:00.000Z"
      }
    ],
    expect: {
      status: "succeeded",
      retrievedDocumentIds: [`${id}_doc`],
      minimumCitations: 1,
      requiredContextStatus: "answerable"
    }
  };
}

function visualEvalCase(id: string, layoutOverrides: Record<string, unknown> = {}): unknown {
  const body =
    "Visual eval page evidence: dashboard screenshot shows overdue invoices and review status.";
  const box = {
    pageNumber: 1,
    x: 10,
    y: 20,
    width: 400,
    height: 220,
    unit: "pixel"
  };

  return {
    id,
    checks: ["visual_retrieval"],
    retrievalMode: "visual",
    query: "What does the dashboard screenshot show?",
    principal: {
      userId: "eval_user",
      tenantId: "tenant_eval",
      namespaceIds: ["generic-docs"],
      teamIds: ["docs"],
      roles: ["reader"],
      tags: ["curated"]
    },
    corpus: [
      {
        id: `${id}_doc`,
        sourceId: "curated_docs",
        sourceKind: "local_file",
        title: "Dashboard Screenshot",
        body,
        trustTier: "trusted_internal",
        sensitivity: "internal",
        accessScope: {
          tenantId: "tenant_eval",
          namespaceId: "generic-docs",
          teamIds: ["docs"],
          roles: ["reader"],
          tags: ["curated"]
        },
        capturedAt: "2026-06-20T00:00:00.000Z",
        layout: {
          parserId: "test-layout-parser",
          strategy: "visual_page",
          pages: [
            {
              pageNumber: 1,
              width: 500,
              height: 300,
              unit: "pixel",
              visualAssetId: "asset_visual_eval"
            }
          ],
          regions: [
            {
              id: "region_visual_eval",
              kind: "page_image",
              pageNumber: 1,
              box,
              text: body,
              characterStart: 0,
              characterEnd: body.length
            }
          ],
          visualAssets: [
            {
              id: "asset_visual_eval",
              kind: "page_image",
              pageNumber: 1,
              mediaType: "image/png",
              uri: "memory://visual-eval.png",
              box
            }
          ],
          ...layoutOverrides
        }
      }
    ],
    expect: {
      status: "succeeded",
      retrievedDocumentIds: [`${id}_doc`],
      requiredRetrievalMode: "visual",
      minimumVisualCitations: 1,
      requiredCitationLayoutRegionIds: ["region_visual_eval"]
    }
  };
}

function layoutRelationEvalCase(id: string): unknown {
  const body =
    "Figure 1: Ownership chart\n\nThe page two explanation says Parent LLC owns Child LLC.";
  const caption = "Figure 1: Ownership chart";
  const explanation = "The page two explanation says Parent LLC owns Child LLC.";
  const explanationStart = body.indexOf(explanation);

  return {
    id,
    checks: ["retrieval_recall", "citation_required", "layout_relation_recall"],
    query: "What does the ownership chart explanation say?",
    principal: evalPrincipal(),
    corpus: [
      {
        ...evalCorpusBase(`${id}_doc`, "Ownership Chart Evidence", body),
        layout: {
          parserId: "test-layout-parser",
          strategy: "hybrid",
          pages: [
            { pageNumber: 1, width: 600, height: 800, unit: "point" },
            { pageNumber: 2, width: 600, height: 800, unit: "point" }
          ],
          regions: [
            {
              id: "region_caption",
              kind: "figure_caption",
              pageNumber: 1,
              text: caption,
              characterStart: 0,
              characterEnd: caption.length,
              box: { pageNumber: 1, x: 40, y: 500, width: 300, height: 30, unit: "point" }
            },
            {
              id: "region_figure",
              kind: "figure",
              pageNumber: 1,
              box: { pageNumber: 1, x: 40, y: 100, width: 420, height: 360, unit: "point" }
            },
            {
              id: "region_explanation",
              kind: "paragraph",
              pageNumber: 2,
              text: explanation,
              characterStart: explanationStart,
              characterEnd: explanationStart + explanation.length,
              box: { pageNumber: 2, x: 40, y: 100, width: 420, height: 80, unit: "point" }
            }
          ],
          relations: [
            {
              id: "relation_explains_figure",
              kind: "explains",
              fromRegionId: "region_explanation",
              toRegionId: "region_figure"
            },
            {
              id: "relation_caption_for_figure",
              kind: "caption_for",
              fromRegionId: "region_caption",
              toRegionId: "region_figure"
            }
          ]
        }
      }
    ],
    expect: {
      status: "succeeded",
      retrievedDocumentIds: [`${id}_doc`],
      minimumCitations: 1,
      requiredContextStatus: "answerable",
      requiredCitationLayoutRegionIds: ["region_caption", "region_figure", "region_explanation"],
      requiredLayoutRelationIds: ["relation_explains_figure"]
    }
  };
}

function tableCaptionEvalCase(id: string): unknown {
  const prefix = "Investor | Shares\nAcme LLC | 100\nBeta LLC | 50";
  const caption = "Source: approved cap table.";
  const body = `${prefix}\n\n${caption}`;
  const captionStart = body.indexOf(caption);

  return {
    id,
    checks: ["retrieval_recall", "citation_required", "table_caption_preservation"],
    query: "What is the source for the cap table?",
    principal: evalPrincipal(),
    corpus: [
      {
        ...evalCorpusBase(`${id}_doc`, "Cap Table", body),
        layout: {
          parserId: "test-layout-parser",
          strategy: "table_structure",
          pages: [{ pageNumber: 1, width: 600, height: 800, unit: "point" }],
          regions: [
            {
              id: "region_table",
              kind: "table",
              pageNumber: 1,
              text: prefix,
              characterStart: 0,
              characterEnd: prefix.length,
              box: { pageNumber: 1, x: 40, y: 100, width: 420, height: 160, unit: "point" }
            },
            {
              id: "region_table_caption",
              kind: "table_caption",
              pageNumber: 1,
              text: caption,
              characterStart: captionStart,
              characterEnd: captionStart + caption.length,
              box: { pageNumber: 1, x: 40, y: 280, width: 260, height: 30, unit: "point" }
            }
          ],
          relations: [
            {
              id: "relation_caption_for_table",
              kind: "caption_for",
              fromRegionId: "region_table_caption",
              toRegionId: "region_table"
            }
          ],
          tables: [
            {
              id: "table_1",
              pageNumber: 1,
              regionId: "region_table",
              captionRegionId: "region_table_caption",
              cells: [
                { rowIndex: 0, columnIndex: 0, text: "Investor" },
                { rowIndex: 0, columnIndex: 1, text: "Shares" }
              ]
            }
          ]
        }
      }
    ],
    expect: {
      status: "succeeded",
      retrievedDocumentIds: [`${id}_doc`],
      minimumCitations: 1,
      requiredContextStatus: "answerable",
      requiredCitationLayoutRegionIds: ["region_table", "region_table_caption"],
      requiredLayoutRelationIds: ["relation_caption_for_table"]
    }
  };
}

function knowledgeMapEvalCase(id: string): unknown {
  return {
    id,
    checks: ["retrieval_recall", "citation_required", "relationship_claim_grounding"],
    query: "Who owns Child LLC?",
    principal: evalPrincipal(),
    corpus: [
      evalCorpusBase(
        `${id}_ownership_doc`,
        "Ownership Evidence",
        "Ownership evidence: Parent LLC owns Child LLC under the operating agreement."
      )
    ],
    knowledgeMap: {
      entities: [
        {
          id: "entity_parent",
          kind: "legal_entity",
          name: "Parent LLC",
          evidenceDocumentIds: [`${id}_ownership_doc`]
        },
        {
          id: "entity_child",
          kind: "legal_entity",
          name: "Child LLC",
          evidenceDocumentIds: [`${id}_ownership_doc`]
        }
      ],
      relations: [
        {
          id: "rel_parent_child",
          relationKind: "owns",
          sourceEntityId: "entity_parent",
          targetEntityId: "entity_child",
          evidenceDocumentIds: [`${id}_ownership_doc`]
        }
      ]
    },
    expect: {
      status: "succeeded",
      retrievedDocumentIds: [`${id}_ownership_doc`],
      minimumCitations: 1,
      requiredContextStatus: "answerable",
      requiredRelationshipPaths: [
        {
          depth: 1,
          requireEdgeEvidence: true,
          edges: [
            {
              relationType: "owns",
              fromEntityId: "entity_parent",
              toEntityId: "entity_child"
            }
          ]
        }
      ]
    }
  };
}

function extractionQualityEvalCase(
  id: string,
  extractionOverrides: Record<string, unknown> = {}
): unknown {
  return {
    id,
    checks: ["retrieval_recall", "citation_required", "extraction_quality"],
    query: "What ownership relationship is stated?",
    principal: evalPrincipal(),
    corpus: [
      evalCorpusBase(
        `${id}_ownership_doc`,
        "Ownership Evidence",
        "Extraction evidence: Parent LLC owns Child LLC. Operating LLC is mentioned but no ownership edge is stated."
      )
    ],
    extraction: {
      expectedEntities: [
        {
          id: "entity_parent",
          kind: "legal_entity",
          name: "Parent LLC",
          evidenceDocumentIds: [`${id}_ownership_doc`]
        },
        {
          id: "entity_child",
          kind: "legal_entity",
          name: "Child LLC",
          evidenceDocumentIds: [`${id}_ownership_doc`]
        }
      ],
      expectedRelations: [
        {
          id: "rel_parent_child",
          relationKind: "owns",
          sourceEntityId: "entity_parent",
          targetEntityId: "entity_child",
          evidenceDocumentIds: [`${id}_ownership_doc`]
        }
      ],
      forbiddenRelations: [
        {
          relationType: "owns",
          fromName: "Parent LLC",
          toName: "Operating LLC"
        }
      ],
      minimumEntityRecall: 1,
      minimumRelationRecall: 1,
      maximumExtraEntities: 0,
      maximumExtraRelations: 0,
      ...extractionOverrides
    },
    expect: {
      status: "succeeded",
      retrievedDocumentIds: [`${id}_ownership_doc`],
      minimumCitations: 1,
      requiredContextStatus: "answerable"
    }
  };
}

function queryPlanningEvalCase(id: string, expectOverrides: Record<string, unknown> = {}): unknown {
  return {
    id,
    checks: ["retrieval_recall", "citation_required", "query_planning", "evidence_strategy"],
    query: "What is the latest API timeout error issue?",
    principal: evalPrincipal(),
    corpus: [
      {
        ...evalCorpusBase(
          `${id}_support_doc`,
          "Support Incident",
          "Latest support incident: API timeout errors were resolved by increasing the upstream retry budget."
        ),
        capturedAt: "2026-06-22T00:00:00.000Z"
      },
      {
        ...evalCorpusBase(
          `${id}_older_support_doc`,
          "Older Support Incident",
          "Latest support incident: API timeout errors were investigated before the retry budget change."
        ),
        capturedAt: "2026-01-01T00:00:00.000Z"
      }
    ],
    expect: {
      status: "succeeded",
      retrievedDocumentIds: [`${id}_support_doc`],
      minimumCitations: 1,
      requiredContextStatus: "answerable",
      requiredPrimaryIntent: "freshness",
      requiredSecondaryIntents: ["troubleshooting"],
      requiredSourceHints: ["recent", "support"],
      requiredAdaptiveRetryStrategy: "freshness_expansion",
      requiredAdaptiveDiagnosisCode: "freshness_requested",
      requiredFreshnessTraceApplied: true,
      minimumFreshnessBoostedCandidates: 1,
      ...expectOverrides
    }
  };
}

function evalPrincipal(): unknown {
  return {
    userId: "eval_user",
    tenantId: "tenant_eval",
    namespaceIds: ["generic-docs"],
    teamIds: ["docs"],
    roles: ["reader"],
    tags: ["curated"]
  };
}

function evalCorpusBase(id: string, title: string, body: string): Record<string, unknown> {
  return {
    id,
    sourceId: "curated_docs",
    sourceKind: "local_file",
    title,
    body,
    trustTier: "trusted_internal",
    sensitivity: "internal",
    accessScope: {
      tenantId: "tenant_eval",
      namespaceId: "generic-docs",
      teamIds: ["docs"],
      roles: ["reader"],
      tags: ["curated"]
    },
    capturedAt: "2026-06-20T00:00:00.000Z"
  };
}
