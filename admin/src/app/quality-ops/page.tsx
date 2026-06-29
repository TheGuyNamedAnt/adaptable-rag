import { Activity, BarChart3, RefreshCw, Terminal, UploadCloud } from "lucide-react";
import {
  CollapsibleSection,
  EmptyState,
  IconLink,
  MetricCard,
  NoticeBanner,
  PageGuide,
  PageHeader,
  RelatedPageLinks,
  SectionCard,
  StatusPill
} from "@/components/ui";
import { GenerationPromotionPanel } from "@/components/GenerationPromotionPanel";
import { formatNumber, formatTime, statusTone, truncateMiddle } from "@/lib/format";
import {
  getQualityOpsArtifacts,
  type DocumentQaBenchmarkArtifact,
  type EmbeddingMigrationArtifact,
  type IngestionIntegrityArtifact,
  type ParserBenchmarkArtifact,
  type ParserExtractionAuditArtifact,
  type ParserQualityArtifact,
  type ProviderSmokeArtifact,
  type QualityOpsArtifactReadState,
  type QualityOpsArtifactPaths,
  type VectorCleanupArtifact
} from "@/lib/quality-ops-artifacts";
import { getIndexGenerations } from "@/lib/rag-admin-api";

export default async function QualityOpsPage() {
  const [artifacts, generationsResult] = await Promise.all([
    getQualityOpsArtifacts(),
    getIndexGenerations({ limit: 40 })
  ]);
  const artifactStates = [
    artifactState(artifacts.artifactStates.parserBenchmark, artifacts.parserBenchmark?.status),
    artifactState(
      artifacts.artifactStates.documentQaBenchmark,
      artifacts.documentQaBenchmark?.status
    ),
    artifactState(
      artifacts.artifactStates.parserExtractionAudit,
      artifacts.parserExtractionAudit?.status
    ),
    artifactState(artifacts.artifactStates.parserQuality, artifacts.parserQuality?.status),
    artifactState(
      artifacts.artifactStates.ingestionIntegrity,
      artifacts.ingestionIntegrity?.status
    ),
    artifactState(
      artifacts.artifactStates.embeddingMigration,
      artifacts.embeddingMigration?.status
    ),
    artifactState(artifacts.artifactStates.providerSmoke, artifacts.providerSmoke?.status),
    artifactState(artifacts.artifactStates.vectorCleanup, artifacts.vectorCleanup?.mode)
  ];
  const availableCount = artifactStates.filter((state) => state.available).length;
  const invalidStates = artifactStates.filter((state) => state.invalid);
  const failingCount = artifactStates.filter((state) => state.failing).length;

  return (
    <div className="min-h-screen bg-background">
      <PageHeader
        eyebrow="Verify"
        title="Quality Artifacts"
        description="Generated benchmark, parser quality, provider smoke, ingestion integrity, migration, and cleanup reports."
        actions={
          <>
            <IconLink href="/evals" icon={BarChart3} label="Regression Tests" />
            <IconLink href="/quality-ops" icon={RefreshCw} label="Refresh" />
          </>
        }
      />

      <main className="mx-auto max-w-6xl space-y-4 px-4 py-4">
        {availableCount === 0 ? (
          <NoticeBanner
            title="No quality-operation artifacts yet"
            message="Run one of the benchmark, integrity, migration, or cleanup scripts to populate the artifact cards below."
          />
        ) : null}
        {invalidStates.length > 0 ? (
          <NoticeBanner
            title="Invalid quality artifact"
            message={`${invalidStates[0].label} could not be parsed at ${invalidStates[0].path}: ${invalidStates[0].error ?? "unknown parse error"}`}
            tone="error"
          />
        ) : null}

        <PageGuide
          title="Use this to inspect generated quality artifacts"
          description="Quality Artifacts collects parser benchmarks, document QA, ingestion integrity, provider smoke, migration, and cleanup reports. Missing means the command has not produced that artifact yet."
          steps={[
            "Start with invalid and failing counts.",
            "Run the command shown beside missing artifacts.",
            "Use Regression Tests for answer-quality pass/fail."
          ]}
          tone={
            invalidStates.length || failingCount
              ? "error"
              : availableCount === 0
                ? "warning"
                : "primary"
          }
        />

        <RelatedPageLinks
          description="Quality Artifacts is the report library. These pages either create the data behind the reports or use the reports as release gates."
          links={[
            {
              href: "/evals",
              icon: BarChart3,
              label: "Regression Tests",
              detail:
                "The answer-quality pass/fail view built from the latest evaluation artifacts."
            },
            {
              href: "/slos",
              icon: Activity,
              label: "Reliability",
              detail:
                "Operational gates that decide whether live traffic is healthy enough to promote."
            },
            {
              href: "/ingestion",
              icon: UploadCloud,
              label: "Add Knowledge",
              detail:
                "Run new uploads or connector syncs before checking parser and ingestion artifacts."
            }
          ]}
        />

        <SectionCard
          title="Artifact Summary"
          description={`Generated ${formatTime(artifacts.generatedAt)}`}
        >
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-6">
            <MetricCard label="Available" value={formatNumber(availableCount)} tone="primary" />
            <MetricCard
              label="Missing"
              value={formatNumber(artifactStates.length - availableCount)}
              tone={availableCount === artifactStates.length ? "default" : "warning"}
            />
            <MetricCard
              label="Failing"
              value={formatNumber(failingCount)}
              tone={failingCount ? "error" : "default"}
            />
            <MetricCard
              label="Invalid"
              value={formatNumber(invalidStates.length)}
              tone={invalidStates.length ? "error" : "default"}
            />
            <MetricCard
              label="Parser cases"
              value={formatNumber(artifacts.parserBenchmark?.caseCount)}
            />
            <MetricCard
              label="Document QA cases"
              value={formatNumber(artifacts.documentQaBenchmark?.caseCount)}
            />
            <MetricCard
              label="Integrity issues"
              value={formatNumber(artifacts.ingestionIntegrity?.integrity?.issueCount)}
              tone={
                (artifacts.ingestionIntegrity?.integrity?.errorCount ?? 0) > 0 ? "error" : "default"
              }
            />
          </div>
        </SectionCard>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="min-w-0 space-y-4">
            <ParserBenchmarkCard artifact={artifacts.parserBenchmark} />
            <DocumentQaCard artifact={artifacts.documentQaBenchmark} />
            <ParserExtractionCard artifact={artifacts.parserExtractionAudit} />
            <ParserQualityCard artifact={artifacts.parserQuality} />
            <IngestionIntegrityCard artifact={artifacts.ingestionIntegrity} />
            <EmbeddingMigrationCard artifact={artifacts.embeddingMigration} />
            <SectionCard
              title="Index Generation Promotion"
              description="Candidate, active, and deprecated index generations with guarded promotion actions."
            >
              <GenerationPromotionPanel generationsResult={generationsResult} />
            </SectionCard>
            <ProviderSmokeCard artifact={artifacts.providerSmoke} />
            <VectorCleanupCard artifact={artifacts.vectorCleanup} />
          </div>

          <aside className="min-w-0 space-y-4">
            <RunbookCard defaultOpen={availableCount === 0} />
            <ArtifactPathCard
              paths={artifacts.paths}
              states={artifacts.artifactStates}
              defaultOpen={invalidStates.length > 0}
            />
          </aside>
        </div>
      </main>
    </div>
  );
}

