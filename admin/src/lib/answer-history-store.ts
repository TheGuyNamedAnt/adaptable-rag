import "server-only";

import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import type { Pool } from "pg";
import { buildRejectedEvidenceFromAnswer } from "@/lib/rejected-evidence";
import { resolveRagRepoRoot } from "@/lib/repo-root";
import type {
  AdminAnswerRunHistoryStorageKind,
  AdminAnswerRunDetail,
  AdminAnswerRunListFilter,
  AdminAnswerRunList,
  AdminAnswerRunSafeRequest,
  AdminAnswerRunSummary,
  AdminRejectedEvidenceSummary
} from "@/lib/answer-history-types";
import type { AdminAnswerRequest, AdminAnswerResponse } from "@/lib/rag-answer-types";

interface StoredAdminAnswerRun {
  readonly savedAt: string;
  readonly request: AdminAnswerRunSafeRequest;
  readonly summary: AdminAnswerRunSummary;
  readonly response: AdminAnswerResponse;
  readonly rejectedEvidence: AdminRejectedEvidenceSummary;
}

const DEFAULT_HISTORY_LIMIT = 25;
const MAX_HISTORY_LIMIT = 100;
const DEFAULT_SCHEMA = "rag_core";
const ADMIN_ANSWER_RUNS_TABLE = "admin_answer_runs";

let postgresPool: Pool | undefined;

export async function saveAdminAnswerRun(input: {
  readonly request: AdminAnswerRequest;
  readonly response: AdminAnswerResponse;
  readonly savedAt?: string;
}): Promise<AdminAnswerRunDetail> {
  const savedAt = input.savedAt ?? new Date().toISOString();
  const response = sanitizeResponseForHistory(input.response);
  const request = safeRequestSummary(input.request, response);
  const rejectedEvidence = buildRejectedEvidenceFromAnswer(response);
  const summary = buildRunSummary({
    savedAt,
    request,
    response,
    hasAnswer: Boolean(input.response.answer),
    hasEvidenceSummary: Boolean(input.response.evidenceSummary)
  });
  const stored: StoredAdminAnswerRun = {
    savedAt,
    request,
    summary,
    response,
    rejectedEvidence
  };

  if (historyStorageKind() === "postgres") {
    await saveStoredRunToPostgres(stored);
  } else {
    await mkdir(/*turbopackIgnore: true*/ historyDirectory(), { recursive: true });
    await appendFile(
      /*turbopackIgnore: true*/ historyFile(),
      `${JSON.stringify(stored)}\n`,
      "utf8"
    );
  }
  return toDetail(stored);
}

export async function listAdminAnswerRuns(options: {
  readonly limit?: number;
  readonly offset?: number;
  readonly filters?: AdminAnswerRunListFilter;
}): Promise<AdminAnswerRunList> {
  const limit = historyLimit(options.limit);
  const offset = historyOffset(options.offset);
  const filters = normalizeFilters(options.filters ?? {});
  const storageKind = historyStorageKind();
  if (storageKind === "postgres") {
    return listStoredRunsFromPostgres({ limit, offset, filters, storageKind });
  }

  const runs = await readStoredRuns();
  const newestFirst = [...runs].reverse().filter((run) => matchesFilters(run, filters));
  const page = newestFirst.slice(offset, offset + limit);

  return {
    runs: page.map((run) => run.summary),
    page: {
      limit,
      offset,
      hasMore: offset + limit < newestFirst.length,
      total: newestFirst.length,
      storageKind
    },
    filters
  };
}

export async function getAdminAnswerRun(runId: string): Promise<AdminAnswerRunDetail | undefined> {
  if (historyStorageKind() === "postgres") {
    return getStoredRunFromPostgres(runId);
  }

  const runs = await readStoredRuns();
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index];
    if (run?.summary.runId === runId || run?.summary.traceId === runId) {
      return toDetail(run);
    }
  }
  return undefined;
}

