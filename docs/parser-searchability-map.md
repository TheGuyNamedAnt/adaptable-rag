# Parser Searchability Map

Parsing is only useful to RAG when parsed output becomes one of four things:

1. searchable evidence
2. citation metadata
3. readiness signal
4. rejected invalid output

This map tracks whether each parser output type is saved, searchable, how it is searched today,
and what gap remains.

## Current Map

| Parser output             | Saved?                                                               | Currently searchable? | How                                                                                    | Gap                                                                                  | Priority |
| ------------------------- | -------------------------------------------------------------------- | --------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | -------- |
| Body text                 | Yes                                                                  | Yes                   | Normal `RagChunk` text, keyword search, vector search when embeddings are configured   | Good baseline, but complex tables/figures can flatten poorly                         | P0       |
| Headings                  | Yes, if parser includes them in `body` and/or `layout.regions`       | Yes                   | `heading_chunk`, body chunks, citation layout ids, lightweight routing boost           | Nearby-section expansion can still improve answer assembly                           | P1       |
| Paragraphs                | Yes                                                                  | Yes                   | Normal chunk text                                                                      | Good baseline; quality depends on chunk boundaries                                   | P0       |
| Lists                     | Yes, if included in `body`; layout can tag list regions              | Partially             | Normal chunk text                                                                      | List item boundaries are not first-class searchable units                            | P2       |
| Tables                    | Yes, as `layout.tables` and body text when parser emits both         | Yes                   | `table_chunk`, `table_row_chunk`, body chunks, citation layout ids                     | Whole-table quality still depends on parser cell/region coverage                     | P0       |
| Table rows                | Yes when row cells map to source-backed regions                      | Yes                   | `table_row_chunk` with table id, row index, caption, columns, and enriched embedding   | Rows without source-backed cells become warnings instead of fabricated chunks        | P0       |
| Table cells               | Yes inside `layout.tables[].cells`                                   | Partially             | Searched through table and row chunks                                                  | Individual cell chunks are not materialized separately                               | P1       |
| Table captions            | Yes, as body text and/or caption layout region                       | Yes                   | `table_caption_chunk`, relation chunks, table chunks                                   | Caption pull-through now exists; deeper connected retrieval can still improve recall | P0       |
| Figure captions           | Yes, as body text and/or caption layout region                       | Yes                   | `figure_caption_chunk`, `visual_asset_chunk`, relation chunks                          | Requires source-backed caption text for text fallback                                | P1       |
| Figures/images            | Yes, as `layout.visualAssets`                                        | Yes, with fallback    | Visual vectors when configured; `visual_asset_chunk` when source-backed caption exists | Uncaptioned assets still produce readiness/searchability warnings                    | P1       |
| Page images               | Yes, as visual assets or `page_image` regions when parser emits them | Partially             | Visual vectors if configured; parser-gap/readiness warnings for weak text coverage     | Pure image-only pages without source text cannot become answer chunks                | P0       |
| Page structure            | Yes, as `layout.pages`, region page numbers, and citation metadata   | Yes                   | `page_summary_chunk`, citation page numbers, readiness page counts                     | Page summaries are source-backed spans, not synthetic summaries                      | P2       |
| Bounding boxes            | Yes                                                                  | No direct search      | Citation metadata and visual vector metadata                                           | Useful for evidence display, not ranking/search                                      | P3       |
| Layout relations          | Yes, as `layout.relations`; chunk relationships can be built         | Yes                   | `layout_relation_chunk`, chunk relationship graph, layout relation vectors             | Relation quality depends on parser target/source ids                                 | P1       |
| Parser metadata           | Yes                                                                  | Partially             | Stored in document/chunk metadata                                                      | Not consistently used for ranking or readiness                                       | P2       |
| Parser warnings           | Yes, as ingestion warnings/reports                                   | Readiness-aware       | Parser quality reports, ingestion integrity, production ingest summary                 | Parser-score-aware rank downgrades are still limited                                 | P1       |
| OCR page gaps             | Yes, as readiness and source-backed parser-gap chunks when possible  | Readiness-aware       | `parser_gap_chunk`, OCR audit, ingestion integrity warnings                            | No fake evidence is created for pages with no source-backed text                     | P0       |
| Visual asset descriptions | Yes when parser writes text/caption/metadata                         | Yes                   | Caption/body text, `visual_asset_chunk`, visual vectors                                | Uncaptioned assets still need visual model coverage                                  | P1       |
| Parser decision trace     | Yes when parser/router emits metadata                                | No direct search      | Parser quality analyzer                                                                | Useful for readiness, not retrieval                                                  | P2       |

## Target Searchable Units

