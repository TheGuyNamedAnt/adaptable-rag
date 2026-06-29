import { readFile } from "node:fs/promises";
import path from "node:path";

import type { DocumentParseRequest } from "../parsing/parser.js";
import type { DocumentQaBenchmarkCase } from "./benchmark-types.js";

export interface ChartQaLoaderOptions {
  readonly maxCases?: number;
  readonly split?: string;
  readonly tags?: readonly string[];
}

export interface ChartQaRequestOptions {
  readonly imagesRoot: string;
  readonly requestedAt: string;
}

type JsonRecord = Readonly<Record<string, unknown>>;

export async function loadChartQaCasesFromFile(
  filePath: string,
  options: ChartQaLoaderOptions = {}
): Promise<readonly DocumentQaBenchmarkCase[]> {
  const json = JSON.parse(await readFile(filePath, "utf8"));
  return loadChartQaCases(json, options);
}

export function loadChartQaCases(
  value: unknown,
  options: ChartQaLoaderOptions = {}
): readonly DocumentQaBenchmarkCase[] {
  const { records, datasetSplit } = chartQaRecords(value);
  const cases: DocumentQaBenchmarkCase[] = [];
  for (const [index, record] of records.entries()) {
    const testCase = chartQaCaseFromRecord(record, index, options, datasetSplit);
    if (!testCase) {
      continue;
    }
    cases.push(testCase);
    if (options.maxCases !== undefined && cases.length >= options.maxCases) {
      break;
    }
  }
  return cases;
}

export async function createChartQaParseRequest(
  testCase: DocumentQaBenchmarkCase,
  options: ChartQaRequestOptions
): Promise<DocumentParseRequest> {
  const fixtureText =
    testCase.inlineText ??
    (testCase.textPath === undefined
      ? undefined
      : await readFile(resolveBenchmarkAssetPath(options.imagesRoot, testCase.textPath), "utf8"));
  if (fixtureText !== undefined) {
    const fixturePath = resolveBenchmarkAssetPath(
      options.imagesRoot,
      testCase.textPath ?? testCase.imagePath
    );
    return {
      sourceId: testCase.sourceId,
      sourceKind: "uploaded_file",
      title: testCase.title,
      contentType: "text/plain",
      text: fixtureText,
      path: fixturePath,
      requestedAt: options.requestedAt,
      metadata: {
        benchmarkDataset: testCase.dataset,
        benchmarkCaseId: testCase.id,
        question: testCase.question,
        ...(testCase.expectedCitationPageNumber === undefined
          ? {}
          : { expectedCitationPageNumber: testCase.expectedCitationPageNumber })
      }
    };
  }

  const imagePath = resolveBenchmarkAssetPath(options.imagesRoot, testCase.imagePath);
  return {
    sourceId: testCase.sourceId,
    sourceKind: "uploaded_file",
    title: testCase.title,
    contentType: contentTypeForImagePath(imagePath),
    bytes: await readFile(imagePath),
    path: imagePath,
    requestedAt: options.requestedAt,
    metadata: {
      benchmarkDataset: testCase.dataset,
      benchmarkCaseId: testCase.id,
      question: testCase.question,
      ...(testCase.expectedCitationPageNumber === undefined
        ? {}
        : { expectedCitationPageNumber: testCase.expectedCitationPageNumber })
    }
  };
}

function chartQaRecords(value: unknown): {
  readonly records: readonly JsonRecord[];
  readonly datasetSplit?: string;
} {
  if (Array.isArray(value)) {
    return { records: value.filter(isRecord) };
  }
  if (!isRecord(value)) {
    throw new Error("ChartQA annotations must be an array or an object with data[].");
  }
  const datasetSplit = stringValue(value["split"]) ?? stringValue(value["dataset_split"]);
  const data = value["data"];
  if (Array.isArray(data)) {
    return {
      records: data.filter(isRecord),
      ...(datasetSplit === undefined ? {} : { datasetSplit })
    };
  }
  const rows = value["rows"];
  if (Array.isArray(rows)) {
    return {
      records: rows.filter(isRecord),
      ...(datasetSplit === undefined ? {} : { datasetSplit })
    };
  }
  throw new Error("ChartQA annotations must include data[] or rows[].");
}

