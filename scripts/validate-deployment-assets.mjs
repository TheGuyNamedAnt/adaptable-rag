#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const files = {
  dockerfile: read("Dockerfile"),
  dockerignore: read(".dockerignore"),
  compose: read("docker-compose.yml"),
  envExample: read(".env.example"),
  packageJson: JSON.parse(read("package.json")),
  companyPostgresSmokeWorkflow: read(
    path.join(".github", "workflows", "company-postgres-smoke.yml")
  ),
  deployReadme: read(path.join("deploy", "README.md")),
  localFilesExample: read(path.join("deploy", "local-files.example.json")),
  approvedKnowledgeExample: read(path.join("deploy", "approved-knowledge-artifacts.example.json")),
  providerSmokeExample: read(path.join("deploy", "provider-smoke.example.env")),
  companyProductionExample: read(path.join("deploy", "company-production.example.env")),
  companyProductionRunbook: read(path.join("deploy", "company-production-runbook.md")),
  postgresCompose: read(path.join("deploy", "postgres", "docker-compose.pgvector.yml")),
  postgresCoreStorage: read(path.join("deploy", "postgres", "001_core_storage.sql")),
  postgresGenerationPromotions: read(
    path.join("deploy", "postgres", "008_index_generation_promotions.sql")
  ),
  adminIndexGenerationRoute: read(
    path.join("admin", "src", "app", "api", "rag", "index-generations", "route.ts")
  ),
  adminGenerationPromotionRoute: read(
    path.join(
      "admin",
      "src",
      "app",
      "api",
      "rag",
      "generation-promotions",
      "[promotionId]",
      "route.ts"
    )
  ),
  adminGenerationPromotionActionsRoute: read(
    path.join("admin", "src", "app", "api", "rag", "generation-promotions", "actions", "route.ts")
  ),
  adminQualityOpsPage: read(path.join("admin", "src", "app", "quality-ops", "page.tsx")),
  adminGenerationPromotionPanel: read(
    path.join("admin", "src", "components", "GenerationPromotionPanel.tsx")
  ),
  projectSupportConnectorReadme: read(
    path.join("templates", "project-support-connector", "README.md")
  ),
  projectSupportConnectorExporter: read(
    path.join("templates", "project-support-connector", "src", "project-support-event-exporter.ts")
  ),
  projectSupportConnectorTest: read(
    path.join(
      "templates",
      "project-support-connector",
      "src",
      "project-support-event-exporter.test.ts"
    )
  ),
  companyConnectorPackReadme: read(path.join("templates", "company-connector-pack", "README.md")),
  companyConnectorPackProfile: read(
    path.join("templates", "company-connector-pack", "src", "company-profile.ts")
  ),
  companyConnectorPackAdapterPack: read(
    path.join("templates", "company-connector-pack", "src", "company-adapter-pack.ts")
  ),
  companyConnectorPackTest: read(
    path.join("templates", "company-connector-pack", "src", "company-connector-pack.test.ts")
  ),
  companyConnectorPackGoldenEval: read(
    path.join(
      "templates",
      "company-connector-pack",
      "profiles",
      "company-docs",
      "docs",
      "golden.jsonl"
    )
  ),
  companyConnectorPackAdversarialEval: read(
    path.join(
      "templates",
      "company-connector-pack",
      "profiles",
      "company-docs",
      "docs",
      "adversarial.jsonl"
    )
  )
};

