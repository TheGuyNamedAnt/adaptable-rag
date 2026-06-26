import assert from "node:assert/strict";
import test from "node:test";

import { hashText } from "../chunking/hash.js";
import type { DocumentLayout } from "../documents/layout.js";
import { genericDocsProfile } from "../profiles/examples/generic-docs.profile.js";
import type { CorpusSourceConfig, RagProfile } from "../profiles/profile.js";
import { assertValidProfile } from "../profiles/profile-validation.js";
import { FIXED_NOW } from "../test-support/fixtures.js";
import type { CorpusRecord } from "./corpus-record.js";
import { normalizeCorpusRecord, normalizeCorpusRecords } from "./normalize.js";

const principal = {
  userId: "user_1",
  tenantId: "tenant_1",
  namespaceIds: [genericDocsProfile.namespaceId],
  teamIds: [],
  roles: ["admin"],
  tags: ["support"]
};
const validatedGenericDocsProfile = assertValidProfile(genericDocsProfile);

function makeRecord(overrides: Partial<CorpusRecord> = {}): CorpusRecord {
  const source = genericDocsProfile.corpusSources[0];
  assert.ok(source);

  return {
    id: "record_1",
    sourceId: source.id,
    sourceKind: "local_file",
    title: "Policy",
    body: "Policy body.",
    trustTier: "trusted_internal",
    sensitivity: "internal",
    accessScope: {
      tenantId: "tenant_1",
      namespaceId: genericDocsProfile.namespaceId
    },
    capturedAt: FIXED_NOW,
    ...overrides
  };
}

function makeLayout(overrides: Partial<DocumentLayout> = {}): DocumentLayout {
  return {
    parserId: "fixture-parser",
    strategy: "ocr_layout",
    pages: [
      {
        pageNumber: 1,
        width: 600,
        height: 800,
        unit: "point"
      }
    ],
    regions: [
      {
        id: "region_policy_body",
        kind: "paragraph",
        pageNumber: 1,
        text: "Policy body.",
        characterStart: 0,
        characterEnd: 12,
        box: {
          pageNumber: 1,
          x: 40,
          y: 60,
          width: 200,
          height: 40,
          unit: "point"
        }
      }
    ],
    ...overrides
  };
}

test("normalizes a valid corpus record into a document", () => {
  const source = genericDocsProfile.corpusSources[0];
  assert.ok(source);

  const result = normalizeCorpusRecord(makeRecord(), {
    profile: validatedGenericDocsProfile,
    source,
    requestedBy: principal,
    ingestedAt: FIXED_NOW
  });

  assert.equal(result.accepted, true);
  assert.equal(result.issues.length, 0);
  if (result.accepted) {
    assert.equal(result.document.namespaceId, genericDocsProfile.namespaceId);
    assert.equal(result.document.provenance.capturedAt, FIXED_NOW);
  }
});

test("preserves validated parser layout on the normalized document", () => {
  const source = genericDocsProfile.corpusSources[0];
  assert.ok(source);

  const result = normalizeCorpusRecord(makeRecord({ layout: makeLayout() }), {
    profile: validatedGenericDocsProfile,
    source,
    requestedBy: principal,
    ingestedAt: FIXED_NOW
  });

  assert.equal(result.accepted, true);
  if (result.accepted) {
    assert.equal(result.document.layout?.parserId, "fixture-parser");
    assert.equal(result.document.layout?.regions[0]?.id, "region_policy_body");
  }
});

test("preserves exact body text when parser layout uses character offsets", () => {
  const source = genericDocsProfile.corpusSources[0];
  assert.ok(source);
  const body = "Policy body.  ";

  const result = normalizeCorpusRecord(
    makeRecord({
      body,
      checksum: hashText(body),
      layout: makeLayout({
        regions: [
          {
            id: "region_policy_body",
            kind: "paragraph",
            pageNumber: 1,
            text: body,
            characterStart: 0,
            characterEnd: body.length
          }
        ]
      })
    }),
    {
      profile: validatedGenericDocsProfile,
      source,
      requestedBy: principal,
      ingestedAt: FIXED_NOW
    }
  );

  assert.equal(result.accepted, true);
  if (result.accepted) {
    assert.equal(result.document.body, body);
    assert.equal(result.document.layout?.regions[0]?.characterEnd, body.length);
  }
});

