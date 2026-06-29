import "server-only";

import pg from "pg";

export type AdminDoctorStatus = "passed" | "warning" | "failed";
export type AdminMetadataKind = "postgres" | "json_file";
export type AdminMetadataArea = "trace_history" | "connector_state" | "review_queue";

export interface AdminDoctorResult {
  readonly generatedAt: string;
  readonly status: AdminDoctorStatus;
  readonly checks: readonly AdminDoctorCheck[];
  readonly metadata: {
    readonly traceHistory: AdminMetadataRuntime;
    readonly connectorState: AdminMetadataRuntime;
    readonly reviewWorkflow: AdminMetadataRuntime;
  };
  readonly recommendations: readonly string[];
}

export interface AdminMetadataRuntime {
  readonly area: AdminMetadataArea;
  readonly configuredKind: "postgres" | "json_file" | "auto";
  readonly effectiveKind: AdminMetadataKind;
  readonly schema: string;
  readonly urlConfigured: boolean;
  readonly urlSource?: string;
  readonly requiredMigration: string;
  readonly requiredTables: readonly string[];
}

export interface AdminDoctorCheck {
  readonly id: string;
  readonly label: string;
  readonly status: AdminDoctorStatus;
  readonly area: AdminMetadataArea;
  readonly detail: string;
  readonly recommendation?: string;
  readonly command?: string;
}

interface AdminMetadataConfig {
  readonly area: AdminMetadataArea;
  readonly configuredKind: "postgres" | "json_file" | "auto";
  readonly invalidConfiguredKind?: string;
  readonly effectiveKind: AdminMetadataKind;
  readonly schema: string;
  readonly connectionString?: string;
  readonly urlSource?: string;
  readonly requiredMigration: string;
  readonly tables: readonly AdminMetadataTableRequirement[];
}

interface AdminMetadataTableRequirement {
  readonly tableName: string;
  readonly columns: readonly string[];
}

const DEFAULT_SCHEMA = "rag_core";

const TRACE_TABLES: readonly AdminMetadataTableRequirement[] = [
  {
    tableName: "admin_answer_runs",
    columns: [
      "run_id",
      "trace_id",
      "saved_at",
      "status",
      "summary",
      "response",
      "rejected_evidence"
    ]
  }
];

const CONNECTOR_TABLES: readonly AdminMetadataTableRequirement[] = [
  {
    tableName: "admin_connector_actions",
    columns: [
      "action_id",
      "action",
      "status",
      "requested_at",
      "connector_record_id",
      "result",
      "record"
    ]
  },
  {
    tableName: "admin_connector_disabled_overrides",
    columns: [
      "id",
      "company_id",
      "connector_id",
      "source_id",
      "disabled_at",
      "disabled_by",
      "override"
    ]
  }
];

const REVIEW_TABLES: readonly AdminMetadataTableRequirement[] = [
  {
    tableName: "admin_review_states",
    columns: [
      "item_id",
      "status",
      "owner",
      "note",
      "acknowledged_at",
      "acknowledged_by",
      "updated_at",
      "updated_by",
      "state"
    ]
  }
];

export async function getAdminDoctor(): Promise<AdminDoctorResult> {
  const traceConfig = metadataConfig({
    area: "trace_history",
    kindEnv: "RAG_ADMIN_TRACE_HISTORY_KIND",
    directUrlEnv: "RAG_ADMIN_TRACE_POSTGRES_URL",
    pointerUrlEnv: "RAG_ADMIN_TRACE_POSTGRES_URL_ENV",
    schemaEnv: "RAG_ADMIN_TRACE_POSTGRES_SCHEMA",
    requiredMigration: "deploy/postgres/004_admin_trace_history.sql",
    tables: TRACE_TABLES
  });
  const connectorConfig = metadataConfig({
    area: "connector_state",
    kindEnv: "RAG_ADMIN_CONNECTOR_STATE_KIND",
    directUrlEnv: "RAG_ADMIN_CONNECTOR_POSTGRES_URL",
    pointerUrlEnv: "RAG_ADMIN_CONNECTOR_POSTGRES_URL_ENV",
    schemaEnv: "RAG_ADMIN_CONNECTOR_POSTGRES_SCHEMA",
    requiredMigration: "deploy/postgres/005_admin_connector_state.sql",
    tables: CONNECTOR_TABLES
  });
  const reviewConfig = metadataConfig({
    area: "review_queue",
    kindEnv: "RAG_ADMIN_REVIEW_STATE_KIND",
    directUrlEnv: "RAG_ADMIN_REVIEW_POSTGRES_URL",
    pointerUrlEnv: "RAG_ADMIN_REVIEW_POSTGRES_URL_ENV",
    schemaEnv: "RAG_ADMIN_REVIEW_POSTGRES_SCHEMA",
    requiredMigration: "deploy/postgres/006_admin_review_queue.sql",
    tables: REVIEW_TABLES
  });

  const checkGroups = await Promise.all([
    checksForMetadataConfig(traceConfig),
    checksForMetadataConfig(connectorConfig),
    checksForMetadataConfig(reviewConfig)
  ]);
  const checks = checkGroups.flat();
  const status = aggregateStatus(checks.map((check) => check.status));

  return {
    generatedAt: new Date().toISOString(),
    status,
    checks,
    metadata: {
      traceHistory: metadataRuntime(traceConfig),
      connectorState: metadataRuntime(connectorConfig),
      reviewWorkflow: metadataRuntime(reviewConfig)
    },
    recommendations: checks.flatMap((check) => (check.recommendation ? [check.recommendation] : []))
  };
}