function ParserBenchmarkCard({
  artifact
}: {
  readonly artifact: ParserBenchmarkArtifact | undefined;
}) {
  return (
    <SectionCard
      title="Parser Benchmark"
      description="External parser dataset scoring for layout, tables, formulas, and reading order."
    >
      {!artifact ? (
        <EmptyState
          title="No parser benchmark artifact"
          detail="Run npm run parser:benchmark to write .rag/parser-benchmarks/latest/parser-benchmark.json."
        />
      ) : (
        <div className="space-y-3">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-6">
            <MetricCard
              label="Status"
              value={artifact.status ?? "unknown"}
              tone={statusTone(artifact.status)}
            />
            <MetricCard label="Dataset" value={artifact.dataset ?? "n/a"} />
            <MetricCard label="Cases" value={formatNumber(artifact.caseCount)} />
            <MetricCard label="Passed" value={formatNumber(artifact.passedCount)} tone="success" />
            <MetricCard
              label="Failed"
              value={formatNumber(artifact.failedCount)}
              tone={(artifact.failedCount ?? 0) > 0 ? "error" : "default"}
            />
            <MetricCard label="Layout recall" value={formatScore(artifact.averageLayoutRecall)} />
          </div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
            <MetricCard
              label="Text similarity"
              value={formatScore(artifact.averageTextSimilarity)}
            />
            <MetricCard label="Table recall" value={formatScore(artifact.averageTableRecall)} />
            <MetricCard label="Formula recall" value={formatScore(artifact.averageFormulaRecall)} />
            <MetricCard
              label="Reading order"
              value={formatScore(artifact.averageReadingOrderScore)}
            />
            <MetricCard label="Warnings" value={formatNumber(totalWarnings(artifact.cases))} />
          </div>
          <CaseTable
            rows={(artifact.cases ?? []).slice(0, 8).map((testCase) => ({
              id: testCase.caseId ?? "unknown",
              status: testCase.status ?? "unknown",
              detail: `text ${formatScore(testCase.textSimilarity)} / layout ${formatScore(testCase.layoutRecall)}`,
              warning: testCase.warnings?.[0]
            }))}
          />
        </div>
      )}
    </SectionCard>
  );
}

