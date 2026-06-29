import assert from "node:assert/strict";
import test from "node:test";

import pg from "pg";

import { chunkDocument } from "../chunking/chunker.js";
import type { DocumentLayout } from "../documents/layout.js";
import { buildSearchableArtifacts } from "../ingestion/searchable-artifacts.js";
import { makeDocument, makeIndexFilter } from "../test-support/fixtures.js";
import { PostgresRagIndex } from "./postgres-index.js";

const POSTGRES_TEST_URL = process.env["RAG_POSTGRES_TEST_URL"];

test(
  "Postgres index persists, reloads, and searches parser-derived searchable chunks",
  { skip: POSTGRES_TEST_URL ? false : "RAG_POSTGRES_TEST_URL is not configured" },
  async () => {
    assert.ok(POSTGRES_TEST_URL);
    const schema = `rag_test_${process.pid}_${Date.now()}`;
    const pool = new pg.Pool({ connectionString: POSTGRES_TEST_URL });
    const body = ["Region Revenue", "North America 120", "OCR note"].join("\n");
    const document = {
      ...makeDocument({
        id: "doc_postgres_parser_chunks",
        body
      }),
      layout: postgresParserLayout(body)
    };
    const bodyChunks = chunkDocument({ document }).chunks;
    const searchable = buildSearchableArtifacts({ document, bodyChunks });
    const chunks = [...bodyChunks, ...searchable.chunks];

    try {
      await createPostgresIndexSchema(pool, schema);
      const index = new PostgresRagIndex({ pool, schema });

      await index.addDocument(document);
      await index.addChunks(document.id, chunks);

      const reopened = new PostgresRagIndex({ pool, schema });
      const readiness = await reopened.readinessCheck();
      const stats = await reopened.stats();
      const storedChunks = await reopened.listChunks(makeIndexFilter());
      const results = await reopened.searchKeywordChunks({
        query: "North America revenue",
        terms: ["north", "america", "revenue"],
        filter: makeIndexFilter(),
        limit: 5
      });

      assert.equal(readiness.status, "passed");
      assert.equal(stats.documentCount, 1);
      assert.equal(stats.chunkCount, chunks.length);
      assert.equal(
        storedChunks.some(
          (chunk) => chunk.chunk.metadata?.["searchableUnitType"] === "table_chunk"
        ),
        true
      );
      assert.equal(
        storedChunks.some(
          (chunk) => chunk.chunk.metadata?.["searchableUnitType"] === "parser_gap_chunk"
        ),
        true
      );
      assert.equal(
        storedChunks.some((chunk) => chunk.chunk.metadata?.["tableId"] === "table_postgres"),
        true
      );
      assert.equal(results.length > 0, true);
      assert.equal(results[0]?.reasons.includes("postgres_fts_match"), true);
    } finally {
      await pool.query(`drop schema if exists ${quoteIdentifier(schema)} cascade`);
      await pool.end();
    }
  }
);

async function createPostgresIndexSchema(pool: pg.Pool, schema: string): Promise<void> {
  const qualified = (tableName: string) =>
    `${quoteIdentifier(schema)}.${quoteIdentifier(tableName)}`;
  await pool.query(`create schema ${quoteIdentifier(schema)}`);
  await pool.query(`
    create table ${qualified("documents")} (
      id text primary key,
      tenant_id text not null,
      namespace_id text not null,
      source_id text not null,
      source_kind text not null,
      trust_tier text not null,
      access_tags text[] not null default '{}',
      document jsonb not null,
      indexed_at timestamptz not null,
      updated_at timestamptz,
      created_at timestamptz not null default now()
    );

    create table ${qualified("chunks")} (
      id text primary key,
      document_id text not null references ${qualified("documents")}(id) on delete cascade,
      tenant_id text not null,
      namespace_id text not null,
      source_id text not null,
      source_kind text not null,
      trust_tier text not null,
      safety_flags text[] not null default '{}',
      access_tags text[] not null default '{}',
      chunk jsonb not null,
      fts tsvector not null,
      indexed_at timestamptz not null,
      updated_at timestamptz,
      created_at timestamptz not null default now()
    );

    create table ${qualified("chunk_vectors")} (
      id text primary key
    );

    create index ${quoteIdentifier(`${schema}_chunks_fts_idx`)}
      on ${qualified("chunks")} using gin (fts);
  `);
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function postgresParserLayout(body: string): DocumentLayout {
  const headerStart = body.indexOf("Region Revenue");
  const rowStart = body.indexOf("North America 120");
  const ocrNoteStart = body.indexOf("OCR note");

  return {
    parserId: "postgres-parser",
    parserVersion: "1.0.0",
    strategy: "hybrid",
    pages: [
      { pageNumber: 1, width: 612, height: 792, unit: "point" },
      { pageNumber: 2, width: 612, height: 792, unit: "point" }
    ],
    regions: [
      {
        id: "table_region",
        kind: "table",
        pageNumber: 1,
        characterStart: headerStart,
        characterEnd: rowStart + "North America 120".length
      },
      {
        id: "cell_header_region",
        kind: "text",
        pageNumber: 1,
        text: "Region",
        characterStart: headerStart,
        characterEnd: headerStart + "Region".length
      },
      {
        id: "cell_header_revenue",
        kind: "text",
        pageNumber: 1,
        text: "Revenue",
        characterStart: headerStart + "Region ".length,
        characterEnd: headerStart + "Region Revenue".length
      },
      {
        id: "cell_region",
        kind: "text",
        pageNumber: 1,
        text: "North America",
        characterStart: rowStart,
        characterEnd: rowStart + "North America".length
      },
      {
        id: "cell_revenue",
        kind: "text",
        pageNumber: 1,
        text: "120",
        characterStart: rowStart + "North America ".length,
        characterEnd: rowStart + "North America 120".length
      },
      {
        id: "page_image_region",
        kind: "page_image",
        pageNumber: 2
      },
      {
        id: "ocr_note",
        kind: "text",
        pageNumber: 2,
        text: "OCR note",
        characterStart: ocrNoteStart,
        characterEnd: ocrNoteStart + "OCR note".length
      }
    ],
    tables: [
      {
        id: "table_postgres",
        pageNumber: 1,
        regionId: "table_region",
        cells: [
          { rowIndex: 0, columnIndex: 0, text: "Region", regionId: "cell_header_region" },
          { rowIndex: 0, columnIndex: 1, text: "Revenue", regionId: "cell_header_revenue" },
          { rowIndex: 1, columnIndex: 0, text: "North America", regionId: "cell_region" },
          { rowIndex: 1, columnIndex: 1, text: "120", regionId: "cell_revenue" }
        ]
      }
    ]
  };
}
