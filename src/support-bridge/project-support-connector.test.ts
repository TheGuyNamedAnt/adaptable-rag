import assert from "node:assert/strict";
import test from "node:test";

import {
  assertRagSupportEventExporterContract,
  validateRagSupportEventExporterContract
} from "./support-event-exporter.js";
import {
  createRagProjectSupportEventExporter,
  ragProjectSupportConnectorTemplateEvidenceBoundary,
  type RagProjectSupportConnectorLoadRequest,
  type RagProjectSupportConnectorSource
} from "./project-support-connector.js";

const GENERATED_AT = "2026-06-24T00:00:00.000Z";

interface FixtureSupportRecord {
  readonly ticketId: string;
  readonly updatedAt: string;
  readonly state: string;
  readonly rawCustomerMessage: string;
}

test("project support connector template exports safe events through the contract", async () => {
  const loadRequests: RagProjectSupportConnectorLoadRequest[] = [];
  const source: RagProjectSupportConnectorSource<FixtureSupportRecord> = {
    id: "fixture_project_support_source",
    description: "Fixture project support source.",
    loadRecords: (request) => {
      loadRequests.push(request);
      return {
        cursor: "cursor_after_ticket_123",
        records: [
          {
            ticketId: "ticket_123",
            updatedAt: GENERATED_AT,
            state: "engineering_investigation",
            rawCustomerMessage: "Customer wrote api_key=raw_secret_that_must_not_export"
          }
        ],
        metadata: {
          sourceKind: "fixture"
        }
      };
    }
  };
  const exporter = createRagProjectSupportEventExporter({
    exporterId: "fixture_project_support_exporter",
    description: "Exports safe fixture support events.",
    source,
    metadata: {
      project_connector: "fixture"
    },
    mapRecord: ({ record, request }) => ({
      events: [
        {
          sourceSystem: "admin_support",
          sourceEventId: `${record.ticketId}:known_issue_signal:${record.updatedAt}`,
          sourceTicketId: record.ticketId,
          ...(request.profileId === undefined ? {} : { profileId: request.profileId }),
          ...(request.namespaceId === undefined ? {} : { namespaceId: request.namespaceId }),
          eventType: "known_issue_candidate_created",
          occurredAt: record.updatedAt,
          summary: `Ticket ${record.ticketId} reached ${record.state}.`,
          evidenceRefs: [
            {
              refId: `ticket_${record.ticketId}`,
              kind: "ticket",
              sourceSystem: "admin_support",
              artifactPath: `support/tickets/${record.ticketId}.json`,
              ticketId: record.ticketId,
              sensitivity: "internal_only",
              customerSafe: false
            }
          ],
          proposedKnowledgeAction: {
            kind: "known_issue_candidate",
            targetId: `known_issue_${record.ticketId}`,
            knownIssueStatus: "candidate",
            title: "Possible known issue",
            summary: "Review repeated support reports before promotion.",
            proposedWording: "We're checking whether this matches other reports.",
            requiresApproval: true,
            approverDestination: "support_lead"
          },
          metadata: {
            ticket_state: record.state
          }
        }
      ],
      metadata: {
        mappedRecords: 1
      }
    })
  });

  const result = await assertRagSupportEventExporterContract({
    exporter,
    request: {
      exportId: "fixture_project_support_export",
      generatedAt: GENERATED_AT,
      cursor: "cursor_before_ticket_123",
      maxEvents: 10,
      profileId: "generic-docs",
      namespaceId: "generic-docs"
    }
  });
  const event = result.bundle?.events[0];
  assert.ok(event);

  assert.equal(result.status, "passed");
  assert.equal(loadRequests[0]?.cursor, "cursor_before_ticket_123");
  assert.equal(loadRequests[0]?.maxRecords, 10);
  assert.equal(loadRequests[0]?.profileId, "generic-docs");
  assert.equal(result.bundle?.cursor, "cursor_after_ticket_123");
  assert.equal(event.profileId, "generic-docs");
  assert.equal(event.namespaceId, "generic-docs");
  assert.equal(event.proposedKnowledgeAction.requiresApproval, true);
  assert.equal(result.bundle?.metadata["project_connector"], "fixture");
  assert.equal(result.bundle?.metadata["connector_source_id"], source.id);
  assert.equal(JSON.stringify(result).includes("raw_secret_that_must_not_export"), false);
  assert.equal(
    ragProjectSupportConnectorTemplateEvidenceBoundary().some((entry) =>
      entry.includes("Project-owned connector code")
    ),
    true
  );
});

test("project support connector template turns source failures into redacted warnings", async () => {
  const exporter = createRagProjectSupportEventExporter<FixtureSupportRecord>({
    exporterId: "fixture_failing_source_exporter",
    description: "Exporter with a failing source.",
    source: {
      id: "failing_source",
      description: "Fails without leaking raw diagnostics.",
      loadRecords: () => {
        throw new Error("database failed with token=source_secret_123");
      }
    },
    mapRecord: () => ({
      events: []
    })
  });

  const result = await validateRagSupportEventExporterContract({
    exporter,
    request: {
      generatedAt: GENERATED_AT
    },
    expectations: {
      minEvents: 0
    }
  });

  assert.equal(result.status, "passed");
  assert.equal(result.bundle?.events.length, 0);
  assert.equal(result.bundle?.warnings[0]?.code, "connector_source_failed");
  assert.equal(JSON.stringify(result).includes("source_secret_123"), false);
  assert.equal(JSON.stringify(result).includes("token=[REDACTED]"), true);
});

test("project support connector template turns mapper failures into redacted warnings", async () => {
  const exporter = createRagProjectSupportEventExporter<FixtureSupportRecord>({
    exporterId: "fixture_failing_mapper_exporter",
    description: "Exporter with a failing mapper.",
    source: {
      id: "mapper_source",
      description: "Fixture source.",
      loadRecords: () => ({
        records: [
          {
            ticketId: "ticket_123",
            updatedAt: GENERATED_AT,
            state: "open",
            rawCustomerMessage: "Not exported."
          }
        ]
      })
    },
    mapRecord: () => {
      throw new Error("mapper saw Bearer mapper_secret_123456");
    }
  });

  const result = await validateRagSupportEventExporterContract({
    exporter,
    request: {
      generatedAt: GENERATED_AT
    },
    expectations: {
      minEvents: 0
    }
  });

  assert.equal(result.status, "passed");
  assert.equal(result.bundle?.warnings[0]?.code, "connector_mapper_failed");
  assert.equal(JSON.stringify(result).includes("mapper_secret_123456"), false);
  assert.equal(JSON.stringify(result).includes("Bearer [REDACTED]"), true);
});
