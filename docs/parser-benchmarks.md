# Parser Benchmarks

This benchmark layer connects external document parsing datasets to the local parser
system. It is separate from profile evals: parser benchmarks measure whether ingestion
can extract text, layout, tables, formulas, and reading order before retrieval or answer
generation are involved.

## Readiness Check

Run the local parser dependency check before downloading a large dataset:

```bash
npm run parser:benchmark:doctor
```

For these visual-heavy benchmarks, the runner needs at least one local image parser:
Docling, `paddleocr-rag-parser`, or `mineru-rag-parser`. PDF-mode OmniDocBench needs
`pdfplumber`, `pypdf`, or Docling. A project-local Python environment keeps those
dependencies out of system Python:

```bash
python3 -m venv .rag/parser-benchmark-venv
.rag/parser-benchmark-venv/bin/python -m pip install --upgrade pip
.rag/parser-benchmark-venv/bin/python -m pip install -r requirements-parser-benchmarks.txt
```

The built-in parser wrappers and `npm run parser:benchmark:doctor` auto-detect
`.rag/parser-benchmark-venv/bin/python`. You can still override that with
`RAG_DOCLING_PYTHON`, `RAG_PDF_PYTHON`, `RAG_MARKITDOWN_PYTHON`, or
`RAG_OPENPYXL_PYTHON`.

Docling OCR is enabled automatically for image inputs. For scanned PDFs, set
`RAG_DOCLING_OCR=true`. PaddleOCR and MinerU are optional extra commands; the doctor
reports them as warnings when Docling is available.

The benchmark runners fail fast when no cases are loaded or when required parser
dependencies are missing. Use `--skip-env-check true` only for custom parser setups.

## OmniDocBench

The first supported external shape is OmniDocBench JSON. The loader accepts the official
page-level annotation format with `page_info` and `layout_dets`, including category,
polygon, ignore flag, reading order, OCR text, formula LaTeX, and table HTML.

Run a small local subset after downloading the dataset:

```bash
npm run parser:benchmark -- \
  --dataset omnidocbench \
  --annotations /path/to/OmniDocBench.json \
  --images-root /path/to/images \
  --limit 20 \
  --report-dir .rag/parser-benchmarks/omnidocbench-smoke
```

If you converted page images to PDFs, use `--pdf-root` and `--prefer-pdf true`:

```bash
npm run parser:benchmark -- \
  --dataset omnidocbench \
  --annotations /path/to/OmniDocBench.json \
  --pdf-root /path/to/pdfs \
  --prefer-pdf true \
  --limit 20
```

The runner writes:

- `.rag/parser-benchmarks/latest/parser-benchmark.json`
- `.rag/parser-benchmarks/latest/parser-benchmark.md`

## Current Metrics

- text similarity by normalized edit similarity
- layout recall by bounding-box IoU
- table recall by table-region IoU or parsed table text coverage
- formula recall by LaTeX/text coverage or equation-region fallback
- reading-order score from expected snippet order in parsed body text

These are internal bridge metrics. They are useful for smoke testing and regression
tracking, but they do not replace OmniDocBench's official metrics such as TEDS, CDM,
MGAM, or mAP.

## TableBank

TableBank table detection annotations use MS COCO format. The TableBank loader
converts each image with table annotations into a parser benchmark case and evaluates
table detection through layout/table recall. Text, formula, and reading-order metrics
are disabled because the detection annotations do not contain OCR ground truth.

The repository includes a tiny synthetic TableBank-compatible fixture at
`src/parser-benchmarks/fixtures/tablebank-mini/`. It contains one PNG image plus
COCO-style annotations with a table box and optional table text/html. This fixture is
for loader/scoring regression tests only; it is not a substitute for the real
TableBank dataset.

Run the checked-in tiny fixture without external parser quality dependencies:

```bash
npm run parser:benchmark -- \
  --dataset tablebank \
  --annotations src/parser-benchmarks/fixtures/tablebank-mini/annotations.json \
  --images-root src/parser-benchmarks/fixtures/tablebank-mini/images \
  --parser fixture-layout \
  --report-dir .rag/parser-benchmarks/tablebank-mini
```

Use the default `--parser local` path when you want to test the actual local parser stack:

```bash
npm run parser:benchmark -- \
  --dataset tablebank \
  --annotations /path/to/tablebank-detection.json \
  --images-root /path/to/tablebank/images \
  --limit 50 \
  --report-dir .rag/parser-benchmarks/tablebank-smoke
```

## DocVQA

DocVQA can be run in two explicit modes. The default `parser-only` mode checks
whether the parser output contains the accepted answer text. It does not score
chunking, retrieval, answer generation, or citation selection.

