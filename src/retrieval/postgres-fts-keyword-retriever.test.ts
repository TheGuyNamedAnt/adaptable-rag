import assert from "node:assert/strict";
import test from "node:test";

import { chunkDocument } from "../chunking/chunker.js";
import { PostgresRagIndex, type PostgresFtsSearchRequest } from "../indexing/postgres-index.js";
import type { IndexedChunk } from "../indexing/index-types.js";
import { FIXED_NOW, makeDocument, makeIndexFilter } from "../test-support/fixtures.js";
import { PostgresFtsKeywordRetriever } from "./postgres-fts-keyword-retriever.js";

test("retrieves ranked Postgres FTS matches with keyword trace metadata", async () => {
  const document = makeDocument({
    id: "doc_postgres_refunds",
    body: "Refund policy says billing refunds require human review."
  });
  const [chunk] = chunkDocument({ document }).chunks;
  assert.ok(chunk);

  const index = new StubPostgresIndex([
    {
      chunk: {
        chunk,
        indexedAt: FIXED_NOW
      },
      score: 0.91,
      matchedTerms: ["refund", "policy"],
      reasons: ["postgres_fts_match"]
    }
  ]);
  const retriever = new PostgresFtsKeywordRetriever({ index, now: () => FIXED_NOW });

  const result = await retriever.retrieve({
    query: "refund policy",
    filter: makeIndexFilter(),
    topK: 3,
    retrievalId: "retrieval_postgres_fts",
    requestedAt: FIXED_NOW
  });

  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]?.chunk.documentId, "doc_postgres_refunds");
  assert.deepEqual(result.candidates[0]?.matchedTerms, ["refund", "policy"]);
  assert.equal(result.candidates[0]?.reasons.includes("postgres_fts_match"), true);
  assert.equal(result.trace.retrievalId, "retrieval_postgres_fts");
  assert.equal(result.trace.fusionStrategy, "postgres_fts");
  assert.equal(result.trace.candidatePoolSize, 1);
});

class StubPostgresIndex extends PostgresRagIndex {
  private readonly results: readonly {
    readonly chunk: IndexedChunk;
    readonly score: number;
    readonly matchedTerms: readonly string[];
    readonly reasons: readonly string[];
  }[];

  constructor(
    results: readonly {
      readonly chunk: IndexedChunk;
      readonly score: number;
      readonly matchedTerms: readonly string[];
      readonly reasons: readonly string[];
    }[]
  ) {
    super({ pool: {} as never });
    this.results = results;
  }

  override async searchKeywordChunks(request: PostgresFtsSearchRequest): Promise<
    readonly {
      readonly chunk: IndexedChunk;
      readonly score: number;
      readonly matchedTerms: readonly string[];
      readonly reasons: readonly string[];
    }[]
  > {
    return this.results.slice(0, request.limit);
  }
}
