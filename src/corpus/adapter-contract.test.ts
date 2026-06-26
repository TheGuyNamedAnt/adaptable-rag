import assert from "node:assert/strict";
import test from "node:test";

import { genericDocsProfile } from "../profiles/examples/generic-docs.profile.js";
import type { RagProfile } from "../profiles/profile.js";
import { assertValidProfile, type ValidatedRagProfile } from "../profiles/profile-validation.js";
import { hashText } from "../shared/hash.js";
import { FIXED_NOW, makePrincipal } from "../test-support/fixtures.js";
import type { CorpusAdapter, CorpusLoadRequest, CorpusLoadResult } from "./adapter.js";
import type { CorpusRecord } from "./corpus-record.js";
import {
  assertCorpusAdapterContract,
  CorpusAdapterContractError,
  validateCorpusAdapterContract
} from "./adapter-contract.js";

const profile = adapterProfile();
const source = profile.corpusSources[0]!;
const principal = makePrincipal({
  tenantId: "tenant_1",
  namespaceIds: [profile.namespaceId],
  roles: ["reader"],
  tags: ["sdk"]
});

class StaticContractAdapter implements CorpusAdapter {
  readonly id: string;
  readonly description: string;
  readonly result: CorpusLoadResult;
  readonly throwOnLoad: boolean;
  lastRequest: CorpusLoadRequest | undefined;

  constructor(options: {
    readonly id?: string;
    readonly description?: string;
    readonly result?: CorpusLoadResult;
    readonly throwOnLoad?: boolean;
  }) {
    this.id = options.id ?? "sdk-adapter";
    this.description = options.description ?? "SDK contract fixture adapter.";
    this.result =
      options.result ??
      ({
        sourceId: source.id,
        records: [record()],
        warnings: []
      } satisfies CorpusLoadResult);
    this.throwOnLoad = options.throwOnLoad ?? false;
  }

  async load(request: CorpusLoadRequest): Promise<CorpusLoadResult> {
    this.lastRequest = request;
    if (this.throwOnLoad) {
      throw new Error("adapter failed with token=super-secret");
    }

    return this.result;
  }
}

test("asserts the contract for a valid custom corpus adapter", async () => {
  const adapter = new StaticContractAdapter({});
  const result = await assertCorpusAdapterContract({
    adapter,
    profile,
    source,
    requestedBy: principal,
    runId: "contract_valid",
    requestedAt: FIXED_NOW
  });

  assert.equal(adapter.lastRequest?.source.id, source.id);
  assert.equal(result.loadedRecordCount, 1);
  assert.equal(result.acceptedDocumentCount, 1);
  assert.equal(result.rejectedRecordCount, 0);
  assert.deepEqual(result.issues, []);
});

test("reports warning leaks and normalization failures without accepting records", async () => {
  const badBody = "Contract record with a bad checksum.";
  const result = await validateCorpusAdapterContract({
    adapter: new StaticContractAdapter({
      result: {
        sourceId: source.id,
        records: [
          record({
            body: badBody,
            checksum: hashText("tampered"),
            accessScope: {
              tenantId: "tenant_2",
              namespaceId: profile.namespaceId,
              tags: ["sdk"]
            }
          })
        ],
        warnings: [
          {
            sourceId: source.id,
            code: "upstream_failed",
            message: "Upstream returned token=super-secret."
          }
        ]
      }
    }),
    profile,
    source,
    requestedBy: principal,
    runId: "contract_bad",
    requestedAt: FIXED_NOW
  });

  const codes = result.issues.map((issue) => issue.code);
  assert.equal(codes.includes("adapter_warning_leaks_sensitive_diagnostics"), true);
  assert.equal(codes.includes("normalization_error"), true);
  assert.equal(codes.includes("accepted_document_count_below_minimum"), true);
  assert.equal(codes.includes("rejected_record_count_above_maximum"), true);
  assert.equal(result.acceptedDocumentCount, 0);
});