async function saveStoredRunToPostgres(run: StoredAdminAnswerRun): Promise<void> {
  const pool = getPostgresPool();
  const table = qualifiedAdminRunsTable();
  await pool.query(
    `
      insert into ${table} (
        run_id,
        trace_id,
        saved_at,
        status,
        tenant_id,
        namespace_id,
        profile_id,
        question_hash,
        retrieval_mode,
        candidate_pool_size,
        returned_count,
        retrieval_rejected_count,
        context_status,
        context_block_count,
        context_rejected_count,
        final_citation_count,
        rejected_chunk_count,
        event_count,
        has_answer,
        answer_redacted,
        has_evidence_summary,
        evidence_summary_redacted,
        rejection_codes,
        saved_request,
        summary,
        response,
        rejected_evidence
      )
      values (
        $1, $2, $3::timestamptz, $4, $5, $6, $7, $8, $9,
        $10, $11, $12, $13, $14, $15, $16, $17, $18,
        $19, $20, $21, $22, $23::text[], $24::jsonb, $25::jsonb, $26::jsonb, $27::jsonb
      )
      on conflict (run_id) do update set
        trace_id = excluded.trace_id,
        saved_at = excluded.saved_at,
        status = excluded.status,
        tenant_id = excluded.tenant_id,
        namespace_id = excluded.namespace_id,
        profile_id = excluded.profile_id,
        question_hash = excluded.question_hash,
        retrieval_mode = excluded.retrieval_mode,
        candidate_pool_size = excluded.candidate_pool_size,
        returned_count = excluded.returned_count,
        retrieval_rejected_count = excluded.retrieval_rejected_count,
        context_status = excluded.context_status,
        context_block_count = excluded.context_block_count,
        context_rejected_count = excluded.context_rejected_count,
        final_citation_count = excluded.final_citation_count,
        rejected_chunk_count = excluded.rejected_chunk_count,
        event_count = excluded.event_count,
        has_answer = excluded.has_answer,
        answer_redacted = excluded.answer_redacted,
        has_evidence_summary = excluded.has_evidence_summary,
        evidence_summary_redacted = excluded.evidence_summary_redacted,
        rejection_codes = excluded.rejection_codes,
        saved_request = excluded.saved_request,
        summary = excluded.summary,
        response = excluded.response,
        rejected_evidence = excluded.rejected_evidence
    `,
    [
      run.summary.runId,
      run.summary.traceId,
      run.savedAt,
      run.summary.status,
      run.summary.tenantId,
      run.summary.namespaceId,
      run.summary.profileId,
      run.summary.questionHash,
      run.summary.retrievalMode ?? null,
      run.summary.candidatePoolSize ?? null,
      run.summary.returnedCount ?? null,
      run.summary.retrievalRejectedCount ?? null,
      run.summary.contextStatus ?? null,
      run.summary.contextBlockCount ?? null,
      run.summary.contextRejectedCount ?? null,
      run.summary.finalCitationCount,
      run.summary.rejectedChunkCount,
      run.summary.eventCount,
      run.summary.hasAnswer,
      run.summary.answerRedacted,
      run.summary.hasEvidenceSummary,
      run.summary.evidenceSummaryRedacted,
      run.rejectedEvidence.rejectionCodes,
      JSON.stringify(run.request),
      JSON.stringify(run.summary),
      JSON.stringify(run.response),
      JSON.stringify(run.rejectedEvidence)
    ]
  );
}

async function listStoredRunsFromPostgres(input: {
  readonly limit: number;
  readonly offset: number;
  readonly filters: AdminAnswerRunListFilter;
  readonly storageKind: AdminAnswerRunHistoryStorageKind;
}): Promise<AdminAnswerRunList> {
  const pool = getPostgresPool();
  const table = qualifiedAdminRunsTable();
  const where = postgresWhereClause(input.filters);
  const countResult = await pool.query<{ total: string }>(
    `select count(*)::text as total from ${table}${where.sql}`,
    where.params
  );
  const total = Number(countResult.rows[0]?.total ?? "0");
  const result = await pool.query<{ summary: AdminAnswerRunSummary }>(
    `
      select summary
      from ${table}
      ${where.sql}
      order by saved_at desc, run_id desc
      limit $${where.params.length + 1}
      offset $${where.params.length + 2}
    `,
    [...where.params, input.limit, input.offset]
  );

  return {
    runs: result.rows.map((row) => row.summary).filter(isRunSummary),
    page: {
      limit: input.limit,
      offset: input.offset,
      hasMore: input.offset + input.limit < total,
      total,
      storageKind: input.storageKind
    },
    filters: input.filters
  };
}

