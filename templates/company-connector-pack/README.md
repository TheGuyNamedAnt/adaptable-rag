# Company Connector Pack Template

This is the copyable company deployment skeleton for plug-and-play RAG installs.

This template belongs in the company or deployment wrapper repo, not inside the generic RAG core.

Use it when a company needs to register production sources, source sync connectors, corpus adapters, and source-system ACL mapping against the generic `adaptable-rag` runtime. The generic package owns validation, contract tests, sync ledgers, ingestion, delete propagation, retrieval safety, and deployment checks. The company pack owns source clients, native ACL interpretation, source-specific identifiers, and fixture data for contract tests.

## Boundary

The connector pack may read company-owned APIs, databases, file services, admin systems, or document stores. It must emit only normalized RAG contracts:

- `CompanyProfile` with use cases, namespaces, corpus sources, connectors, eval packs, and permission mapping
- `CompanyAdapterPack` with corpus adapters, source connectors, permission mappers, and connector test commands
- `CompanyDeploymentManifest` that bundles the company profile, adapter packs, required env names, eval paths, and smoke commands
- `CorpusRecord` values with stable ids, source ids, checksums, trust tier, sensitivity, and mapped access scopes
- `SourceConnector` sync results with full/delta mode, stable source item ids, cursors, complete full-sync markers, deletes, and retryable errors

It must not emit raw source bodies into ledgers, raw native ACL payloads into traces, credentials, bearer tokens, API keys, full principal claims, raw diagnostics, or unbounded tenant-wide access scopes.

## Files

- `src/company-profile.ts`: copyable company profile, use-case/source declarations, and `companyDeployment` manifest export
- `src/company-adapter-pack.ts`: copyable adapter pack with corpus adapter, source connector, and permission mapper
- `src/company-connector-pack.test.ts`: contract test that runs the company connector gate
- `profiles/company-docs/docs/*.jsonl`: starter golden and adversarial eval cases matching the profile paths

## Company Steps

1. Copy this folder into the company deployment repo.
2. Replace `companyDocsClient` with the real source API/database client.
3. Replace `CompanyDocsItem` and `CompanyDocsNativeAcl` with safe projections from the source system.
4. Keep raw source credentials, raw ACL payloads, and principal claims out of returned records, warnings, ledgers, and traces.
5. Update `companyProfile` ids, namespace, eval paths, corpus source ids, connector ids, and principal roles/tags.
6. Keep `companyDeployment` as the install export used by deployment validation and production startup.
7. Keep `createCompanyConnectorAdapterPack()` available for tests and advanced pack overrides.
8. Keep the contract fixture behavior intact while replacing the client:
   - `listDocuments()` should page through current approved records for adapter contract tests.
   - `listChangedDocuments({ mode: "delta" })` should return at least one changed record and a cursor.
   - `listChangedDocuments({ mode: "full" })` should use the prior cursor when provided and return `complete: true` for a full snapshot.
   - Delete events must include `recordId`; missing records in a complete full sync become tombstones through the generic sync runner.
   - `sourceAcl` must be a redacted fingerprint only. Never return raw native ACL blobs.
9. Run the contract test locally, then wire the packaged validator into CI:

```bash
npm run company:validate -- \
  --module dist/company/company-profile.js \
  --export companyDeployment \
  --require-smoke-commands \
  --manifest-root . \
  --run-pack-contracts \
  --use-case docs \
  --contract-mode delta \
  --contract-mode full \
  --min-delta-returned-records 1 \
  --disallow-connector-warnings \
  --principal-role docs_reader \
  --principal-tag trusted_internal \
  --report-dir .rag/company/company-docs
```

In CI or promotion, load the company deployment env first and add `--require-manifest-env`. Keep `evals.requiredPaths` aligned with the copied JSONL files so the manifest gate proves the pack ships the retrieval and refusal eval fixtures it declares.

## ACL Mapping

The example `companyDocsPermissionMapper` maps safe native ACL projections into `AccessScope`. A production mapper should preserve the selected tenant and namespace, then add at least one role, tag, team, or user boundary. If a source item belongs to a different tenant or namespace, let the contract fail instead of silently widening access.

The contract fixture passes `permissionMapperNativeAcl` so the mapper is tested directly, not only through records emitted by the connector.

## Eval Pack

The included JSONL files are intentionally tiny. Keep them in the copied pack, then replace the corpus text with company-owned safe fixtures:

- `golden.jsonl` should prove the connector can retrieve and cite approved source material.
- `adversarial.jsonl` should prove denied ACL scopes, unsupported questions, and prompt-injection content are refused.

## Postgres Promotion

This pack does not run the RAG HTTP service, choose model providers, or own Postgres migrations. It supplies company-specific source integration code that must pass the generic deployment gates before production use.

After the pack contract passes, run the serious storage gate from the deployment repo:

```bash
export RAG_DATABASE_URL=postgres://rag:rag_dev_password@127.0.0.1:54329/rag
npm run company:smoke:postgres -- \
  --module dist/company/company-profile.js \
  --export companyDeployment \
  --use-case docs \
  --source-id company_docs_api \
  --local-provider \
  --reset-schema \
  --probe-providers \
  --report-dir .rag/company-postgres-smoke/company-docs
```

Use `--local-provider` only for deterministic storage validation. For a real deployment, omit it and pass the production env file with live provider settings.