async function checksForMetadataConfig(
  config: AdminMetadataConfig
): Promise<readonly AdminDoctorCheck[]> {
  const checks: AdminDoctorCheck[] = [
    {
      id: `${config.area}.mode`,
      area: config.area,
      label: `${areaLabel(config.area)} mode`,
      status: config.effectiveKind === "postgres" ? "passed" : "warning",
      detail:
        config.effectiveKind === "postgres"
          ? `Using Postgres admin metadata in schema ${config.schema}.`
          : "Using local JSON file admin metadata. This is acceptable for dev, not company production.",
      recommendation:
        config.effectiveKind === "postgres"
          ? undefined
          : `${areaLabel(config.area)} should use Postgres for company deployments.`,
      command: config.effectiveKind === "postgres" ? undefined : metadataEnvCommand(config.area)
    }
  ];

  if (config.invalidConfiguredKind) {
    checks.unshift({
      id: `${config.area}.invalid_mode`,
      area: config.area,
      label: `${areaLabel(config.area)} mode config`,
      status: "failed",
      detail: `Invalid metadata kind "${config.invalidConfiguredKind}".`,
      recommendation: "Use postgres, json_file, or auto.",
      command: metadataEnvCommand(config.area)
    });
    return checks;
  }

  if (config.effectiveKind !== "postgres") return checks;

  if (!config.connectionString) {
    return [
      ...checks,
      {
        id: `${config.area}.postgres_url`,
        area: config.area,
        label: `${areaLabel(config.area)} Postgres URL`,
        status: "failed",
        detail: "Postgres mode is selected, but no admin or production Postgres URL is configured.",
        recommendation: "Point the admin metadata store at the company Postgres database.",
        command: metadataEnvCommand(config.area)
      }
    ];
  }

  const client = new pg.Client({ connectionString: config.connectionString });
  try {
    await client.connect();
    checks.push({
      id: `${config.area}.postgres_connectivity`,
      area: config.area,
      label: `${areaLabel(config.area)} Postgres connectivity`,
      status: "passed",
      detail: `Connected using ${config.urlSource ?? "configured Postgres URL"}.`
    });

    for (const table of config.tables) {
      checks.push(await tableCheck(client, config, table));
    }
  } catch (error) {
    checks.push({
      id: `${config.area}.postgres_connectivity`,
      area: config.area,
      label: `${areaLabel(config.area)} Postgres connectivity`,
      status: "failed",
      detail: redactOperationalText(error instanceof Error ? error.message : "Connection failed."),
      recommendation: "Verify the Postgres URL, network access, credentials, and SSL settings.",
      command: `psql "$RAG_DATABASE_URL" -c 'select 1'`
    });
  } finally {
    await client.end().catch(() => undefined);
  }

  return checks;
}

async function tableCheck(
  client: pg.Client,
  config: AdminMetadataConfig,
  table: AdminMetadataTableRequirement
): Promise<AdminDoctorCheck> {
  const existsResult = await client.query<{ exists: boolean }>(
    "select to_regclass($1)::text is not null as exists",
    [`${config.schema}.${table.tableName}`]
  );
  const exists = existsResult.rows[0]?.exists === true;
  if (!exists) {
    return {
      id: `${config.area}.${table.tableName}`,
      area: config.area,
      label: `${areaLabel(config.area)} table ${table.tableName}`,
      status: "failed",
      detail: `Missing ${config.schema}.${table.tableName}.`,
      recommendation: `Apply ${config.requiredMigration}.`,
      command: `psql "$RAG_DATABASE_URL" -f ${config.requiredMigration}`
    };
  }

  const columnsResult = await client.query<{ column_name: string }>(
    `
      select column_name
      from information_schema.columns
      where table_schema = $1
        and table_name = $2
        and column_name = any($3::text[])
    `,
    [config.schema, table.tableName, [...table.columns]]
  );
  const presentColumns = new Set(columnsResult.rows.map((row) => row.column_name));
  const missingColumns = table.columns.filter((column) => !presentColumns.has(column));
  if (missingColumns.length > 0) {
    return {
      id: `${config.area}.${table.tableName}.columns`,
      area: config.area,
      label: `${areaLabel(config.area)} columns ${table.tableName}`,
      status: "failed",
      detail: `Missing columns: ${missingColumns.join(", ")}.`,
      recommendation: `Reapply or repair ${config.requiredMigration}.`,
      command: `psql "$RAG_DATABASE_URL" -f ${config.requiredMigration}`
    };
  }

  return {
    id: `${config.area}.${table.tableName}`,
    area: config.area,
    label: `${areaLabel(config.area)} table ${table.tableName}`,
    status: "passed",
    detail: `${config.schema}.${table.tableName} has required columns.`
  };
}