async function getStoredRunFromPostgres(
  runIdOrTraceId: string
): Promise<AdminAnswerRunDetail | undefined> {
  const pool = getPostgresPool();
  const table = qualifiedAdminRunsTable();
  const result = await pool.query<{
    saved_request: AdminAnswerRunSafeRequest;
    summary: AdminAnswerRunSummary;
    response: AdminAnswerResponse;
    rejected_evidence: AdminRejectedEvidenceSummary;
  }>(
    `
      select saved_request, summary, response, rejected_evidence
      from ${table}
      where run_id = $1 or trace_id = $1
      order by saved_at desc
      limit 1
    `,
    [runIdOrTraceId]
  );
  const row = result.rows[0];
  if (!row || !isRunSummary(row.summary)) return undefined;

  return {
    ...row.summary,
    request: row.saved_request,
    response: row.response,
    rejectedEvidence: row.rejected_evidence
  };
}

function postgresWhereClause(filters: AdminAnswerRunListFilter): {
  readonly sql: string;
  readonly params: unknown[];
} {
  const conditions: string[] = [];
  const params: unknown[] = [];
  const addCondition = (condition: string, value: unknown) => {
    params.push(value);
    conditions.push(condition.replace("?", `$${params.length}`));
  };

  if (filters.status) addCondition("status = ?", filters.status);
  if (filters.tenantId) addCondition("tenant_id = ?", filters.tenantId);
  if (filters.namespaceId) addCondition("namespace_id = ?", filters.namespaceId);
  if (filters.runId) addCondition("run_id ilike ? escape '\\'", `%${escapeLike(filters.runId)}%`);
  if (filters.traceId)
    addCondition("trace_id ilike ? escape '\\'", `%${escapeLike(filters.traceId)}%`);
  if (filters.rejectionCode) addCondition("? = any(rejection_codes)", filters.rejectionCode);
  if (filters.from) addCondition("saved_at >= ?::timestamptz", filters.from);
  if (filters.to) addCondition("saved_at <= ?::timestamptz", filters.to);

  return {
    sql: conditions.length === 0 ? "" : ` where ${conditions.join(" and ")}`,
    params
  };
}

function sanitizeResponseForHistory(response: AdminAnswerResponse): AdminAnswerResponse {
  const sanitized = sanitizeUnknown(response) as AdminAnswerResponse;
  const { answer: _answer, evidenceSummary: _evidenceSummary, ...safeResponse } = sanitized;
  return safeResponse;
}

function safeRequestSummary(
  request: AdminAnswerRequest,
  response: AdminAnswerResponse
): AdminAnswerRunSafeRequest {
  return {
    tenantId: request.tenantId,
    namespaceId: response.trace.namespaceId,
    principalNamespaceCount: request.principal.namespaceIds.length,
    principalTeamCount: request.principal.teamIds.length,
    principalRoleCount: request.principal.roles.length,
    principalTagCount: request.principal.tags.length,
    sourceFilterCount: request.filters?.sourceIds?.length ?? 0,
    documentFilterCount: request.filters?.documentIds?.length ?? 0,
    chunkFilterCount: request.filters?.chunkIds?.length ?? 0,
    ...(request.topK === undefined ? {} : { topK: request.topK }),
    ...(request.candidatePoolLimit === undefined
      ? {}
      : { candidatePoolLimit: request.candidatePoolLimit }),
    includeRejected: request.includeRejected === true
  };
}

function buildRunSummary(input: {
  readonly savedAt: string;
  readonly request: AdminAnswerRunSafeRequest;
  readonly response: AdminAnswerResponse;
  readonly hasAnswer: boolean;
  readonly hasEvidenceSummary: boolean;
}): AdminAnswerRunSummary {
  const retrieval = input.response.retrieval?.trace;
  const context = input.response.context;
  return {
    savedAt: input.savedAt,
    runId: input.response.trace.runId,
    traceId: input.response.trace.traceId,
    status: input.response.status,
    profileId: input.response.trace.profileId,
    namespaceId: input.response.trace.namespaceId,
    tenantId: input.request.tenantId,
    questionHash: input.response.trace.questionHash,
    ...(retrieval?.mode === undefined ? {} : { retrievalMode: retrieval.mode }),
    ...(retrieval?.candidatePoolSize === undefined
      ? {}
      : { candidatePoolSize: retrieval.candidatePoolSize }),
    ...(retrieval?.returnedCount === undefined ? {} : { returnedCount: retrieval.returnedCount }),
    ...(retrieval?.rejectedCount === undefined
      ? {}
      : { retrievalRejectedCount: retrieval.rejectedCount }),
    ...(context?.evidence?.status === undefined ? {} : { contextStatus: context.evidence.status }),
    ...(context?.trace?.blockCount === undefined
      ? {}
      : { contextBlockCount: context.trace.blockCount }),
    ...(context?.trace?.rejectedCount === undefined
      ? {}
      : { contextRejectedCount: context.trace.rejectedCount }),
    finalCitationCount: input.response.trace.finalCitations.length,
    rejectedChunkCount: input.response.trace.rejectedChunkIds.length,
    eventCount: input.response.trace.events.length,
    hasAnswer: input.hasAnswer,
    answerRedacted: input.hasAnswer,
    hasEvidenceSummary: input.hasEvidenceSummary,
    evidenceSummaryRedacted: input.hasEvidenceSummary
  };
}