function chartQaCaseFromRecord(
  record: JsonRecord,
  index: number,
  options: ChartQaLoaderOptions,
  datasetSplit?: string
): DocumentQaBenchmarkCase | undefined {
  const imagePath = imagePathFromRecord(record);
  const textPath = textPathFromRecord(record);
  const inlineText = inlineTextFromRecord(record);
  const question = stringValue(record["query"]) ?? stringValue(record["question"]);
  const acceptedAnswers = answersFromRecord(record);
  if (!imagePath || !question || acceptedAnswers.length === 0) {
    return undefined;
  }
  const id =
    idValue(record["id"]) ??
    idValue(record["question_id"]) ??
    idValue(record["questionId"]) ??
    `${path.basename(imagePath, path.extname(imagePath))}_${index + 1}`;
  const split =
    stringValue(record["split"]) ??
    stringValue(record["dataset_split"]) ??
    options.split ??
    datasetSplit;
  const answerSource = answerSourceFromRecord(record);
  const expectedCitationPageNumber = pageNumberValue(
    record["expected_citation_page"] ?? record["page_number"] ?? record["page"]
  );
  return {
    dataset: "chartqa",
    id,
    title: path.basename(imagePath),
    sourceId: `chartqa:${id}`,
    imagePath,
    ...(textPath === undefined ? {} : { textPath }),
    ...(inlineText === undefined ? {} : { inlineText }),
    question,
    acceptedAnswers,
    ...(expectedCitationPageNumber === undefined ? {} : { expectedCitationPageNumber }),
    ...(split === undefined ? {} : { split }),
    tags: [
      "chartqa",
      ...(split === undefined ? [] : [split]),
      ...(answerSource === undefined ? [] : [answerSource]),
      ...(options.tags ?? [])
    ]
  };
}

function imagePathFromRecord(record: JsonRecord): string | undefined {
  const image = record["image"];
  return (
    stringValue(record["imgname"]) ??
    stringValue(image) ??
    imagePathFromImageObject(image) ??
    stringValue(record["image_path"]) ??
    stringValue(record["filename"]) ??
    stringValue(record["file_name"])
  );
}

function textPathFromRecord(record: JsonRecord): string | undefined {
  return stringValue(record["document_text_path"]) ?? stringValue(record["text_path"]);
}

function inlineTextFromRecord(record: JsonRecord): string | undefined {
  return (
    stringValue(record["document_text"]) ??
    stringValue(record["chart_text"]) ??
    stringValue(record["ocr_text"]) ??
    stringValue(record["text"])
  );
}

function imagePathFromImageObject(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return (
    stringValue(value["path"]) ?? stringValue(value["filename"]) ?? stringValue(value["file_name"])
  );
}

function answersFromRecord(record: JsonRecord): readonly string[] {
  return uniqueStrings([
    ...answerValues(record["label"]),
    ...answerValues(record["answer"]),
    ...answerValues(record["answers"])
  ]);
}

function answerValues(value: unknown): readonly string[] {
  if (Array.isArray(value)) {
    return value.flatMap(answerValues);
  }
  if (typeof value === "string" && value.trim()) {
    return [value.trim()];
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return [String(value)];
  }
  if (typeof value === "boolean") {
    return [value ? "Yes" : "No"];
  }
  if (isRecord(value)) {
    return answerValues(value["answer"]);
  }
  return [];
}

function answerSourceFromRecord(record: JsonRecord): string | undefined {
  const source = idValue(record["human_or_machine"]);
  if (source === "0") {
    return "human";
  }
  if (source === "1") {
    return "machine";
  }
  return source;
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter((value) => value.trim()).map((value) => value.trim()))];
}

function resolveBenchmarkAssetPath(root: string, relativePath: string): string {
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(resolvedRoot, relativePath);
  const relative = path.relative(resolvedRoot, resolvedPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Benchmark asset path escapes root: ${relativePath}`);
  }
  return resolvedPath;
}

function contentTypeForImagePath(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".jpg" || extension === ".jpeg") {
    return "image/jpeg";
  }
  if (extension === ".webp") {
    return "image/webp";
  }
  return "image/png";
}

function idValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function pageNumberValue(value: unknown): number | undefined {
  const raw = idValue(value);
  if (raw === undefined) {
    return undefined;
  }
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