function metadataConfig(input: {
  readonly area: AdminMetadataArea;
  readonly kindEnv: string;
  readonly directUrlEnv: string;
  readonly pointerUrlEnv: string;
  readonly schemaEnv: string;
  readonly requiredMigration: string;
  readonly tables: readonly AdminMetadataTableRequirement[];
}): AdminMetadataConfig {
  const configured = metadataKind(input.kindEnv);
  const connection = postgresConnection(input.directUrlEnv, input.pointerUrlEnv);
  return {
    area: input.area,
    configuredKind: configured.kind,
    invalidConfiguredKind: configured.invalidValue,
    effectiveKind:
      configured.kind === "auto"
        ? connection.connectionString === undefined
          ? "json_file"
          : "postgres"
        : configured.kind,
    schema: postgresSchema(input.schemaEnv),
    connectionString: connection.connectionString,
    urlSource: connection.source,
    requiredMigration: input.requiredMigration,
    tables: input.tables
  };
}

function metadataRuntime(config: AdminMetadataConfig): AdminMetadataRuntime {
  return {
    area: config.area,
    configuredKind: config.configuredKind,
    effectiveKind: config.effectiveKind,
    schema: config.schema,
    urlConfigured: config.connectionString !== undefined,
    urlSource: config.urlSource,
    requiredMigration: config.requiredMigration,
    requiredTables: config.tables.map((table) => table.tableName)
  };
}

function metadataKind(envName: string): {
  readonly kind: "postgres" | "json_file" | "auto";
  readonly invalidValue?: string;
} {
  const configured = process.env[envName]?.trim();
  if (configured === "postgres" || configured === "json_file" || configured === "auto") {
    return { kind: configured };
  }
  if (configured) {
    return { kind: "auto", invalidValue: configured.slice(0, 80) };
  }
  return { kind: "auto" };
}

function postgresConnection(
  directUrlEnv: string,
  pointerUrlEnv: string
): { readonly connectionString?: string; readonly source?: string } {
  const direct = process.env[directUrlEnv]?.trim();
  if (direct) return { connectionString: direct, source: directUrlEnv };

  const adminPointer = process.env[pointerUrlEnv]?.trim();
  if (adminPointer) {
    const referenced = process.env[adminPointer]?.trim();
    if (referenced)
      return { connectionString: referenced, source: `${pointerUrlEnv}:${adminPointer}` };
  }

  const productionPointer = process.env.RAG_POSTGRES_URL_ENV?.trim();
  if (productionPointer) {
    const referenced = process.env[productionPointer]?.trim();
    if (referenced)
      return { connectionString: referenced, source: `RAG_POSTGRES_URL_ENV:${productionPointer}` };
  }

  const productionDirect = process.env.RAG_POSTGRES_URL?.trim();
  return productionDirect ? { connectionString: productionDirect, source: "RAG_POSTGRES_URL" } : {};
}

function postgresSchema(schemaEnv: string): string {
  return assertSafeIdentifier(
    process.env[schemaEnv]?.trim() || process.env.RAG_POSTGRES_SCHEMA?.trim() || DEFAULT_SCHEMA,
    "Postgres admin doctor schema"
  );
}

function aggregateStatus(statuses: readonly AdminDoctorStatus[]): AdminDoctorStatus {
  if (statuses.some((status) => status === "failed")) return "failed";
  if (statuses.some((status) => status === "warning")) return "warning";
  return "passed";
}

function areaLabel(area: AdminMetadataArea): string {
  switch (area) {
    case "trace_history":
      return "Trace history";
    case "connector_state":
      return "Connector state";
    case "review_queue":
      return "Review queue";
  }
}

function metadataEnvCommand(area: AdminMetadataArea): string {
  switch (area) {
    case "trace_history":
      return "RAG_ADMIN_TRACE_HISTORY_KIND=postgres RAG_ADMIN_TRACE_POSTGRES_URL_ENV=RAG_DATABASE_URL";
    case "connector_state":
      return "RAG_ADMIN_CONNECTOR_STATE_KIND=postgres RAG_ADMIN_CONNECTOR_POSTGRES_URL_ENV=RAG_DATABASE_URL";
    case "review_queue":
      return "RAG_ADMIN_REVIEW_STATE_KIND=postgres RAG_ADMIN_REVIEW_POSTGRES_URL_ENV=RAG_DATABASE_URL";
  }
}

function assertSafeIdentifier(value: string, label: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`${label} must be a safe SQL identifier.`);
  }
  return value;
}

function redactOperationalText(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/(api[_-]?key|token|secret|password)=([^&\s]+)/gi, "$1=[redacted]")
    .replace(/postgres(?:ql)?:\/\/[^@\s]+@/gi, "postgres://[redacted]@")
    .slice(0, 1200);
}