function DocumentQaCard({
  artifact
}: {
  readonly artifact: DocumentQaBenchmarkArtifact | undefined;
}) {
  return (
    <SectionCard
      title="Document QA Benchmark"
      description="Parser-only and full RAG document QA scoring for answer recovery, retrieval, and citations."
    >
      {!artifact ? (
        <EmptyState
          title="No document QA artifact"
          detail="Run npm run document-qa:benchmark to write .rag/document-qa-benchmarks/latest/document-qa-benchmark.json."
        />
      ) : (
        <div className="space-y-3">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-6">
            <MetricCard
              label="Status"
              value={artifact.status ?? "unknown"}
              tone={statusTone(artifact.status)}
            />
            <MetricCard label="Mode" value={artifact.benchmarkMode ?? "parser-only"} />
            <MetricCard label="Dataset" value={artifact.dataset ?? "n/a"} />
            <MetricCard label="Cases" value={formatNumber(artifact.caseCount)} />
            <MetricCard label="Answer found" value={formatNumber(artifact.answerFoundCount)} />
            <MetricCard label="Relaxed accuracy" value={formatScore(artifact.relaxedAccuracy)} />
          </div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
            <MetricCard
              label="Best answer sim"
              value={formatScore(artifact.averageBestAnswerSimilarity)}
            />
            <MetricCard label="Best ANLS" value={formatScore(artifact.averageBestAnlsScore)} />
            <MetricCard
              label="Retrieval misses"
              value={formatNumber(artifact.ragMetrics?.retrievalFailureCount)}
            />
            <MetricCard
              label="Citation misses"
              value={formatNumber(artifact.ragMetrics?.citationFailureCount)}
            />
            <MetricCard
              label="Answer failures"
              value={formatNumber(artifact.ragMetrics?.answerGenerationFailureCount)}
            />
          </div>
          <CaseTable
            rows={(artifact.cases ?? []).slice(0, 8).map((testCase) => ({
              id: testCase.caseId ?? "unknown",
              status: testCase.status ?? "unknown",
              detail: testCase.failureStage
                ? `${testCase.failureStage} failure`
                : `answer ${formatScore(testCase.bestAnswerSimilarity)} / ANLS ${formatScore(testCase.bestAnlsScore)}`,
              warning: testCase.warnings?.[0] ?? testCase.question
            }))}
          />
        </div>
      )}
    </SectionCard>
  );
}

function ParserExtractionCard({
  artifact
}: {
  readonly artifact: ParserExtractionAuditArtifact | undefined;
}) {
  return (
    <SectionCard
      title="Parser Extraction Audit"
      description="Original extraction and searchability smoke checks over parsed local files."
    >
      {!artifact ? (
        <EmptyState
          title="No parser extraction audit"
          detail="Run npm run parser:extraction-audit to write .rag/parser-extraction-audit/latest/parser-extraction-audit-summary.json."
        />
      ) : (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-6">
          <MetricCard
            label="Status"
            value={artifact.status ?? "unknown"}
            tone={statusTone(artifact.status)}
          />
          <MetricCard label="Source" value={artifact.sourceId ?? "n/a"} />
          <MetricCard label="Docs" value={formatNumber(artifact.acceptedDocumentCount)} />
          <MetricCard
            label="Rejected"
            value={formatNumber(artifact.rejectedRecordCount)}
            tone={(artifact.rejectedRecordCount ?? 0) > 0 ? "error" : "default"}
          />
          <MetricCard label="Search passed" value={formatNumber(artifact.searchability?.passed)} />
          <MetricCard
            label="Search failed"
            value={formatNumber(artifact.searchability?.failed)}
            tone={(artifact.searchability?.failed ?? 0) > 0 ? "error" : "default"}
          />
        </div>
      )}
    </SectionCard>
  );
}

