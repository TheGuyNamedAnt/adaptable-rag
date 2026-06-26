# Adaptable RAG Docs

Use this directory for deeper system documentation. The root README is intentionally
short; detailed architecture and operations material lives here or under `deploy/`.

## Start Here

- [Full reference](full-reference.md): the original long-form architecture and operations reference.
- [Deployment guide](../deploy/README.md): Docker, env, provider, hosted vector, and production notes.
- [Company production runbook](../deploy/company-production-runbook.md): Postgres/pgvector company deployment flow.
- [Company connector template](../templates/company-connector-pack/): copyable company integration skeleton.
- [Project support connector template](../templates/project-support-connector/): copyable support-event exporter skeleton.

## Suggested Reading Paths

For a new user:

1. Read the root [README](../README.md).
2. Run the Quick Start.
3. Open [Full reference](full-reference.md) only for the subsystem you are changing.

For production deployment:

1. Read [Deployment guide](../deploy/README.md).
2. Follow [Company production runbook](../deploy/company-production-runbook.md) when using Postgres/pgvector.
3. Run `npm run ci` and the relevant company smoke command before promotion.

For adapter authors:

1. Start from the relevant template in `templates/`.
2. Use the contract tests described in [Full reference](full-reference.md).
3. Keep source bodies, credentials, provider payloads, and principal claims out of logs and reports.