const checks = [
  check("Dockerfile uses Node 24 runtime", files.dockerfile.includes("FROM node:24-bookworm-slim")),
  check(
    "Dockerfile builds TypeScript before runtime stage",
    files.dockerfile.includes("npm run build")
  ),
  check("Dockerfile prunes dev dependencies", files.dockerfile.includes("npm prune --omit=dev")),
  check("Dockerfile runs as non-root rag user", files.dockerfile.includes("USER rag")),
  check(
    "Dockerfile exposes production CLI serve command",
    files.dockerfile.includes('"dist/runtime/production-cli.js", "serve"')
  ),
  check("Dockerfile defines a healthcheck", files.dockerfile.includes("HEALTHCHECK")),
  check("Dockerfile healthcheck uses readiness", files.dockerfile.includes("/ready")),
  check("Docker context excludes node_modules", lineExists(files.dockerignore, "node_modules")),
  check("Docker context excludes dist", lineExists(files.dockerignore, "dist")),
  check("Docker context excludes local env files", lineExists(files.dockerignore, ".env")),
  check("Docker context keeps env example", lineExists(files.dockerignore, "!.env.example")),
  check("Compose builds runtime target", files.compose.includes("target: runtime")),
  check("Compose exposes port 8787", files.compose.includes('"8787:8787"')),
  check("Compose mounts /data volume", files.compose.includes("rag_data:/data")),
  check("Compose uses read-only root filesystem", files.compose.includes("read_only: true")),
  check("Compose drops Linux capabilities", files.compose.includes("cap_drop:")),
  check("Compose enables no-new-privileges", files.compose.includes("no-new-privileges:true")),
  check("Compose healthcheck uses readiness", files.compose.includes("/ready")),
  check("Env example uses profile preset", envValue("RAG_APP_PROFILE_PRESET") === "generic-docs"),
  check(
    "Env example references local-files source config",
    envValue("RAG_LOCAL_FILES_SOURCES_PATH") === "/data/local-files.sources.json"
  ),
  check(
    "Env example documents approved knowledge source config",
    files.envExample.includes("RAG_APPROVED_KNOWLEDGE_ARTIFACTS_PATH")
  ),
  check(
    "Env example documents company deployment module config",
    files.envExample.includes("RAG_COMPANY_MODULE_PATH") &&
      files.envExample.includes("RAG_COMPANY_DEPLOYMENT_EXPORT") &&
      files.envExample.includes("RAG_COMPANY_PACK_CONTRACT_MODE")
  ),
  check("Env example uses durable index path", envValue("RAG_INDEX_PATH") === "/data/index.json"),
  check("Env example requires HTTP auth", envValue("RAG_HTTP_AUTH_MODE") === "required"),
  check(
    "Env example references HTTP auth token env",
    envValue("RAG_HTTP_AUTH_TOKEN_ENV") === "RAG_HTTP_AUTH_TOKEN"
  ),
  check(
    "Env example enables HTTP rate limiting",
    envValue("RAG_HTTP_RATE_LIMIT_MODE") === "enabled"
  ),
  check(
    "Env example sets HTTP rate limit max requests",
    envValue("RAG_HTTP_RATE_LIMIT_MAX_REQUESTS") === "60"
  ),
  check("Env example enables JSON HTTP logs", envValue("RAG_HTTP_LOG_MODE") === "json"),
  check(
    "Env example configures request id header",
    envValue("RAG_HTTP_REQUEST_ID_HEADER") === "x-request-id"
  ),
  check("Env example configures readiness path", envValue("RAG_HTTP_READINESS_PATH") === "/ready"),
  check("Env example configures metrics path", envValue("RAG_HTTP_METRICS_PATH") === "/metrics"),
  check(
    "Env example references model secret env",
    envValue("RAG_MODEL_API_KEY_ENV") === "ANSWER_MODEL_KEY"
  ),
  check("Env example does not contain obvious live secrets", !containsLiveSecret(files.envExample)),
  check(
    "Package exposes adaptable-rag bin",
    files.packageJson.bin?.["adaptable-rag"] === "dist/runtime/production-cli.js"
  ),
  check(
    "Package exposes public ESM and type entrypoints",
    files.packageJson.main === "dist/index.js" &&
      files.packageJson.types === "dist/index.d.ts" &&
      files.packageJson.exports?.["."]?.import === "./dist/index.js" &&
      files.packageJson.exports?.["."]?.types === "./dist/index.d.ts"
  ),
  check(
    "Package serve script uses production CLI",
    files.packageJson.scripts?.serve === "node dist/runtime/production-cli.js serve"
  ),
  check(
    "Package exposes provider smoke script",
    files.packageJson.scripts?.["smoke:providers"] ===
      "npm run build && node scripts/run-provider-smoke.mjs --report-dir .rag/provider-smoke/latest"
  ),
  check(
    "Package exposes company deployment validator",
    files.packageJson.scripts?.["company:validate"] ===
      "npm run build && node scripts/validate-company-deployment.mjs"
  ),
  check(
    "Package exposes company deployment smoke script",
    files.packageJson.scripts?.["company:smoke"] ===
      "npm run build && node scripts/run-company-deployment-smoke.mjs --report-dir .rag/company-smoke/latest"
  ),
  check(
    "Package exposes company Postgres smoke script",
    files.packageJson.scripts?.["company:smoke:postgres"] ===
      "npm run build && node scripts/run-company-postgres-smoke.mjs --report-dir .rag/company-postgres-smoke/latest"
  ),
  check(
    "CI includes company Postgres smoke workflow",
    files.companyPostgresSmokeWorkflow.includes("pgvector/pgvector:pg17") &&
      files.companyPostgresSmokeWorkflow.includes("npm run company:smoke:postgres") &&
      files.companyPostgresSmokeWorkflow.includes("--local-provider") &&
      files.companyPostgresSmokeWorkflow.includes("--reset-schema") &&
      files.companyPostgresSmokeWorkflow.includes("--probe-providers") &&
      files.companyPostgresSmokeWorkflow.includes("RAG_DATABASE_URL") &&
      files.companyPostgresSmokeWorkflow.includes(".rag/company-postgres-smoke/ci") &&
      files.companyPostgresSmokeWorkflow.includes("actions/upload-artifact@v4")
  ),
  check(
    "Package CI validates company deployments",
    files.packageJson.scripts?.ci?.includes("npm run company:validate")
  ),
  check(
    "Package CI smokes company deployments",
    files.packageJson.scripts?.ci?.includes("npm run company:smoke")
  ),
  check(
    "Package exposes eval trace replay script",
    files.packageJson.scripts?.["replay:eval"] ===
      "npm run build && node scripts/run-trace-replay.mjs --eval-summary .rag/eval-runs/latest/summary.json --report-dir .rag/trace-replay/latest"
  ),
  check(
    "Package exposes SLO check script",
    files.packageJson.scripts?.["slo:check"] ===
      "npm run build && node scripts/run-slo-check.mjs --eval-benchmark .rag/eval-runs/latest/benchmark.json --trace-replay .rag/trace-replay/latest/replay.json --report-dir .rag/slo/latest"
  ),
  check(
    "Package exposes alert delivery script",
    files.packageJson.scripts?.["alerts:deliver"] ===
      "npm run build && node scripts/deliver-alerts.mjs --alerts .rag/slo/latest/alerts.json --report-dir .rag/alert-delivery/latest --mode dry-run"
  ),
  check(
    "Package exposes incident bundle script",
    files.packageJson.scripts?.["incident:bundle"] ===
      "npm run build && node scripts/build-incident-bundle.mjs --eval-benchmark .rag/eval-runs/latest/benchmark.json --eval-summary .rag/eval-runs/latest/summary.json --trace-replay .rag/trace-replay/latest/replay.json --slo .rag/slo/latest/slo.json --alert-delivery .rag/alert-delivery/latest/delivery.json --report-dir .rag/incidents/latest"
  ),
  check(
    "Package exposes human review queue script",
    files.packageJson.scripts?.["review:queue"] ===
      "npm run build && node scripts/build-review-queue.mjs --eval-summary .rag/eval-runs/latest/summary.json --incident .rag/incidents/latest/incident.json --report-dir .rag/human-review/latest"
  ),
  check(
    "Package exposes review decision ledger script",
    files.packageJson.scripts?.["review:ledger"] ===
      "npm run build && node scripts/build-review-ledger.mjs --queue .rag/human-review/latest/queue.json --report-dir .rag/review-ledger/latest"
  ),
  check(
    "Package exposes admin review workflow export script",
    files.packageJson.scripts?.["review:admin-export"] ===
      "node scripts/export-admin-review-workflow.mjs --report-dir .rag/admin-review-export/latest"
  ),
  check(
    "Package exposes review ticket sync script",
    files.packageJson.scripts?.["review:sync"] ===
      "npm run build && node scripts/sync-review-tickets.mjs --queue .rag/human-review/latest/queue.json --ledger .rag/review-ledger/latest/ledger.json --report-dir .rag/review-sync/latest --mode dry-run"
  ),
  check(
    "Package exposes review ticket reconciliation script",
    files.packageJson.scripts?.["review:reconcile"] ===
      "npm run build && node scripts/reconcile-review-tickets.mjs --tickets .rag/review-sync/latest/tickets.json --sync .rag/review-sync/latest/sync.json --report-dir .rag/review-reconciliation/latest"
  ),
  check(
    "Package exposes support knowledge flow script",
    files.packageJson.scripts?.["support:knowledge"] ===
      "npm run build && node scripts/run-support-knowledge-flow.mjs --events .rag/support-knowledge/events.jsonl --report-dir .rag/support-knowledge/latest"
  ),
  check(
    "Package exposes support operator drill script",
    files.packageJson.scripts?.["support:drill"] ===
      "npm run build && node scripts/run-support-operator-drill.mjs --events .rag/support-knowledge/events.jsonl --report-dir .rag/support-drill/latest"
  ),
  check(
    "Package exposes support event export validator script",
    files.packageJson.scripts?.["support:export:validate"] ===
      "npm run build && node scripts/validate-support-event-export.mjs --events .rag/support-knowledge/events.jsonl --report-dir .rag/support-export/latest"
  ),
  check(
    "Package CI runs eval trace replay",
    files.packageJson.scripts?.ci?.includes("npm run replay:eval")
  ),
  check("Package CI runs SLO check", files.packageJson.scripts?.ci?.includes("npm run slo:check")),
  check(
    "Package CI runs alert delivery dry-run",
    files.packageJson.scripts?.ci?.includes("npm run alerts:deliver")
  ),
  check(
    "Package CI builds incident bundle",
    files.packageJson.scripts?.ci?.includes("npm run incident:bundle")
  ),
  check(
    "Package CI builds human review queue",
    files.packageJson.scripts?.ci?.includes("npm run review:queue")
  ),
  check(
    "Package CI builds review decision ledger",
    files.packageJson.scripts?.ci?.includes("npm run review:ledger")
  ),
  check(
    "Package CI dry-runs review ticket sync",
    files.packageJson.scripts?.ci?.includes("npm run review:sync")
  ),
  check(
    "Package CI reconciles review ticket state",
    files.packageJson.scripts?.ci?.includes("npm run review:reconcile")
  ),
  check(
    "Deployment docs mention auth and rate limiting",
    files.deployReadme.includes("RAG_HTTP_AUTH_TOKEN") &&
      files.deployReadme.includes("RAG_HTTP_RATE_LIMIT_MAX_REQUESTS")
  ),
  check(
    "Deployment docs mention production ingestion",
    files.deployReadme.includes("production-cli.js ingest") &&
      files.deployReadme.includes("RAG_LOCAL_FILES_SOURCES_PATH") &&
      files.deployReadme.includes("IngestPipeline")
  ),
  check(
    "Deployment docs mention approved knowledge ingestion",
    files.deployReadme.includes("RAG_APPROVED_KNOWLEDGE_ARTIFACTS_PATH") &&
      files.deployReadme.includes("approvedArtifacts") &&
      files.deployReadme.includes("approval ledger")
  ),
  check(
    "Deployment docs mention adapter extension and company module registration",
    files.deployReadme.includes("adapterExtensions") &&
      files.deployReadme.includes("RAG_COMPANY_MODULE_PATH") &&
      files.deployReadme.includes("RAG_COMPANY_DEPLOYMENT_EXPORT") &&
      files.deployReadme.includes("unknown adapter IDs")
  ),
  check(
    "Deployment docs mention adapter contract tests",
    files.deployReadme.includes("assertCorpusAdapterContract()") &&
      files.deployReadme.includes("same normalization rules")
  ),
  check(
    "Deployment docs mention company pack contract validation",
    files.deployReadme.includes("--run-pack-contracts") &&
      files.deployReadme.includes("--adapter-pack-export") &&
      files.deployReadme.includes("company-pack-contracts.json")
  ),
  check(
    "Deployment docs mention production company sync",
    files.deployReadme.includes("production-cli.js sync") &&
      files.deployReadme.includes("--mode delta") &&
      files.deployReadme.includes("--mode full") &&
      files.deployReadme.includes("--delete-missing false")
  ),
  check(
    "Deployment docs mention company deployment smoke reports",
    files.deployReadme.includes("npm run company:smoke") &&
      files.deployReadme.includes(".rag/company-smoke/latest") &&
      files.deployReadme.includes("smoke.json")
  ),
  check(
    "Deployment docs mention company Postgres env and runbook",
    files.deployReadme.includes("company-production.example.env") &&
      files.deployReadme.includes("company-production-runbook.md") &&
      files.deployReadme.includes("RAG_SOURCE_SYNC_LEDGER_KIND=postgres")
  ),
  check(
    "Deployment docs mention company Postgres smoke reports",
    files.deployReadme.includes("npm run company:smoke:postgres") &&
      files.deployReadme.includes("docker-compose.pgvector.yml") &&
      files.deployReadme.includes(".rag/company-postgres-smoke/latest") &&
      files.deployReadme.includes("postgres-company-smoke.json") &&
      files.deployReadme.includes("--local-provider") &&
      files.deployReadme.includes(".github/workflows/company-postgres-smoke.yml")
  ),
  check(
    "Deployment includes local-files source example",
    files.localFilesExample.includes('"sourceId": "curated_docs"') &&
      files.localFilesExample.includes('"rootDir": "/data/corpus/curated_docs"')
  ),
  check(
    "Deployment includes approved knowledge source example",
    files.approvedKnowledgeExample.includes('"sourceId": "approved_knowledge_generic-docs"') &&
      files.approvedKnowledgeExample.includes('"ledgerPaths"') &&
      files.approvedKnowledgeExample.includes('"connector": "support-bridge"')
  ),
  check(
    "Deployment includes provider smoke env example",
    files.providerSmokeExample.includes("RAG_SMOKE_REQUIRED_PROVIDERS=model,embedding") &&
      files.providerSmokeExample.includes("RAG_MODEL_API_KEY_ENV=OPENAI_API_KEY") &&
      !containsLiveSecret(files.providerSmokeExample)
  ),
  check(
    "Deployment includes company production Postgres env example",
    envValueFrom(files.companyProductionExample, "RAG_INDEX_KIND") === "postgres" &&
      envValueFrom(files.companyProductionExample, "RAG_VECTOR_KIND") === "postgres" &&
      envValueFrom(files.companyProductionExample, "RAG_SOURCE_SYNC_LEDGER_KIND") === "postgres" &&
      envValueFrom(files.companyProductionExample, "RAG_POSTGRES_URL_ENV") === "RAG_DATABASE_URL" &&
      envValueFrom(files.companyProductionExample, "RAG_ADMIN_TRACE_HISTORY_KIND") === "postgres" &&
      envValueFrom(files.companyProductionExample, "RAG_ADMIN_TRACE_POSTGRES_URL_ENV") ===
        "RAG_DATABASE_URL" &&
      envValueFrom(files.companyProductionExample, "RAG_ADMIN_CONNECTOR_STATE_KIND") ===
        "postgres" &&
      envValueFrom(files.companyProductionExample, "RAG_ADMIN_CONNECTOR_POSTGRES_URL_ENV") ===
        "RAG_DATABASE_URL" &&
      envValueFrom(files.companyProductionExample, "RAG_ADMIN_REVIEW_STATE_KIND") === "postgres" &&
      envValueFrom(files.companyProductionExample, "RAG_ADMIN_REVIEW_POSTGRES_URL_ENV") ===
        "RAG_DATABASE_URL" &&
      envValueFrom(files.companyProductionExample, "RAG_VECTOR_DIMENSIONS") === "1536" &&
      envValueFrom(files.companyProductionExample, "RAG_APP_EMBEDDING_MODE") === "required" &&
      envValueFrom(files.companyProductionExample, "RAG_APP_GROUNDING_JUDGE_MODE") === "required" &&
      envValueFrom(files.companyProductionExample, "RAG_COMPANY_PACK_CONTRACT_MODE") ===
        "required" &&
      files.companyProductionExample.includes("RAG_COMPANY_MODULE_PATH") &&
      files.companyProductionExample.includes("RAG_COMPANY_DEPLOYMENT_EXPORT") &&
      !containsLiveSecret(files.companyProductionExample)
  ),
  check(
    "Deployment includes company production promotion runbook",
    files.companyProductionRunbook.includes("deploy/postgres/001_core_storage.sql") &&
      files.companyProductionRunbook.includes("deploy/postgres/002_vector_hnsw_1536.sql") &&
      files.companyProductionRunbook.includes("deploy/postgres/003_ingestion_failure_stage.sql") &&
      files.companyProductionRunbook.includes("deploy/postgres/004_admin_trace_history.sql") &&
      files.companyProductionRunbook.includes("deploy/postgres/005_admin_connector_state.sql") &&
      files.companyProductionRunbook.includes("deploy/postgres/006_admin_review_queue.sql") &&
      files.companyProductionRunbook.includes("deploy/postgres/007_ingestion_scale_queue.sql") &&
      files.companyProductionRunbook.includes(
        "deploy/postgres/008_index_generation_promotions.sql"
      ) &&
      files.companyProductionRunbook.includes("validate-config --self-test true") &&
      files.companyProductionRunbook.includes("npm run company:smoke") &&
      files.companyProductionRunbook.includes("npm run company:smoke:postgres") &&
      files.companyProductionRunbook.includes("--sync-mode full") &&
      files.companyProductionRunbook.includes("--sync-mode delta") &&
      files.companyProductionRunbook.includes("enqueue-ingestion") &&
      files.companyProductionRunbook.includes("worker_acme_1") &&
      files.companyProductionRunbook.includes("inspect-ingestion-queue") &&
      files.companyProductionRunbook.includes("cancel-ingestion-queue-job") &&
      files.companyProductionRunbook.includes("requeue-ingestion-queue-job") &&
      files.companyProductionRunbook.includes("plan-generation-promotion") &&
      files.companyProductionRunbook.includes("record-generation-eval") &&
      files.companyProductionRunbook.includes("inspect-generation-promotion") &&
      files.companyProductionRunbook.includes("promote-generation") &&
      files.companyProductionRunbook.includes("inspect-index-generations") &&
      files.companyProductionRunbook.includes(".rag/company-smoke/latest/smoke.json") &&
      files.companyProductionRunbook.includes(
        ".rag/company-postgres-smoke/latest/postgres-company-smoke.json"
      ) &&
      files.companyProductionRunbook.includes(".github/workflows/company-postgres-smoke.yml") &&
      files.companyProductionRunbook.includes("/ready") &&
      !containsLiveSecret(files.companyProductionRunbook)
  ),
  check(
    "Deployment includes local pgvector compose service",
    files.postgresCompose.includes("pgvector/pgvector") &&
      files.postgresCompose.includes("54329:5432") &&
      files.postgresCompose.includes("pg_isready") &&
      files.postgresCompose.includes("rag_pgvector_data")
  ),
  check(
    "Postgres vector schema includes embedding identity filter index",
    files.postgresCoreStorage.includes("rag_chunk_vectors_identity_idx") &&
      files.postgresCoreStorage.includes("(metadata->>'embeddingProvider')") &&
      files.postgresCoreStorage.includes("(metadata->>'embeddingConfigHash')")
  ),
  check(
    "Postgres generation promotion schema enforces one active generation per scope",
    files.postgresGenerationPromotions.includes("index_generation_manifests") &&
      files.postgresGenerationPromotions.includes("index_generation_promotions") &&
      files.postgresGenerationPromotions.includes("where status = 'active'")
  ),
  check(
    "Deployment docs mention generation promotion control commands",
    files.deployReadme.includes("plan-generation-promotion") &&
      files.deployReadme.includes("record-generation-eval") &&
      files.deployReadme.includes("promote-generation") &&
      files.deployReadme.includes("inspect-index-generations") &&
      files.deployReadme.includes("inspect-generation-promotion")
  ),
  check(
    "Admin API exposes generation promotion control plane",
    files.adminIndexGenerationRoute.includes("getIndexGenerations") &&
      files.adminGenerationPromotionRoute.includes("getGenerationPromotion") &&
      files.adminGenerationPromotionActionsRoute.includes("planGenerationPromotion") &&
      files.adminGenerationPromotionActionsRoute.includes("recordGenerationEval") &&
      files.adminGenerationPromotionActionsRoute.includes("promoteGeneration")
  ),
  check(
    "Admin UI exposes generation promotion control plane",
    files.adminQualityOpsPage.includes("GenerationPromotionPanel") &&
      files.adminQualityOpsPage.includes("getIndexGenerations") &&
      files.adminGenerationPromotionPanel.includes("/api/rag/generation-promotions/actions") &&
      files.adminGenerationPromotionPanel.includes("record_eval") &&
      files.adminGenerationPromotionPanel.includes("Promote")
  ),
  check(
    "Deployment docs mention operations endpoints",
    files.deployReadme.includes("RAG_HTTP_REQUEST_ID_HEADER") &&
      files.deployReadme.includes("/ready") &&
      files.deployReadme.includes("/metrics")
  ),
  check(
    "Deployment docs mention provider smoke reports",
    files.deployReadme.includes("npm run smoke:providers") &&
      files.deployReadme.includes(".rag/provider-smoke/latest") &&
      files.deployReadme.includes("provider-smoke.example.env")
  ),
  check(
    "Deployment docs mention trace replay reports",
    files.deployReadme.includes("npm run replay:eval") &&
      files.deployReadme.includes(".rag/trace-replay/latest") &&
      files.deployReadme.includes("--trace-id")
  ),
  check(
    "Deployment docs mention SLO alert reports",
    files.deployReadme.includes("npm run slo:check") &&
      files.deployReadme.includes(".rag/slo/latest") &&
      files.deployReadme.includes("alerts.json")
  ),
  check(
    "Deployment docs mention alert delivery reports",
    files.deployReadme.includes("npm run alerts:deliver") &&
      files.deployReadme.includes(".rag/alert-delivery/latest") &&
      files.deployReadme.includes("delivery.json") &&
      files.deployReadme.includes("RAG_ALERT_WEBHOOK_URL")
  ),
  check(
    "Deployment docs mention incident bundle reports",
    files.deployReadme.includes("npm run incident:bundle") &&
      files.deployReadme.includes(".rag/incidents/latest") &&
      files.deployReadme.includes("postmortem.md") &&
      files.deployReadme.includes("incident.json")
  ),
  check(
    "Deployment docs mention human review queue reports",
    files.deployReadme.includes("npm run review:queue") &&
      files.deployReadme.includes(".rag/human-review/latest") &&
      files.deployReadme.includes("queue.json") &&
      files.deployReadme.includes("queue.md")
  ),
  check(
    "Deployment docs mention review decision ledger reports",
    files.deployReadme.includes("npm run review:ledger") &&
      files.deployReadme.includes(".rag/review-ledger/latest") &&
      files.deployReadme.includes("ledger.json") &&
      files.deployReadme.includes("feedback.json")
  ),
  check(
    "Deployment docs mention admin review workflow export reports",
    files.deployReadme.includes("npm run review:admin-export") &&
      files.deployReadme.includes(".rag/admin-review-export/latest") &&
      files.deployReadme.includes("export.json") &&
      files.deployReadme.includes("/api/rag/review/export")
  ),
  check(
    "Deployment docs mention review ticket sync reports",
    files.deployReadme.includes("npm run review:sync") &&
      files.deployReadme.includes(".rag/review-sync/latest") &&
      files.deployReadme.includes("tickets.json") &&
      files.deployReadme.includes("sync.json") &&
      files.deployReadme.includes("RAG_REVIEW_SYNC_WEBHOOK_URL")
  ),
  check(
    "Deployment docs mention review ticket reconciliation reports",
    files.deployReadme.includes("npm run review:reconcile") &&
      files.deployReadme.includes(".rag/review-reconciliation/latest") &&
      files.deployReadme.includes("idempotency-store.json") &&
      files.deployReadme.includes("external-statuses.jsonl")
  ),
  check(
    "Deployment docs mention support knowledge flow reports",
    files.deployReadme.includes("npm run support:knowledge") &&
      files.deployReadme.includes(".rag/support-knowledge/latest") &&
      files.deployReadme.includes("approved-knowledge.sources.json") &&
      files.deployReadme.includes("RAG_APPROVED_KNOWLEDGE_ARTIFACTS_PATH")
  ),
  check(
    "Deployment docs mention support operator drill reports",
    files.deployReadme.includes("npm run support:drill") &&
      files.deployReadme.includes(".rag/support-drill/latest") &&
      files.deployReadme.includes("runRagSupportOperatorDrill") &&
      files.deployReadme.includes("approved-knowledge.sources.json")
  ),
  check(
    "Deployment docs mention support event export validation",
    files.deployReadme.includes("npm run support:export:validate") &&
      files.deployReadme.includes(".rag/support-export/latest") &&
      files.deployReadme.includes("assertRagSupportEventExporterContract") &&
      files.deployReadme.includes("validate-support-event-export.mjs")
  ),
  check(
    "Deployment docs mention project support connector template",
    files.deployReadme.includes("templates/project-support-connector") &&
      files.deployReadme.includes("createRagProjectSupportEventExporter")
  ),
  check(
    "Deployment docs mention company connector pack template",
    files.deployReadme.includes("templates/company-connector-pack") &&
      files.deployReadme.includes("permission mapper") &&
      files.deployReadme.includes("pack contract test") &&
      files.deployReadme.includes("starter eval JSONL") &&
      files.deployReadme.includes("delta cursor handoff")
  ),
  check(
    "Project support connector template includes safe exporter skeleton",
    files.projectSupportConnectorReadme.includes("Project Support Connector Template") &&
      files.projectSupportConnectorReadme.includes("raw customer messages") &&
      files.projectSupportConnectorExporter.includes("createRagProjectSupportEventExporter") &&
      files.projectSupportConnectorExporter.includes("ProjectSupportRecordClient") &&
      files.projectSupportConnectorExporter.includes("requiresApproval: true")
  ),
  check(
    "Project support connector template includes contract test",
    files.projectSupportConnectorTest.includes("assertRagSupportEventExporterContract") &&
      files.projectSupportConnectorTest.includes("createProjectSupportEventExporter") &&
      files.projectSupportConnectorTest.includes("requiresApproval")
  ),
  check(
    "Company connector pack template includes profile and validation command",
    files.companyConnectorPackReadme.includes("Company Connector Pack Template") &&
      files.companyConnectorPackReadme.includes("--run-pack-contracts") &&
      files.companyConnectorPackReadme.includes("--min-delta-returned-records") &&
      files.companyConnectorPackReadme.includes("profiles/company-docs/docs/*.jsonl") &&
      files.companyConnectorPackReadme.includes("CompanyDeploymentManifest") &&
      files.companyConnectorPackProfile.includes("export const companyProfile") &&
      files.companyConnectorPackProfile.includes("export const companyDeployment") &&
      files.companyConnectorPackProfile.includes("requiredEnv") &&
      files.companyConnectorPackProfile.includes("postgresSmokeCommand") &&
      files.companyConnectorPackProfile.includes("permissionMapping") &&
      files.companyConnectorPackProfile.includes("--contract-mode delta") &&
      files.companyConnectorPackProfile.includes("--contract-mode full")
  ),
  check(
    "Company connector pack template includes adapter pack and permission mapper",
    files.companyConnectorPackAdapterPack.includes("export const companyAdapterPack") &&
      files.companyConnectorPackAdapterPack.includes("createCompanyConnectorAdapterPack") &&
      files.companyConnectorPackAdapterPack.includes("ownerDefinedAclMapper") &&
      files.companyConnectorPackAdapterPack.includes("sourceConnectors") &&
      files.companyConnectorPackAdapterPack.includes("corpusAdapterTests") &&
      files.companyConnectorPackAdapterPack.includes("contentHash") &&
      files.companyConnectorPackAdapterPack.includes("redactedAclFingerprint") &&
      files.companyConnectorPackAdapterPack.includes("safeConnectorErrorMessage") &&
      files.companyConnectorPackAdapterPack.includes("safeErrorCode")
  ),
  check(
    "Company connector pack template includes pack contract test",
    files.companyConnectorPackTest.includes("runCompanyPackContractTests") &&
      files.companyConnectorPackTest.includes("CompanyDeploymentRegistry") &&
      files.companyConnectorPackTest.includes("checkedCaseCount") &&
      files.companyConnectorPackTest.includes("cursor_after_delta_company_docs") &&
      files.companyConnectorPackTest.includes("tombstonedMissingCount") &&
      files.companyConnectorPackTest.includes("permissionMapperNativeAcl")
  ),
  check(
    "Company connector pack template includes starter eval JSONL",
    files.companyConnectorPackGoldenEval.includes("company-docs-policy-citation") &&
      files.companyConnectorPackGoldenEval.includes('"sourceId":"company_docs_api"') &&
      files.companyConnectorPackAdversarialEval.includes("company-docs-denies-restricted-scope") &&
      files.companyConnectorPackAdversarialEval.includes('"checks":["access_boundary"]')
  )
];

const failures = checks.filter((result) => !result.passed);
if (failures.length > 0) {
  console.error("Deployment asset validation failed:");
  for (const failure of failures) {
    console.error(`- ${failure.message}`);
  }
  process.exit(1);
}

console.log(`Deployment asset validation passed: ${checks.length} checks.`);

function read(relativePath) {
  return readFileSync(path.join(root, relativePath), "utf8");
}

function check(message, passed) {
  return { message, passed };
}

function lineExists(body, line) {
  return body
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .includes(line);
}

function envValue(name) {
  return envValueFrom(files.envExample, name);
}

function envValueFrom(body, name) {
  const line = body.split(/\r?\n/u).find((entry) => entry.startsWith(`${name}=`));
  return line?.slice(name.length + 1);
}

function containsLiveSecret(body) {
  return /sk_(?:live|test)|-----BEGIN [A-Z ]+PRIVATE KEY-----|bearer\s+[a-z0-9._-]{16,}/iu.test(
    body
  );
}