The first implementation should keep using `RagChunk`. Do not introduce a separate index model
until the existing chunk/index contracts stop fitting.

Derived units should be represented as normal chunks with metadata such as:

```ts
{
  searchableUnitType: "table_row_chunk",
  derivedFrom: "parser_layout",
  sourceDocumentId: "doc_123",
  parserId: "best-local-parser",
  tableId: "table_1",
  visualAssetId: undefined,
  layoutRegionIds: ["region_table_1"],
  pageNumber: 3
}
```

Initial unit types:

| Unit type               | Purpose                                                                |
| ----------------------- | ---------------------------------------------------------------------- |
| `body_chunk`            | Existing normal text chunks                                            |
| `heading_chunk`         | Searchable section routing hints                                       |
| `table_chunk`           | Whole-table context with title/caption/columns                         |
| `table_row_chunk`       | Row-level recall for numeric and lookup questions                      |
| `table_caption_chunk`   | Caption preservation and table pull-through                            |
| `figure_caption_chunk`  | Caption preservation and figure pull-through                           |
| `visual_asset_chunk`    | Text fallback for figures/images when visual vectors are absent        |
| `page_summary_chunk`    | Page-level context for layout-heavy documents                          |
| `layout_relation_chunk` | Searchable relationship between regions, captions, tables, and figures |
| `parser_gap_chunk`      | Non-answer readiness evidence for OCR/page/parser gaps                 |

## Implemented Builder

The ingestion pipeline now adds a layer after normalization and before indexing:

```text
RagDocument + normal body chunks
→ SearchableArtifactBuilder
→ normal chunks + derived chunks + chunk relationships + readiness warnings
→ index
```

The builder:

- preserve original provenance and access scope on every derived chunk
- use deterministic ids based on document id, unit type, source ids, and text hash
- keep `characterStart`/`characterEnd` valid when the derived text maps to a body span
- mark synthetic/enriched text with metadata instead of pretending it is raw source text
- keep layout region ids, table ids, visual asset ids, page numbers, and bounding boxes
- creates `parser_gap_chunk` only when the OCR-risk page has source-backed text
- warns instead of fabricating evidence for image-only/OCR-missing pages
- marks parser-gap chunks with `answerEvidence: false`; lightweight reranking downgrades them

## Enriched Embedding Text

Derived chunks should embed text that carries context, not only raw cell values.

Example table row embedding text:

```text
Table: Revenue by Region
Caption: Q4 revenue summary
Columns: Region, Revenue
Row: North America, 120
Page: 3
```

Example figure fallback text:

```text
Figure: Refund workflow diagram
Caption: Escalation flow for failed refunds
Page: 4
Visual asset: figure_2
```

## Retrieval And Readiness Requirements

Retrieval now uses unit metadata in lightweight reranking:

- boosts `table_chunk` and `table_row_chunk` for table/numeric questions
- boosts visual/caption chunks for visual questions
- boosts relation chunks for relation/caption questions
- downgrades `parser_gap_chunk` as answer evidence
- reports OCR/page gaps through integrity/readiness warnings

Readiness should answer:

| Metric                  | Why it matters                           |
| ----------------------- | ---------------------------------------- |
| documents accepted      | Corpus reached the library               |
| body chunks created     | Baseline text search coverage            |
| derived chunks created  | Parser output became searchable          |
| table chunks created    | Structured tables are searchable         |
| visual chunks created   | Visual assets have fallback/search units |
| vector coverage         | Semantic text search coverage            |
| visual vector coverage  | Image/figure search coverage             |
| pages with no text      | OCR/scanned-page risk                    |
| parser-quality warnings | Parse reliability risk                   |
| retrieval gaps          | Known outputs saved but not searchable   |

## Implementation Status

1. Done: map and searchable unit types.
2. Done: `SearchableArtifactBuilder` for table, row, caption, visual, page, relation, and source-backed parser-gap chunks.
3. Done: builder runs in `IngestPipeline` before index writes.
4. Done: embedding input prefers `searchableEmbeddingText`.
5. Done: ingestion integrity/readiness reports parser-searchability coverage.
6. Done: focused tests cover builder output, ingestion save/read-back, JSON durable reload, readiness, and lightweight reranking.
7. Done: SQLite document/chunk persistence covers parser-derived chunks even when the Node SQLite build lacks FTS5.
8. Done: Postgres document/chunk persistence has a gated DB-backed smoke test with parser-derived chunk read-back and keyword search.
9. Remaining: direct SQLite FTS execution still depends on a Node SQLite build with FTS5; when it is missing, readiness now reports the gap explicitly instead of blocking durable chunk storage.
