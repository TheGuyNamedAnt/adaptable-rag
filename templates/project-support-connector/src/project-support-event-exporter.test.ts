import assert from "node:assert/strict";
import test from "node:test";

import { assertRagSupportEventExporterContract } from "adaptable-rag";

import { createProjectSupportEventExporter } from "./project-support-event-exporter.js";

const GENERATED_AT = "2026-06-24T00:00:00.000Z";

test("project support connector exports only safe support events", async () => {
  const exporter = createProjectSupportEventExporter({
    defaultProfileId: "generic-docs",
    defaultNamespaceId: "generic-docs",
    client: {
      async listChangedSupportRecords() {
        return {
          cursor: "cursor_after_ticket_123",
          records: [
            {
              ticketId: "ticket_123",
              updatedAt: GENERATED_AT,
              state: "engineering_investigation",
              artifactPath: "support/tickets/ticket_123.json",
              knownIssueSignal: true,
              safeSummary: "Ticket indicates a possible known issue."
            }
          ]
        };
      }
    }
  });

  const result = await assertRagSupportEventExporterContract({
    exporter,
    request: {
      exportId: "project_support_export_fixture",
      generatedAt: GENERATED_AT,
      profileId: "generic-docs",
      namespaceId: "generic-docs"
    }
  });

  assert.equal(result.status, "passed");
  assert.equal(result.bundle?.events.length, 1);
  assert.equal(result.bundle?.events[0]?.proposedKnowledgeAction.requiresApproval, true);
  assert.equal(result.bundle?.cursor, "cursor_after_ticket_123");
});
