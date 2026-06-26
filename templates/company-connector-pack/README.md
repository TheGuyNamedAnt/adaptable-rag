# Company Connector Pack Template

This is the copyable company deployment skeleton for plug-and-play RAG installs.

This template belongs in the company or deployment wrapper repo, not inside the generic RAG core.

Use it when a company needs to register production sources, source sync connectors, corpus adapters, and source-system ACL mapping against the generic `adaptable-rag` runtime. The generic package owns validation, contract tests, sync ledgers, ingestion, delete propagation, retrieval safety, and deployment checks. The company pack owns source clients, native ACL interpretation, source-specific identifiers, and fixture data for contract tests.

## Boundary

The connector pack may read company-owned APIs, databases, file services, admin systems, or document stores. It must emit only normalized RAG contracts:

- `CompanyProfile` with use cases, namespaces, corpus sources, connectors, eval packs, and permission mapping
- `CompanyAdapterPack` with corpus adapters, source connectors, permission mappers, and connector test commands
- `CorpusRecord` values with stable ids, source ids, checksums, trust tier, sensitivity, and mapped access scopes
- `SourceConnector` sync results with full/delta mode, stable source item ids, cursors, complete full-sync markers, deletes, and retryable errors

It must not emit raw source bodies into ledgers, raw native ACL payloads into traces, credentials, bearer tokens, API keys, full principal claims, raw diagnostics, or unbounded tenant-wide access scopes.

## Files

- `src/company-profile.ts`: copyable company profile and use-case/source declarations
- `src/company-adapter-pack.ts`: copyable adapter pack with corpus adapter, source connector, and permission mapper
- `src/company-connector-pack.test.ts`: contract test that runs the company connector gate

## Company Steps

1. Copy this folder into the company deployment repo.
2. Replace `companyDocsClient` with the real source API/database client.
3. Replace `CompanyDocsItem` and `CompanyDocsNativeAcl` with safe projections from the source system.
4. Keep raw source credentials, raw ACL payloads, and principal claims out of returned records and warnings.
5. Update `companyProfile` ids, namespace, eval paths, corpus source ids, and connector ids.
6. Keep `createCompanyConnectorAdapterPack()` as the adapter-pack export used by deployment validation.
7. Run the contract test locally, then wire the packaged validator into CI:

```bash
npm run company:validate -- \
	  --module dist/company/company-profile.js \
	  --export companyProfile \
	  --adapter-pack-export companyAdapterPack \
	  --run-pack-contracts \
	  --use-case docs \
  --principal-role docs_reader \
  --principal-tag trusted_internal \
  --report-dir .rag/company/company-docs
```

The connector pack does not run the RAG HTTP service, choose model providers, or own Postgres migrations. It only supplies company-specific source integration code that must pass the generic deployment gates before production use.