test("fails when adapter warnings are disallowed by the fixture", async () => {
  const result = await validateCorpusAdapterContract({
    adapter: new StaticContractAdapter({
      result: {
        sourceId: source.id,
        records: [record()],
        warnings: [
          {
            sourceId: source.id,
            code: "minor_warning",
            message: "A non-sensitive warning."
          }
        ]
      }
    }),
    profile,
    source,
    requestedBy: principal,
    expectations: {
      allowAdapterWarnings: false
    },
    requestedAt: FIXED_NOW
  });

  assert.equal(
    result.issues.some((issue) => issue.code === "adapter_warning_unexpected"),
    true
  );
});

test("turns thrown adapter loads into contract errors", async () => {
  await assert.rejects(
    () =>
      assertCorpusAdapterContract({
        adapter: new StaticContractAdapter({ throwOnLoad: true }),
        profile,
        source,
        requestedBy: principal,
        requestedAt: FIXED_NOW
      }),
    (error) =>
      error instanceof CorpusAdapterContractError &&
      error.result.issues.some((issue) => issue.code === "adapter_threw")
  );
});

test("allows explicit empty fixtures for negative adapter tests", async () => {
  const result = await assertCorpusAdapterContract({
    adapter: new StaticContractAdapter({
      result: {
        sourceId: source.id,
        records: [],
        warnings: []
      }
    }),
    profile,
    source,
    requestedBy: principal,
    expectations: {
      minLoadedRecords: 0,
      minAcceptedDocuments: 0,
      maxRejectedRecords: 0
    },
    requestedAt: FIXED_NOW
  });

  assert.equal(result.loadedRecordCount, 0);
  assert.equal(result.acceptedDocumentCount, 0);
  assert.deepEqual(result.issues, []);
});

test("reports static adapter and load-result contract mismatches", async () => {
  const result = await validateCorpusAdapterContract({
    adapter: new StaticContractAdapter({
      id: "wrong-adapter",
      description: "",
      result: {
        sourceId: "wrong_source",
        records: [],
        warnings: [
          {
            sourceId: "wrong_source",
            code: "",
            message: ""
          }
        ]
      }
    }),
    profile,
    source,
    requestedBy: principal,
    expectations: {
      minLoadedRecords: 0,
      minAcceptedDocuments: 0,
      maxRejectedRecords: 0
    },
    requestedAt: FIXED_NOW
  });

  const codes = result.issues.map((issue) => issue.code);
  assert.equal(codes.includes("adapter_description_required"), true);
  assert.equal(codes.includes("source_adapter_mismatch"), true);
  assert.equal(codes.includes("load_source_mismatch"), true);
  assert.equal(codes.includes("adapter_warning_source_mismatch"), true);
  assert.equal(codes.includes("adapter_warning_code_required"), true);
  assert.equal(codes.includes("adapter_warning_message_required"), true);
});

function adapterProfile(): ValidatedRagProfile {
  const rawProfile: RagProfile = {
    ...genericDocsProfile,
    corpusSources: [
      {
        id: "sdk_docs",
        adapter: "sdk-adapter",
        description: "SDK contract adapter source.",
        enabled: true,
        trustTierFloor: "trusted_internal",
        tags: ["sdk"]
      }
    ]
  };

  return assertValidProfile(rawProfile);
}

function record(overrides: Partial<CorpusRecord> = {}): CorpusRecord {
  const body = overrides.body ?? "Adapter SDK contract body.";

  return {
    id: overrides.id ?? "sdk_doc",
    sourceId: overrides.sourceId ?? source.id,
    sourceKind: overrides.sourceKind ?? "api_response",
    title: overrides.title ?? "SDK Contract Doc",
    body,
    trustTier: overrides.trustTier ?? "trusted_internal",
    sensitivity: overrides.sensitivity ?? "internal",
    accessScope: overrides.accessScope ?? {
      tenantId: principal.tenantId,
      namespaceId: profile.namespaceId,
      tags: ["sdk"]
    },
    capturedAt: overrides.capturedAt ?? FIXED_NOW,
    checksum: overrides.checksum ?? hashText(body),
    ...(overrides.metadata === undefined ? {} : { metadata: overrides.metadata })
  };
}