function ParserQualityCard({ artifact }: { readonly artifact: ParserQualityArtifact | undefined }) {
  const quality = artifact?.parserQuality;
  return (
    <SectionCard
      title="Parser Quality Report"
      description="Parser router readiness, selected-parser score health, fallback use, and file-type quality distribution."
    >
      {!artifact ? (
        <EmptyState
          title="No parser quality report"
          detail="Run npm run parser-quality:report to write .rag/parser-quality/latest/parser-quality.json."
        />
      ) : (
        <div className="space-y-3">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-6">
            <MetricCard
              label="Status"
              value={artifact.status ?? quality?.readiness?.status ?? "unknown"}
              tone={statusTone(artifact.status ?? quality?.readiness?.status)}
            />
            <MetricCard
              label="Readiness"
              value={quality?.readiness?.status ?? "unknown"}
              tone={statusTone(quality?.readiness?.status)}
            />
            <MetricCard label="Docs" value={formatNumber(artifact.acceptedDocumentCount)} />
            <MetricCard label="Traced" value={formatNumber(quality?.tracedDocumentCount)} />
            <MetricCard
              label="Warnings"
              value={formatNumber(quality?.warningCount)}
              tone={(quality?.warningCount ?? 0) > 0 ? "warning" : "default"}
            />
            <MetricCard label="Avg score" value={formatScore(quality?.averageSelectedScore)} />
          </div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
            <MetricCard
              label="Low score docs"
              value={formatNumber(quality?.lowScoreDocumentCount)}
              tone={(quality?.lowScoreDocumentCount ?? 0) > 0 ? "warning" : "default"}
            />
            <MetricCard
              label="Fallback selected"
              value={formatNumber(quality?.fallbackSelectedCount)}
              tone={(quality?.fallbackSelectedCount ?? 0) > 0 ? "warning" : "default"}
            />
            <MetricCard
              label="Failed attempts"
              value={formatNumber(quality?.failedAttemptCount)}
              tone={(quality?.failedAttemptCount ?? 0) > 0 ? "error" : "default"}
            />
            <MetricCard
              label="Rejected attempts"
              value={formatNumber(quality?.rejectedAttemptCount)}
            />
            <MetricCard
              label="Skipped candidates"
              value={formatNumber(quality?.skippedCandidateCount)}
            />
          </div>
          {quality?.readiness?.message ? (
            <div className="rounded-lg border border-card bg-background p-3 text-sm text-text-secondary">
              {quality.readiness.message}
            </div>
          ) : null}
          <ParserQualityFileTypeTable rows={(artifact.fileTypes ?? []).slice(0, 8)} />
          <ParserQualityWarningList warnings={(artifact.parserQualityWarnings ?? []).slice(0, 5)} />
        </div>
      )}
    </SectionCard>
  );
}

function IngestionIntegrityCard({
  artifact
}: {
  readonly artifact: IngestionIntegrityArtifact | undefined;
}) {
  return (
    <SectionCard
      title="Ingestion Integrity"
      description="Post-parse checks for OCR gaps, searchable artifacts, chunk relationships, vector coverage, and graph coverage."
    >
      {!artifact ? (
        <EmptyState
          title="No ingestion integrity artifact"
          detail="Run npm run ingestion:integrity to write .rag/ingestion-integrity/latest/ingestion-integrity.json."
        />
      ) : (
        <div className="space-y-3">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-6">
            <MetricCard
              label="Status"
              value={artifact.status ?? "unknown"}
              tone={statusTone(artifact.status)}
            />
            <MetricCard label="Source" value={artifact.sourceId ?? "n/a"} />
            <MetricCard
              label="Documents"
              value={formatNumber(artifact.counts?.acceptedDocumentCount)}
            />
            <MetricCard label="Chunks" value={formatNumber(artifact.counts?.acceptedChunkCount)} />
            <MetricCard
              label="Errors"
              value={formatNumber(artifact.integrity?.errorCount)}
              tone={(artifact.integrity?.errorCount ?? 0) > 0 ? "error" : "default"}
            />
            <MetricCard
              label="Warnings"
              value={formatNumber(artifact.integrity?.warningCount)}
              tone={(artifact.integrity?.warningCount ?? 0) > 0 ? "warning" : "default"}
            />
          </div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
            <MetricCard label="Pages" value={formatNumber(artifact.integrity?.counts?.pageCount)} />
            <MetricCard
              label="OCR needed"
              value={formatNumber(artifact.integrity?.counts?.pagesNeedingOcrCount)}
            />
            <MetricCard
              label="Tables"
              value={formatNumber(artifact.integrity?.counts?.tableCount)}
            />
            <MetricCard
              label="Visual assets"
              value={formatNumber(artifact.integrity?.counts?.visualAssetCount)}
            />
            <MetricCard
              label="Relations"
              value={formatNumber(artifact.integrity?.counts?.layoutRelationCount)}
            />
          </div>
          <IssueTable issues={(artifact.integrity?.issues ?? []).slice(0, 8)} />
        </div>
      )}
    </SectionCard>
  );
}