test("rejects corpus records with invalid parser layout", () => {
  const source = genericDocsProfile.corpusSources[0];
  assert.ok(source);

  const result = normalizeCorpusRecord(
    makeRecord({
      layout: makeLayout({
        regions: [
          {
            id: "region_bad",
            kind: "paragraph",
            pageNumber: 1,
            text: "Different text",
            characterStart: 0,
            characterEnd: 12
          }
        ]
      })
    }),
    {
      profile: validatedGenericDocsProfile,
      source,
      requestedBy: principal,
      ingestedAt: FIXED_NOW
    }
  );

  assert.equal(result.accepted, false);
  assert.equal(
    result.issues.some((issue) => issue.code === "invalid_layout"),
    true
  );
});

test("rejects a source that is not declared by the profile", () => {
  const undeclaredSource: CorpusSourceConfig = {
    id: "undeclared",
    adapter: "local-files",
    description: "Undeclared source",
    enabled: true
  };

  const result = normalizeCorpusRecord(makeRecord({ sourceId: "undeclared" }), {
    profile: validatedGenericDocsProfile,
    source: undeclaredSource,
    requestedBy: principal,
    ingestedAt: FIXED_NOW
  });

  assert.equal(result.accepted, false);
  assert.equal(
    result.issues.some((issue) => issue.code === "source_not_declared"),
    true
  );
});

test("rejects a source config that does not match the profile declaration", () => {
  const source = genericDocsProfile.corpusSources[0];
  assert.ok(source);
  const tamperedSource = {
    ...source,
    adapter: "database"
  };

  const result = normalizeCorpusRecord(makeRecord(), {
    profile: validatedGenericDocsProfile,
    source: tamperedSource,
    requestedBy: principal,
    ingestedAt: FIXED_NOW
  });

  assert.equal(result.accepted, false);
  assert.equal(
    result.issues.some((issue) => issue.code === "source_mismatch"),
    true
  );
});

test("rejects a disabled source declared by the profile", () => {
  const source = genericDocsProfile.corpusSources[0];
  assert.ok(source);
  const disabledSource = {
    ...source,
    id: "disabled_docs",
    enabled: false
  };
  const profile: RagProfile = {
    ...genericDocsProfile,
    corpusSources: [source, disabledSource]
  };
  const validatedProfile = assertValidProfile(profile);

  const result = normalizeCorpusRecord(makeRecord({ sourceId: disabledSource.id }), {
    profile: validatedProfile,
    source: disabledSource,
    requestedBy: principal,
    ingestedAt: FIXED_NOW
  });

  assert.equal(result.accepted, false);
  assert.equal(
    result.issues.some((issue) => issue.code === "disabled_source"),
    true
  );
});

test("rejects missing capturedAt when profile freshness requires it", () => {
  const source = genericDocsProfile.corpusSources[0];
  assert.ok(source);
  const { capturedAt: _capturedAt, ...recordWithoutCapturedAt } = makeRecord();

  const result = normalizeCorpusRecord(recordWithoutCapturedAt, {
    profile: validatedGenericDocsProfile,
    source,
    requestedBy: principal,
    ingestedAt: FIXED_NOW
  });

  assert.equal(result.accepted, false);
  assert.equal(
    result.issues.some((issue) => issue.code === "missing_provenance_field"),
    true
  );
});