async function readStoredRuns(): Promise<readonly StoredAdminAnswerRun[]> {
  let raw: string;
  try {
    raw = await readFile(/*turbopackIgnore: true*/ historyFile(), "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error) {
      const code = (error as { code?: unknown }).code;
      if (code === "ENOENT") return [];
    }
    throw error;
  }

  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as StoredAdminAnswerRun];
      } catch {
        return [];
      }
    })
    .filter(isStoredRun);
}

function isStoredRun(value: unknown): value is StoredAdminAnswerRun {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as StoredAdminAnswerRun).savedAt === "string" &&
    typeof (value as StoredAdminAnswerRun).summary?.runId === "string" &&
    typeof (value as StoredAdminAnswerRun).summary?.traceId === "string" &&
    typeof (value as StoredAdminAnswerRun).response?.trace?.runId === "string"
  );
}

function isRunSummary(value: unknown): value is AdminAnswerRunSummary {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as AdminAnswerRunSummary).runId === "string" &&
    typeof (value as AdminAnswerRunSummary).traceId === "string" &&
    typeof (value as AdminAnswerRunSummary).savedAt === "string" &&
    typeof (value as AdminAnswerRunSummary).status === "string"
  );
}

function toDetail(run: StoredAdminAnswerRun): AdminAnswerRunDetail {
  return {
    ...run.summary,
    request: run.request,
    response: run.response,
    rejectedEvidence: run.rejectedEvidence
  };
}

function historyStorageKind(): AdminAnswerRunHistoryStorageKind {
  const configured = process.env.RAG_ADMIN_TRACE_HISTORY_KIND?.trim();
  if (configured === "postgres" || configured === "json_file") return configured;
  if (configured && configured !== "auto") {
    throw new Error("RAG_ADMIN_TRACE_HISTORY_KIND must be one of postgres, json_file, or auto.");
  }
  return postgresConnectionString() === undefined ? "json_file" : "postgres";
}

function getPostgresPool(): Pool {
  const connectionString = postgresConnectionString();
  if (!connectionString) {
    throw new Error(
      "Postgres trace history requires RAG_ADMIN_TRACE_POSTGRES_URL, RAG_ADMIN_TRACE_POSTGRES_URL_ENV, RAG_POSTGRES_URL, or RAG_POSTGRES_URL_ENV."
    );
  }
  postgresPool ??= new pg.Pool({ connectionString });
  return postgresPool;
}

function postgresConnectionString(): string | undefined {
  const direct = process.env.RAG_ADMIN_TRACE_POSTGRES_URL?.trim();
  if (direct) return direct;

  const adminPointer = process.env.RAG_ADMIN_TRACE_POSTGRES_URL_ENV?.trim();
  if (adminPointer) {
    const referenced = process.env[adminPointer]?.trim();
    if (referenced) return referenced;
  }

  const productionPointer = process.env.RAG_POSTGRES_URL_ENV?.trim();
  if (productionPointer) {
    const referenced = process.env[productionPointer]?.trim();
    if (referenced) return referenced;
  }

  const productionDirect = process.env.RAG_POSTGRES_URL?.trim();
  return productionDirect ? productionDirect : undefined;
}

function qualifiedAdminRunsTable(): string {
  return `${quoteIdentifier(postgresSchema())}.${quoteIdentifier(ADMIN_ANSWER_RUNS_TABLE)}`;
}