function EmbeddingMigrationCard({
  artifact
}: {
  readonly artifact: EmbeddingMigrationArtifact | undefined;
}) {
  return (
    <SectionCard
      title="Embedding Migration"
      description="Candidate-vs-baseline quality deltas before promoting a new embedding or chunking generation."
    >
      {!artifact ? (
        <EmptyState
          title="No embedding migration artifact"
          detail="Run npm run embedding:migration-report to write .rag/embedding-migration/report.json."
        />
      ) : (
        <div className="space-y-3">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
            <MetricCard
              label="Status"
              value={artifact.status ?? "unknown"}
              tone={statusTone(artifact.status)}
            />
            <MetricCard label="Baseline" value={formatTime(artifact.baselineGeneratedAt)} />
            <MetricCard label="Candidate" value={formatTime(artifact.candidateGeneratedAt)} />
            <MetricCard
              label="Failures"
              value={formatNumber(artifact.failures?.length)}
              tone={(artifact.failures?.length ?? 0) > 0 ? "error" : "default"}
            />
            <MetricCard label="Deltas" value={formatNumber(artifact.deltas?.length)} />
          </div>
          <DeltaTable deltas={artifact.deltas ?? []} />
          {(artifact.failures ?? []).length > 0 ? (
            <div className="space-y-2">
              {artifact.failures?.map((failure) => (
                <div
                  key={failure}
                  className="rounded-lg border border-error/20 bg-error/10 p-3 text-sm text-error"
                >
                  {failure}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      )}
    </SectionCard>
  );
}

function ProviderSmokeCard({ artifact }: { readonly artifact: ProviderSmokeArtifact | undefined }) {
  return (
    <SectionCard
      title="Provider Smoke"
      description="RAG service provider coverage from startup self-test probes for model, embedding, visual embedding, rerank, and grounding judge providers."
    >
      {!artifact ? (
        <EmptyState
          title="No provider smoke report"
          detail="Run npm run smoke:providers to write .rag/provider-smoke/latest/smoke.json."
        />
      ) : (
        <div className="space-y-3">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-6">
            <MetricCard
              label="Status"
              value={artifact.status ?? "unknown"}
              tone={statusTone(artifact.status)}
            />
            <MetricCard
              label="Required passed"
              value={`${formatNumber(artifact.summary?.passedRequiredProviderCount)} / ${formatNumber(
                artifact.summary?.requiredProviderCount
              )}`}
              tone={
                (artifact.summary?.failedRequiredProviderCount ?? 0) > 0
                  ? "error"
                  : artifact.status === "passed"
                    ? "success"
                    : "default"
              }
            />
            <MetricCard
              label="Probe checks"
              value={formatNumber(artifact.summary?.providerProbeCheckCount)}
            />
            <MetricCard
              label="Probe failed"
              value={formatNumber(artifact.summary?.failedProviderProbeCheckCount)}
              tone={
                (artifact.summary?.failedProviderProbeCheckCount ?? 0) > 0 ? "error" : "default"
              }
            />
            <MetricCard
              label="Probe skipped"
              value={formatNumber(artifact.summary?.skippedProviderProbeCheckCount)}
              tone={
                (artifact.summary?.skippedProviderProbeCheckCount ?? 0) > 0 ? "warning" : "default"
              }
            />
            <MetricCard
              label="Self-test failed"
              value={formatNumber(artifact.selfTest?.failedCount)}
              tone={(artifact.selfTest?.failedCount ?? 0) > 0 ? "error" : "default"}
            />
          </div>
          <div className="grid gap-2 text-xs text-text-muted md:grid-cols-3">
            <div>Run: {truncateMiddle(artifact.runId ?? "n/a", 36)}</div>
            <div>Checked: {formatTime(artifact.checkedAt)}</div>
            <div>
              Profile: {artifact.profileId ?? "n/a"} / {artifact.namespaceId ?? "n/a"}
            </div>
          </div>
          <ProviderCoverageTable rows={artifact.providerCoverage ?? []} />
          <MessageList title="Provider failures" messages={(artifact.failures ?? []).slice(0, 5)} />
          <MessageList title="Provider warnings" messages={(artifact.warnings ?? []).slice(0, 5)} />
        </div>
      )}
    </SectionCard>
  );
}

function VectorCleanupCard({ artifact }: { readonly artifact: VectorCleanupArtifact | undefined }) {
  return (
    <SectionCard
      title="Vector Cleanup Plan"
      description="Dry-run or apply plan for deleting stale vector generations from snapshot-backed stores."
    >
      {!artifact ? (
        <EmptyState
          title="No vector cleanup plan"
          detail="Run npm run vector:cleanup-plan to write .rag/vector-cleanup/plan.json."
        />
      ) : (
        <div className="space-y-3">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
            <MetricCard
              label="Mode"
              value={artifact.mode ?? "unknown"}
              tone={artifact.mode === "apply" ? "warning" : "primary"}
            />
            <MetricCard
              label="Delete"
              value={formatNumber(artifact.deleteCount)}
              tone={(artifact.deleteCount ?? 0) > 0 ? "warning" : "default"}
            />
            <MetricCard label="Keep" value={formatNumber(artifact.keepCount)} />
            <MetricCard label="Generations" value={formatNumber(artifact.inventory?.length)} />
            <MetricCard
              label="Keep hashes"
              value={formatNumber(artifact.keepEmbeddingConfigHashes?.length)}
            />
          </div>
          <InventoryTable inventory={(artifact.inventory ?? []).slice(0, 8)} />
        </div>
      )}
    </SectionCard>
  );
}

function CaseTable({
  rows
}: {
  readonly rows: readonly {
    readonly id: string;
    readonly status: string;
    readonly detail: string;
    readonly warning?: string;
  }[];
}) {
  if (rows.length === 0) return <EmptyState title="No case rows in artifact" />;
  return (
    <div className="max-w-full overflow-x-auto">
      <table className="w-full min-w-[720px] text-left text-sm">
        <thead className="border-b border-card text-xs uppercase tracking-[0.08em] text-text-muted">
          <tr>
            <th className="px-2 py-2 font-medium">Case</th>
            <th className="px-2 py-2 font-medium">Status</th>
            <th className="px-2 py-2 font-medium">Detail</th>
            <th className="px-2 py-2 font-medium">Warning</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-card">
          {rows.map((row) => (
            <tr key={row.id} className="hover:bg-card/50">
              <td className="px-2 py-3 font-medium">{truncateMiddle(row.id, 48)}</td>
              <td className="px-2 py-3">
                <StatusPill label={row.status} tone={statusTone(row.status)} />
              </td>
              <td className="px-2 py-3 text-text-secondary">{row.detail}</td>
              <td className="px-2 py-3 text-text-muted">
                {truncateMiddle(row.warning ?? "none", 72)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ParserQualityFileTypeTable({
  rows
}: {
  readonly rows: NonNullable<ParserQualityArtifact["fileTypes"]>;
}) {
  if (rows.length === 0) return <EmptyState title="No file-type rows in parser quality report" />;
  return (
    <div className="max-w-full overflow-x-auto">
      <table className="w-full min-w-[900px] text-left text-sm">
        <thead className="border-b border-card text-xs uppercase tracking-[0.08em] text-text-muted">
          <tr>
            <th className="px-2 py-2 font-medium">Type</th>
            <th className="px-2 py-2 font-medium">Docs</th>
            <th className="px-2 py-2 font-medium">Traced</th>
            <th className="px-2 py-2 font-medium">Avg score</th>
            <th className="px-2 py-2 font-medium">Low score</th>
            <th className="px-2 py-2 font-medium">Fallback</th>
            <th className="px-2 py-2 font-medium">Failed</th>
            <th className="px-2 py-2 font-medium">Selected parsers</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-card">
          {rows.map((row, index) => (
            <tr key={`${row.extension ?? "type"}-${index}`} className="hover:bg-card/50">
              <td className="px-2 py-3">
                <div className="font-medium">{row.extension ?? "unknown"}</div>
                <div className="text-xs text-text-muted">
                  {truncateMiddle(row.contentType ?? "n/a", 42)}
                </div>
              </td>
              <td className="px-2 py-3 text-text-secondary">{formatNumber(row.documentCount)}</td>
              <td className="px-2 py-3 text-text-secondary">
                {formatNumber(row.tracedDocumentCount)}
              </td>
              <td className="px-2 py-3 text-text-secondary">
                {formatScore(row.averageSelectedScore)}
              </td>
              <td className="px-2 py-3 text-text-secondary">
                {formatNumber(row.lowScoreDocumentCount)}
              </td>
              <td className="px-2 py-3 text-text-secondary">
                {formatNumber(row.fallbackSelectedCount)}
              </td>
              <td className="px-2 py-3 text-text-secondary">
                {formatNumber(row.failedAttemptCount)}
              </td>
              <td className="px-2 py-3 text-text-muted">
                {truncateMiddle(selectedParserSummary(row.selectedParsers), 72)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ParserQualityWarningList({
  warnings
}: {
  readonly warnings: NonNullable<ParserQualityArtifact["parserQualityWarnings"]>;
}) {
  if (warnings.length === 0) return null;
  return (
    <div className="space-y-2">
      {warnings.map((warning, index) => (
        <div
          key={`${warning.code ?? "warning"}-${warning.documentId ?? index}`}
          className="rounded-lg border border-warning/20 bg-warning/10 p-3 text-sm text-warning"
        >
          <div className="font-medium">{warning.code ?? "parser_quality_warning"}</div>
          <div className="mt-1 text-xs leading-5 text-current/80">
            {warning.message ?? "No warning message."}
          </div>
          <div className="mt-1 text-xs text-current/70">
            {truncateMiddle(warning.documentId ?? warning.sourceId ?? "n/a", 72)}
          </div>
        </div>
      ))}
    </div>
  );
}

function ProviderCoverageTable({
  rows
}: {
  readonly rows: NonNullable<ProviderSmokeArtifact["providerCoverage"]>;
}) {
  if (rows.length === 0) return <EmptyState title="No provider coverage rows in smoke report" />;
  return (
    <div className="max-w-full overflow-x-auto">
      <table className="w-full min-w-[760px] text-left text-sm">
        <thead className="border-b border-card text-xs uppercase tracking-[0.08em] text-text-muted">
          <tr>
            <th className="px-2 py-2 font-medium">Provider</th>
            <th className="px-2 py-2 font-medium">Required</th>
            <th className="px-2 py-2 font-medium">Status</th>
            <th className="px-2 py-2 font-medium">Checks</th>
            <th className="px-2 py-2 font-medium">Warnings</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-card">
          {rows.map((row) => (
            <tr key={row.provider ?? "provider"} className="hover:bg-card/50">
              <td className="px-2 py-3 font-medium">{row.provider ?? "unknown"}</td>
              <td className="px-2 py-3 text-text-secondary">{row.required ? "yes" : "no"}</td>
              <td className="px-2 py-3">
                <StatusPill label={row.status ?? "unknown"} tone={statusTone(row.status)} />
              </td>
              <td className="px-2 py-3 text-text-secondary">
                {truncateMiddle((row.checkIds ?? []).join(", ") || "none", 72)}
              </td>
              <td className="px-2 py-3 text-text-muted">
                {truncateMiddle((row.warnings ?? []).join(", ") || "none", 72)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MessageList({
  title,
  messages
}: {
  readonly title: string;
  readonly messages: readonly string[];
}) {
  if (messages.length === 0) return null;
  return (
    <div className="space-y-2">
      <div className="text-xs font-medium uppercase tracking-[0.08em] text-text-muted">{title}</div>
      {messages.map((message) => (
        <div
          key={message}
          className="rounded-lg border border-card bg-background p-3 text-sm text-text-secondary"
        >
          {message}
        </div>
      ))}
    </div>
  );
}

function IssueTable({
  issues
}: {
  readonly issues: readonly {
    readonly severity?: string;
    readonly code?: string;
    readonly documentId?: string;
    readonly sourceId?: string;
    readonly message?: string;
  }[];
}) {
  if (issues.length === 0) return <EmptyState title="No integrity issues in artifact" />;
  return (
    <div className="max-w-full overflow-x-auto">
      <table className="w-full min-w-[760px] text-left text-sm">
        <thead className="border-b border-card text-xs uppercase tracking-[0.08em] text-text-muted">
          <tr>
            <th className="px-2 py-2 font-medium">Severity</th>
            <th className="px-2 py-2 font-medium">Code</th>
            <th className="px-2 py-2 font-medium">Target</th>
            <th className="px-2 py-2 font-medium">Message</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-card">
          {issues.map((issue, index) => (
            <tr key={`${issue.code ?? "issue"}-${index}`} className="hover:bg-card/50">
              <td className="px-2 py-3">
                <StatusPill
                  label={issue.severity ?? "unknown"}
                  tone={issue.severity === "error" ? "error" : "warning"}
                />
              </td>
              <td className="px-2 py-3 font-medium">{issue.code ?? "unknown"}</td>
              <td className="px-2 py-3 text-text-secondary">
                {truncateMiddle(issue.documentId ?? issue.sourceId ?? "n/a", 48)}
              </td>
              <td className="px-2 py-3 text-text-muted">{issue.message ?? "No message."}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DeltaTable({
  deltas
}: {
  readonly deltas: readonly {
    readonly metric?: string;
    readonly baseline?: number;
    readonly candidate?: number;
    readonly change?: number;
  }[];
}) {
  if (deltas.length === 0) return <EmptyState title="No migration deltas in artifact" />;
  return (
    <div className="max-w-full overflow-x-auto">
      <table className="w-full min-w-[560px] text-left text-sm">
        <thead className="border-b border-card text-xs uppercase tracking-[0.08em] text-text-muted">
          <tr>
            <th className="px-2 py-2 font-medium">Metric</th>
            <th className="px-2 py-2 font-medium">Baseline</th>
            <th className="px-2 py-2 font-medium">Candidate</th>
            <th className="px-2 py-2 font-medium">Change</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-card">
          {deltas.map((delta) => (
            <tr key={delta.metric ?? "metric"} className="hover:bg-card/50">
              <td className="px-2 py-3 font-medium">{delta.metric ?? "unknown"}</td>
              <td className="px-2 py-3 text-text-secondary">{formatScore(delta.baseline)}</td>
              <td className="px-2 py-3 text-text-secondary">{formatScore(delta.candidate)}</td>
              <td className="px-2 py-3 text-text-muted">{formatSignedScore(delta.change)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function InventoryTable({
  inventory
}: {
  readonly inventory: readonly {
    readonly tenantId?: string;
    readonly namespaceId?: string;
    readonly embeddingProvider?: string;
    readonly embeddingModel?: string;
    readonly embeddingConfigHash?: string;
    readonly vectorCount?: number;
    readonly documentCount?: number;
  }[];
}) {
  if (inventory.length === 0) return <EmptyState title="No vector generations in plan" />;
  return (
    <div className="max-w-full overflow-x-auto">
      <table className="w-full min-w-[860px] text-left text-sm">
        <thead className="border-b border-card text-xs uppercase tracking-[0.08em] text-text-muted">
          <tr>
            <th className="px-2 py-2 font-medium">Scope</th>
            <th className="px-2 py-2 font-medium">Provider</th>
            <th className="px-2 py-2 font-medium">Model</th>
            <th className="px-2 py-2 font-medium">Config hash</th>
            <th className="px-2 py-2 font-medium">Vectors</th>
            <th className="px-2 py-2 font-medium">Docs</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-card">
          {inventory.map((entry, index) => (
            <tr
              key={`${entry.embeddingConfigHash ?? "hash"}-${index}`}
              className="hover:bg-card/50"
            >
              <td className="px-2 py-3 text-text-secondary">
                {truncateMiddle(
                  `${entry.tenantId ?? "tenant n/a"} / ${entry.namespaceId ?? "namespace n/a"}`,
                  42
                )}
              </td>
              <td className="px-2 py-3 text-text-secondary">{entry.embeddingProvider ?? "n/a"}</td>
              <td className="px-2 py-3 text-text-secondary">
                {truncateMiddle(entry.embeddingModel ?? "n/a", 32)}
              </td>
              <td className="px-2 py-3 font-mono text-xs text-text-muted">
                {truncateMiddle(entry.embeddingConfigHash ?? "unknown", 42)}
              </td>
              <td className="px-2 py-3 text-text-secondary">{formatNumber(entry.vectorCount)}</td>
              <td className="px-2 py-3 text-text-secondary">{formatNumber(entry.documentCount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RunbookCard({ defaultOpen = false }: { readonly defaultOpen?: boolean }) {
  const commands = [
    "npm run parser:benchmark:doctor",
    "npm run parser:benchmark -- --dataset tablebank --annotations <path> --images-root <path>",
    "npm run document-qa:benchmark -- --dataset docvqa --mode rag --annotations <path> --images-root <path>",
    "npm run ingestion:integrity -- --sources <local-files.sources.json>",
    "npm run parser-quality:report -- --sources <local-files.sources.json>",
    "npm run smoke:providers",
    "npm run embedding:migration-report",
    "npm run vector:cleanup-plan"
  ];

  return (
    <CollapsibleSection
      title="Runbook"
      description="Commands that populate the artifacts shown on this page."
      defaultOpen={defaultOpen}
    >
      <div className="space-y-2">
        {commands.map((command) => (
          <div key={command} className="rounded-lg border border-card bg-background p-3">
            <div className="mb-2 flex items-center gap-2 text-xs font-medium text-text-muted">
              <Terminal className="h-3.5 w-3.5" aria-hidden="true" />
              Operator command
            </div>
            <pre className="max-w-full overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-card/60 p-2 font-mono text-[11px] leading-5 text-text-secondary">
              {command}
            </pre>
          </div>
        ))}
      </div>
    </CollapsibleSection>
  );
}

function ArtifactPathCard({
  paths,
  states,
  defaultOpen = false
}: {
  readonly paths: QualityOpsArtifactPaths;
  readonly states: Readonly<Record<keyof QualityOpsArtifactPaths, QualityOpsArtifactReadState>>;
  readonly defaultOpen?: boolean;
}) {
  return (
    <CollapsibleSection
      title="Artifact Paths"
      description="Default JSON inputs for this page."
      defaultOpen={defaultOpen}
    >
      <div className="space-y-2 text-xs text-text-muted">
        {Object.entries(paths).map(([label, value]) => {
          const state = states[label as keyof QualityOpsArtifactPaths];
          return (
            <div key={label} className="rounded-lg border border-card bg-background p-3">
              <div className="mb-1 flex items-center justify-between gap-2">
                <div className="font-medium text-text-secondary">{label}</div>
                <StatusPill label={state.status} tone={artifactReadTone(state.status)} />
              </div>
              <div className="break-all font-mono leading-5">{value}</div>
              {state.status === "invalid" ? (
                <div className="mt-2 rounded-md border border-error/20 bg-error/10 p-2 text-error">
                  {state.error ?? "Artifact could not be parsed."}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </CollapsibleSection>
  );
}

function artifactState(readState: QualityOpsArtifactReadState, status: string | undefined) {
  return {
    label: readState.label,
    path: readState.path,
    error: readState.error,
    available: readState.status === "available",
    invalid: readState.status === "invalid",
    failing: readState.status === "invalid" || status === "failed" || status === "error"
  };
}

function formatScore(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(3) : "n/a";
}

function formatSignedScore(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "n/a";
  return value > 0 ? `+${value.toFixed(3)}` : value.toFixed(3);
}

function totalWarnings(cases: readonly { readonly warnings?: readonly string[] }[] | undefined) {
  return (cases ?? []).reduce((total, testCase) => total + (testCase.warnings?.length ?? 0), 0);
}

function selectedParserSummary(parsers: Record<string, number | undefined> | undefined): string {
  const entries = Object.entries(parsers ?? {}).filter((entry): entry is [string, number] =>
    Number.isFinite(entry[1])
  );
  if (entries.length === 0) return "none";
  return entries
    .sort((left, right) => right[1] - left[1])
    .map(([parser, count]) => `${parser} (${count})`)
    .join(", ");
}

function artifactReadTone(status: QualityOpsArtifactReadState["status"]) {
  return status === "available" ? "success" : status === "invalid" ? "error" : "warning";
}