The loader reads records with document image paths, questions, accepted answers, and
optional expected citation pages. Parser-only mode exercises:

```text
parse -> answer-text score
```

```bash
npm run document-qa:benchmark -- \
  --dataset docvqa \
  --mode parser-only \
  --annotations /path/to/docvqa.json \
  --images-root /path/to/docvqa/images \
  --limit 50 \
  --report-dir .rag/document-qa-benchmarks/docvqa-parser-smoke
```

Use `--mode rag` when you want the full local RAG information-flow path:

```text
parse -> chunk -> index -> retrieve -> answer -> score
```

```bash
npm run document-qa:benchmark -- \
  --dataset docvqa \
  --mode rag \
  --annotations /path/to/docvqa.json \
  --images-root /path/to/docvqa/images \
  --limit 50 \
  --report-dir .rag/document-qa-benchmarks/docvqa-rag-smoke
```

Run the checked-in tiny fixture without OCR or external datasets:

```bash
npm run document-qa:benchmark -- \
  --dataset docvqa \
  --mode parser-only \
  --annotations fixtures/document-qa/tiny-docvqa/annotations.json \
  --images-root fixtures/document-qa/tiny-docvqa \
  --parser fixture-text \
  --report-dir .rag/document-qa-benchmarks/tiny-docvqa
```

The runner writes:

- `.rag/document-qa-benchmarks/latest/document-qa-benchmark.json`
- `.rag/document-qa-benchmarks/latest/document-qa-benchmark.md`

In `parser-only` mode, the report focuses on answer extraction from parsed text:

- whether an accepted answer appears in parsed text
- best answer text similarity
- ANLS score
- relaxed numeric accuracy

In `rag` mode, scoring is additionally split by stage:

- `parser`: parsed text did not contain an accepted answer, or parsing failed.
- `ingestion`: normalization, chunking, or indexing rejected the parsed document.
- `retrieval`: the accepted answer was parsed and indexed, but retrieval missed the answer chunk.
- `citation`: the generated answer matched, but the final citation did not match the expected source/page.
- `answer_generation`: retrieval found the evidence, but the generated answer did not match accepted answers.

Answer match and citation correctness are reported separately in `rag` mode. The default local model
used by this benchmark is an extractive oracle over retrieved context; it is meant to
test the RAG path and attribution, not an external LLM's reasoning quality.

## ChartQA

ChartQA is wired through the same document-QA benchmark runner. The loader accepts the
original ChartQA JSON shape (`imgname`, `query`, `label`) and Hugging Face-style records
(`image`, `query`, `label`, `human_or_machine`). Point `--images-root` at the folder that
contains the chart PNG files, such as the split's `png` directory.

```bash
npm run document-qa:benchmark -- \
  --dataset chartqa \
  --mode parser-only \
  --annotations "/path/to/ChartQA Dataset/train/train_human.json" \
  --images-root "/path/to/ChartQA Dataset/train/png" \
  --split train \
  --limit 50 \
  --report-dir .rag/document-qa-benchmarks/chartqa-parser-smoke
```

ChartQA parser-only scoring reports relaxed numeric accuracy with a default 5% relative
tolerance. Add `--mode rag` only when you want retrieval, answer generation, and citation
selection to count.

Run the checked-in tiny fixture without OCR or external datasets:

```bash
npm run document-qa:benchmark -- \
  --dataset chartqa \
  --mode parser-only \
  --annotations fixtures/document-qa/tiny-chartqa/annotations.json \
  --images-root fixtures/document-qa/tiny-chartqa \
  --parser fixture-text \
  --report-dir .rag/document-qa-benchmarks/tiny-chartqa
```

Shared document-QA scoring knobs:

- `--minimum-answer-similarity 0.85` controls the parser-recoverability pass threshold.
- `--anls-threshold 0.5` controls the ANLS similarity cutoff.
- `--numeric-relative-tolerance 0.05` controls relaxed numeric matching.
- `--mode parser-only` checks parser answer extraction only.
- `--mode rag` checks parse, chunking, retrieval, answer generation, and citation flow.
- `--parser local` uses the local parser router for real image/PDF inputs.
- `--parser fixture-text` uses annotation text plus one synthetic page layout for tiny local fixtures.
- `--top-k 4` controls retrieval depth for the `rag` benchmark path.

## Next Benchmarks

After OmniDocBench, TableBank, DocVQA, and ChartQA smoke runs are stable, add loaders for:

- Open RAG Benchmark or VisDoM for end-to-end RAG behavior
