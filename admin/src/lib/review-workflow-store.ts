import "server-only";

import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import type { Pool } from "pg";
import { resolveRagRepoRoot } from "@/lib/repo-root";
import {
  isReviewWorkflowStatus,
  type ReviewWorkflowState,
  type ReviewWorkflowStatus
} from "@/lib/review-workflow-types";

export type ReviewWorkflowStorageKind = "postgres" | "json_file";

export interface ReviewWorkflowUpsertInput {
  readonly itemId: string;
  readonly status: ReviewWorkflowStatus;
  readonly owner?: string;
  readonly note?: string;
  readonly updatedBy?: string;
}

export interface ReviewWorkflowHistoryQuery {
  readonly status?: ReviewWorkflowStatus;
  readonly owner?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export interface ReviewWorkflowHistoryResult {
  readonly generatedAt: string;
  readonly states: readonly ReviewWorkflowState[];
  readonly summary: ReviewWorkflowHistorySummary;
  readonly page: {
    readonly limit: number;
    readonly offset: number;
    readonly hasMore: boolean;
    readonly storageKind: ReviewWorkflowStorageKind;
  };
}

export interface ReviewWorkflowHistorySummary {
  readonly totalCount: number;
  readonly filteredCount: number;
  readonly openCount: number;
  readonly acknowledgedCount: number;
  readonly inReviewCount: number;
  readonly resolvedCount: number;
  readonly dismissedCount: number;
  readonly closedCount: number;
}

interface ReviewWorkflowStateFile {
  readonly updatedAt?: string;
  readonly items?: readonly ReviewWorkflowState[];
}

const DEFAULT_SCHEMA = "rag_core";
const ADMIN_REVIEW_STATES_TABLE = "admin_review_states";
const MAX_ITEM_ID_LENGTH = 512;
const MAX_OWNER_LENGTH = 120;
const MAX_ACTOR_LENGTH = 120;
const MAX_NOTE_LENGTH = 500;

let postgresPool: Pool | undefined;

export async function getReviewWorkflowStates(): Promise<ReadonlyMap<string, ReviewWorkflowState>> {
  if (reviewWorkflowStorageKind() === "postgres") {
    return getReviewWorkflowStatesFromPostgres();
  }

  const file = await readJson<ReviewWorkflowStateFile>(reviewWorkflowFile());
  const states = new Map<string, ReviewWorkflowState>();
  for (const state of file?.items ?? []) {
    if (isReviewWorkflowState(state)) {
      states.set(state.itemId, state);
    }
  }
  return states;
}

export async function upsertReviewWorkflowState(
  input: ReviewWorkflowUpsertInput
): Promise<ReviewWorkflowState> {
  const existing = (await getReviewWorkflowStates()).get(input.itemId);
  const state = buildWorkflowState(input, existing);

  if (reviewWorkflowStorageKind() === "postgres") {
    await upsertReviewWorkflowStateInPostgres(state);
    return state;
  }

  const states = new Map(await getReviewWorkflowStates());
  states.set(state.itemId, state);
  await writeReviewWorkflowStates([...states.values()]);
  return state;
}

export async function listReviewWorkflowHistory(
  query: ReviewWorkflowHistoryQuery = {}
): Promise<ReviewWorkflowHistoryResult> {
  const limit = boundedInteger(query.limit, 25, 1, 100);
  const offset = boundedInteger(query.offset, 0, 0, 50_000);
  const owner = safeOptionalText(query.owner, MAX_OWNER_LENGTH);
  if (reviewWorkflowStorageKind() === "postgres") {
    return listReviewWorkflowHistoryFromPostgres({
      ...(query.status ? { status: query.status } : {}),
      ...(owner ? { owner } : {}),
      limit,
      offset
    });
  }

  const allStates = [...(await getReviewWorkflowStates()).values()].sort(compareWorkflowStates);
  const filtered = allStates.filter(
    (state) =>
      (query.status ? state.status === query.status : true) &&
      (owner ? state.owner === owner : true)
  );
  return {
    generatedAt: new Date().toISOString(),
    states: filtered.slice(offset, offset + limit),
    summary: workflowSummary(allStates, filtered.length),
    page: {
      limit,
      offset,
      hasMore: filtered.length > offset + limit,
      storageKind: "json_file"
    }
  };
}

export function getReviewWorkflowStorageKind(): ReviewWorkflowStorageKind {
  return reviewWorkflowStorageKind();
}

function buildWorkflowState(
  input: ReviewWorkflowUpsertInput,
  existing: ReviewWorkflowState | undefined
): ReviewWorkflowState {
  const now = new Date().toISOString();
  const updatedBy = safeOperatorText(input.updatedBy, "admin_ui", MAX_ACTOR_LENGTH);
  const owner = safeOptionalText(input.owner, MAX_OWNER_LENGTH);
  const note = safeOptionalText(input.note, MAX_NOTE_LENGTH);
  const acknowledgedAt = input.status === "open" ? undefined : (existing?.acknowledgedAt ?? now);
  const acknowledgedBy =
    input.status === "open" ? undefined : (existing?.acknowledgedBy ?? updatedBy);

  return {
    itemId: safeRequiredText(input.itemId, "review item id", MAX_ITEM_ID_LENGTH),
    status: input.status,
    ...(owner ? { owner } : {}),
    ...(note ? { note } : {}),
    ...(acknowledgedAt ? { acknowledgedAt } : {}),
    ...(acknowledgedBy ? { acknowledgedBy } : {}),
    updatedAt: now,
    updatedBy
  };
}

async function getReviewWorkflowStatesFromPostgres(): Promise<
  ReadonlyMap<string, ReviewWorkflowState>
> {
  const pool = getPostgresPool();
  const result = await pool.query<{ state: ReviewWorkflowState }>(
    `
      select state
      from ${qualifiedReviewStatesTable()}
      order by updated_at desc, item_id asc
    `
  );
  const states = new Map<string, ReviewWorkflowState>();
  for (const row of result.rows) {
    if (isReviewWorkflowState(row.state)) {
      states.set(row.state.itemId, row.state);
    }
  }
  return states;
}

async function upsertReviewWorkflowStateInPostgres(state: ReviewWorkflowState): Promise<void> {
  const pool = getPostgresPool();
  await pool.query(
    `
      insert into ${qualifiedReviewStatesTable()} (
        item_id,
        status,
        owner,
        note,
        acknowledged_at,
        acknowledged_by,
        updated_at,
        updated_by,
        state
      )
      values ($1, $2, $3, $4, $5::timestamptz, $6, $7::timestamptz, $8, $9::jsonb)
      on conflict (item_id) do update set
        status = excluded.status,
        owner = excluded.owner,
        note = excluded.note,
        acknowledged_at = excluded.acknowledged_at,
        acknowledged_by = excluded.acknowledged_by,
        updated_at = excluded.updated_at,
        updated_by = excluded.updated_by,
        state = excluded.state
    `,
    [
      state.itemId,
      state.status,
      state.owner ?? null,
      state.note ?? null,
      state.acknowledgedAt ?? null,
      state.acknowledgedBy ?? null,
      state.updatedAt,
      state.updatedBy,
      JSON.stringify(state)
    ]
  );
}

async function listReviewWorkflowHistoryFromPostgres(
  query: Required<Pick<ReviewWorkflowHistoryQuery, "limit" | "offset">> &
    Pick<ReviewWorkflowHistoryQuery, "status" | "owner">
): Promise<ReviewWorkflowHistoryResult> {
  const pool = getPostgresPool();
  const params: unknown[] = [];
  const conditions: string[] = [];
  if (query.status) {
    params.push(query.status);
    conditions.push(`status = $${params.length}`);
  }
  if (query.owner) {
    params.push(query.owner);
    conditions.push(`owner = $${params.length}`);
  }
  const whereSql = conditions.length ? `where ${conditions.join(" and ")}` : "";
  const [statesResult, filteredCountResult, summaryResult] = await Promise.all([
    pool.query<{ state: ReviewWorkflowState }>(
      `
        select state
        from ${qualifiedReviewStatesTable()}
        ${whereSql}
        order by updated_at desc, item_id asc
        limit $${params.length + 1}
        offset $${params.length + 2}
      `,
      [...params, query.limit + 1, query.offset]
    ),
    pool.query<{ count: string }>(
      `
        select count(*)::text as count
        from ${qualifiedReviewStatesTable()}
        ${whereSql}
      `,
      params
    ),
    pool.query<{ status: ReviewWorkflowStatus; count: string }>(
      `
        select status, count(*)::text as count
        from ${qualifiedReviewStatesTable()}
        group by status
      `
    )
  ]);
  const states = statesResult.rows
    .map((row) => row.state)
    .filter(isReviewWorkflowState)
    .slice(0, query.limit);
  const summary = workflowSummaryFromCounts(
    summaryResult.rows.filter((row) => isReviewWorkflowStatus(row.status)),
    numberFromPgCount(filteredCountResult.rows[0]?.count)
  );

  return {
    generatedAt: new Date().toISOString(),
    states,
    summary,
    page: {
      limit: query.limit,
      offset: query.offset,
      hasMore: statesResult.rows.length > query.limit,
      storageKind: "postgres"
    }
  };
}

async function writeReviewWorkflowStates(states: readonly ReviewWorkflowState[]): Promise<void> {
  await mkdir(/*turbopackIgnore: true*/ reviewWorkflowRoot(), { recursive: true });
  const filePath = reviewWorkflowFile();
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(
    /*turbopackIgnore: true*/ temporaryPath,
    JSON.stringify(
      {
        updatedAt: new Date().toISOString(),
        items: [...states].sort((left, right) => left.itemId.localeCompare(right.itemId))
      },
      null,
      2
    ),
    "utf8"
  );
  await rename(/*turbopackIgnore: true*/ temporaryPath, /*turbopackIgnore: true*/ filePath);
}

async function readJson<T>(filePath: string): Promise<T | undefined> {
  if (!existsSync(/*turbopackIgnore: true*/ filePath)) return undefined;
  try {
    return JSON.parse(await readFile(/*turbopackIgnore: true*/ filePath, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function isReviewWorkflowState(value: unknown): value is ReviewWorkflowState {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as ReviewWorkflowState;
  return (
    typeof candidate.itemId === "string" &&
    isReviewWorkflowStatus(candidate.status) &&
    typeof candidate.updatedAt === "string" &&
    typeof candidate.updatedBy === "string" &&
    optionalString(candidate.owner) &&
    optionalString(candidate.note) &&
    optionalString(candidate.acknowledgedAt) &&
    optionalString(candidate.acknowledgedBy)
  );
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function workflowSummary(
  allStates: readonly ReviewWorkflowState[],
  filteredCount: number
): ReviewWorkflowHistorySummary {
  const counts = new Map<ReviewWorkflowStatus, number>();
  for (const state of allStates) {
    counts.set(state.status, (counts.get(state.status) ?? 0) + 1);
  }
  return workflowSummaryFromCounts(
    [...counts.entries()].map(([status, count]) => ({ status, count: String(count) })),
    filteredCount
  );
}

function workflowSummaryFromCounts(
  counts: readonly { readonly status: ReviewWorkflowStatus; readonly count: string }[],
  filteredCount: number
): ReviewWorkflowHistorySummary {
  const byStatus = new Map<ReviewWorkflowStatus, number>();
  for (const row of counts) {
    byStatus.set(row.status, numberFromPgCount(row.count));
  }
  const openCount = byStatus.get("open") ?? 0;
  const acknowledgedCount = byStatus.get("acknowledged") ?? 0;
  const inReviewCount = byStatus.get("in_review") ?? 0;
  const resolvedCount = byStatus.get("resolved") ?? 0;
  const dismissedCount = byStatus.get("dismissed") ?? 0;
  const totalCount = openCount + acknowledgedCount + inReviewCount + resolvedCount + dismissedCount;
  return {
    totalCount,
    filteredCount,
    openCount,
    acknowledgedCount,
    inReviewCount,
    resolvedCount,
    dismissedCount,
    closedCount: resolvedCount + dismissedCount
  };
}

function compareWorkflowStates(left: ReviewWorkflowState, right: ReviewWorkflowState): number {
  const timeDelta = timeRank(right.updatedAt) - timeRank(left.updatedAt);
  if (timeDelta !== 0) return timeDelta;
  return left.itemId.localeCompare(right.itemId);
}

function timeRank(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function numberFromPgCount(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const candidate = value ?? Number.NaN;
  if (!Number.isFinite(candidate)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(candidate)));
}

function reviewWorkflowStorageKind(): ReviewWorkflowStorageKind {
  const configured = process.env.RAG_ADMIN_REVIEW_STATE_KIND?.trim();
  if (configured === "postgres" || configured === "json_file") return configured;
  if (configured && configured !== "auto") {
    throw new Error("RAG_ADMIN_REVIEW_STATE_KIND must be one of postgres, json_file, or auto.");
  }
  return postgresConnectionString() === undefined ? "json_file" : "postgres";
}

function getPostgresPool(): Pool {
  const connectionString = postgresConnectionString();
  if (!connectionString) {
    throw new Error(
      "Postgres review workflow state requires RAG_ADMIN_REVIEW_POSTGRES_URL, RAG_ADMIN_REVIEW_POSTGRES_URL_ENV, RAG_POSTGRES_URL, or RAG_POSTGRES_URL_ENV."
    );
  }
  postgresPool ??= new pg.Pool({ connectionString });
  return postgresPool;
}

function postgresConnectionString(): string | undefined {
  const direct = process.env.RAG_ADMIN_REVIEW_POSTGRES_URL?.trim();
  if (direct) return direct;

  const adminPointer = process.env.RAG_ADMIN_REVIEW_POSTGRES_URL_ENV?.trim();
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

function qualifiedReviewStatesTable(): string {
  return `${quoteIdentifier(postgresSchema())}.${quoteIdentifier(ADMIN_REVIEW_STATES_TABLE)}`;
}

function postgresSchema(): string {
  return assertSafeIdentifier(
    process.env.RAG_ADMIN_REVIEW_POSTGRES_SCHEMA?.trim() ||
      process.env.RAG_POSTGRES_SCHEMA?.trim() ||
      DEFAULT_SCHEMA,
    "Postgres review workflow schema"
  );
}

function safeRequiredText(value: string, label: string, maxLength: number): string {
  const sanitized = safeOptionalText(value, maxLength);
  if (!sanitized) {
    throw new Error(`${label} is required.`);
  }
  return sanitized;
}

function safeOperatorText(value: string | undefined, fallback: string, maxLength: number): string {
  return safeOptionalText(value, maxLength) ?? fallback;
}

function safeOptionalText(value: string | undefined, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = redactOperationalText(value)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
  return normalized || undefined;
}

function redactOperationalText(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/(api[_-]?key|token|secret|password)=([^&\s]+)/gi, "$1=[redacted]")
    .replace(/postgres(?:ql)?:\/\/[^@\s]+@/gi, "postgres://[redacted]@")
    .replace(/\bsk-[A-Za-z0-9]{16,}\b/g, "sk-[redacted]");
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

function reviewWorkflowRoot(): string {
  const configured = process.env.RAG_ADMIN_REVIEW_STATE_DIR?.trim();
  if (configured) {
    return path.resolve(/*turbopackIgnore: true*/ configured);
  }
  return path.join(/*turbopackIgnore: true*/ resolveRagRepoRoot(), ".rag", "admin-review");
}

function reviewWorkflowFile(): string {
  return path.join(/*turbopackIgnore: true*/ reviewWorkflowRoot(), "review-workflow.json");
}
