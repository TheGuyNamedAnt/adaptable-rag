# Project Support Connector Template

This is the shipped connector template for support/admin knowledge promotion.

This template belongs in the project repo, not inside the generic RAG core.

Use it when a project has an admin/support system and wants to export safe `RagSupportEvent` records into the RAG support knowledge flow. The generic RAG package provides the connector factory, event builder, export contract, validation scripts, approval flow, and operator drill; the project supplies the source client for systems such as Zendesk, Intercom, Jira, Slack, a custom admin database, or an internal ticketing service.

## Boundary

The connector may read project-owned tickets, admin records, support traces, and known-issue state. It must export only safe operational facts:

- stable ids
- timestamps
- status labels
- artifact paths
- safe summaries
- evidence refs
- proposed knowledge actions that require approval

It must not export raw customer messages, raw diagnostics, raw generated answers, source bodies, credentials, routing secrets, full principal claims, or raw reviewer ids.

## Files

- `src/project-support-event-exporter.ts`: copyable exporter skeleton
- `src/project-support-event-exporter.test.ts`: contract test every project connector should keep

## Project Steps

1. Copy this folder into the project repo.
2. Replace `ProjectSupportRecord` with the project's real safe projection shape.
3. Replace `ProjectSupportRecordClient.listChangedSupportRecords()` with project-owned loading code.
4. Keep raw ticket/customer fields out of `ProjectSupportRecord`.
5. Run `assertRagSupportEventExporterContract()` in the project connector test suite.
6. Write exported events to `.rag/support-knowledge/events.jsonl`.
7. Run the generic handoff gates:

```bash
npm run support:export:validate
npm run support:knowledge
npm run support:drill
```

The connector does not approve knowledge, ingest artifacts, index chunks, or answer user questions. It only exports safe support events into the next gate.