test("rejects unsafe trust upgrades", () => {
  const source = genericDocsProfile.corpusSources[0];
  assert.ok(source);
  const profile: RagProfile = {
    ...genericDocsProfile,
    corpusSources: [
      {
        ...source,
        trustTierOverride: "trusted_internal"
      }
    ]
  };
  const validatedProfile = assertValidProfile(profile);
  const overrideSource = profile.corpusSources[0];
  assert.ok(overrideSource);

  const result = normalizeCorpusRecord(makeRecord({ trustTier: "user_provided" }), {
    profile: validatedProfile,
    source: overrideSource,
    requestedBy: principal,
    ingestedAt: FIXED_NOW
  });

  assert.equal(result.accepted, false);
  assert.equal(
    result.issues.some((issue) => issue.code === "unsafe_trust_upgrade"),
    true
  );
});

test("caps normalized trust at the source trust floor", () => {
  const source = genericDocsProfile.corpusSources[0];
  assert.ok(source);
  const flooredSource: CorpusSourceConfig = {
    ...source,
    trustTierFloor: "user_provided"
  };
  const profile: RagProfile = {
    ...genericDocsProfile,
    corpusSources: [flooredSource]
  };
  const validatedProfile = assertValidProfile(profile);

  const result = normalizeCorpusRecord(makeRecord({ trustTier: "trusted_internal" }), {
    profile: validatedProfile,
    source: flooredSource,
    requestedBy: principal,
    ingestedAt: FIXED_NOW
  });

  assert.equal(result.accepted, true);
  if (result.accepted) {
    assert.equal(result.document.provenance.trustTier, "user_provided");
  }
});

test("verifies record body checksum before accepting provenance", () => {
  const source = genericDocsProfile.corpusSources[0];
  assert.ok(source);

  const accepted = normalizeCorpusRecord(makeRecord({ checksum: hashText("Policy body.") }), {
    profile: validatedGenericDocsProfile,
    source,
    requestedBy: principal,
    ingestedAt: FIXED_NOW
  });
  const rejected = normalizeCorpusRecord(makeRecord({ checksum: hashText("different body") }), {
    profile: validatedGenericDocsProfile,
    source,
    requestedBy: principal,
    ingestedAt: FIXED_NOW
  });

  assert.equal(accepted.accepted, true);
  assert.equal(rejected.accepted, false);
  assert.equal(
    rejected.issues.some((issue) => issue.code === "checksum_mismatch"),
    true
  );
});

test("rejects invalid source kind and sensitivity values", () => {
  const source = genericDocsProfile.corpusSources[0];
  assert.ok(source);
  const result = normalizeCorpusRecord(
    {
      ...makeRecord(),
      sourceKind: "not_a_source_kind",
      sensitivity: "not_a_sensitivity"
    } as unknown as CorpusRecord,
    {
      profile: validatedGenericDocsProfile,
      source,
      requestedBy: principal,
      ingestedAt: FIXED_NOW
    }
  );

  assert.equal(result.accepted, false);
  assert.equal(
    result.issues.some((issue) => issue.code === "invalid_source_kind"),
    true
  );
  assert.equal(
    result.issues.some((issue) => issue.code === "invalid_sensitivity"),
    true
  );
});

test("rejects null records and malformed access scopes without throwing", () => {
  const source = genericDocsProfile.corpusSources[0];
  assert.ok(source);
  const batch = normalizeCorpusRecords(
    [
      null,
      {
        ...makeRecord(),
        id: "record_bad_access",
        accessScope: undefined
      } as unknown as CorpusRecord
    ],
    {
      profile: validatedGenericDocsProfile,
      source,
      requestedBy: principal,
      ingestedAt: FIXED_NOW
    }
  );

  assert.equal(batch.documents.length, 0);
  assert.equal(batch.rejectedRecords.length, 2);
  assert.equal(
    batch.issues.some((issue) => issue.code === "null_record"),
    true
  );
  assert.equal(
    batch.issues.some((issue) => issue.code === "missing_access_scope"),
    true
  );
});