function postgresSchema(): string {
  return assertSafeIdentifier(
    process.env.RAG_ADMIN_TRACE_POSTGRES_SCHEMA?.trim() ||
      process.env.RAG_POSTGRES_SCHEMA?.trim() ||
      DEFAULT_SCHEMA,
    "Postgres trace schema"
  );
}

function quoteIdentifier(value: string): string {
  return `"${assertSafeIdentifier(value, "identifier").replace(/"/g, '""')}"`;
}

function assertSafeIdentifier(value: string, label: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`${label} must be a safe SQL identifier.`);
  }
  return value;
}

function normalizeFilters(filters: AdminAnswerRunListFilter): AdminAnswerRunListFilter {
  return {
    ...(cleanFilter(filters.status) === undefined ? {} : { status: cleanFilter(filters.status) }),
    ...(cleanFilter(filters.tenantId) === undefined
      ? {}
      : { tenantId: cleanFilter(filters.tenantId) }),
    ...(cleanFilter(filters.namespaceId) === undefined
      ? {}
      : { namespaceId: cleanFilter(filters.namespaceId) }),
    ...(cleanFilter(filters.runId) === undefined ? {} : { runId: cleanFilter(filters.runId) }),
    ...(cleanFilter(filters.traceId) === undefined
      ? {}
      : { traceId: cleanFilter(filters.traceId) }),
    ...(cleanFilter(filters.rejectionCode) === undefined
      ? {}
      : { rejectionCode: cleanFilter(filters.rejectionCode) }),
    ...(cleanDate(filters.from) === undefined ? {} : { from: cleanDate(filters.from) }),
    ...(cleanDate(filters.to) === undefined ? {} : { to: cleanDate(filters.to) })
  };
}

function matchesFilters(run: StoredAdminAnswerRun, filters: AdminAnswerRunListFilter): boolean {
  if (filters.status && run.summary.status !== filters.status) return false;
  if (filters.tenantId && run.summary.tenantId !== filters.tenantId) return false;
  if (filters.namespaceId && run.summary.namespaceId !== filters.namespaceId) return false;
  if (filters.runId && !run.summary.runId.includes(filters.runId)) return false;
  if (filters.traceId && !run.summary.traceId.includes(filters.traceId)) return false;
  if (
    filters.rejectionCode &&
    !run.rejectedEvidence.rejectionCodes.includes(filters.rejectionCode)
  ) {
    return false;
  }
  const savedAt = Date.parse(run.savedAt);
  if (filters.from && savedAt < Date.parse(filters.from)) return false;
  if (filters.to && savedAt > Date.parse(filters.to)) return false;
  return true;
}

function cleanFilter(value: string | undefined): string | undefined {
  const cleaned = value?.trim();
  return cleaned ? cleaned.slice(0, 256) : undefined;
}

function cleanDate(value: string | undefined): string | undefined {
  const cleaned = value?.trim();
  if (!cleaned) return undefined;
  const time = Date.parse(cleaned);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function historyDirectory(): string {
  const configured = process.env.RAG_ADMIN_TRACE_HISTORY_DIR?.trim();
  if (configured) {
    return path.resolve(/*turbopackIgnore: true*/ configured);
  }
  return path.join(/*turbopackIgnore: true*/ resolveRagRepoRoot(), ".rag", "admin-traces");
}

function historyFile(): string {
  return path.join(/*turbopackIgnore: true*/ historyDirectory(), "answer-runs.jsonl");
}

function historyLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_HISTORY_LIMIT;
  return Math.min(MAX_HISTORY_LIMIT, Math.max(1, Math.trunc(value)));
}

function historyOffset(value: number | undefined): number {
  return value === undefined ? 0 : Math.max(0, Math.trunc(value));
}

function sanitizeUnknown(value: unknown, depth = 0): unknown {
  if (depth > 12) return "[redacted:depth_limit]";
  if (typeof value === "string") return redactOperationalText(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeUnknown(item, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, sanitizeUnknown(item, depth + 1)])
    );
  }
  return undefined;
}

function redactOperationalText(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/(api[_-]?key|token|secret|password)=([^&\s]+)/gi, "$1=[redacted]")
    .replace(/postgres(?:ql)?:\/\/[^@\s]+@/gi, "postgres://[redacted]@");
}
