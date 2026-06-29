import { readFile } from "node:fs/promises";
import path from "node:path";

import type { DocumentParseRequest } from "../parsing/parser.js";
import type { DocumentQaBenchmarkCase } from "./benchmark-types.js";

export interface DocVqaLoaderOptions {
  readonly maxCases?: number;
  readonly tags?: readonly string[];
}

export interface DocVqaRequestOptions {
  readonly imagesRoot: string;
  readonly requestedAt: string;
}

type JsonRecord = Readonly<Record<string, unknown>>;

export async function loadDocVqaCasesFromFile(
  filePath: string,
  options: DocVqaLoaderOptions = {}
): Promise<readonly DocumentQaBenchmarkCase[]> {
  const json = JSON.parse(await readFile(filePath, "utf8"));
  return loadDocVqaCases(json, options);
}

export function loadDocVqaCases(
  value: unknown,
  options: DocVqaLoaderOptions = {}
): readonly DocumentQaBenchmarkCase[] {
  const { records, datasetSplit } = docVqaRecords(value);
  const cases: DocumentQaBenchmarkCase[] = [];
  for (const [index, record] of records.entries()) {
    const testCase = docVqaCaseFromRecord(record, index, options, datasetSplit);
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

export async function createDocVqaParseRequest(
  testCase: DocumentQaBenchmarkCase,
  options: DocVqaRequestOptions
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

function docVqaRecords(value: unknown): {
  readonly records: readonly JsonRecord[];
  readonly datasetSplit?: string;
} {
  if (Array.isArray(value)) {
    return { records: value.filter(isRecord) };
  }
  if (!isRecord(value)) {
    throw new Error("DocVQA annotations must be an array or an object with data[].");
  }
  const datasetSplit = stringValue(value["dataset_split"]) ?? stringValue(value["data_split"]);
  const data = value["data"];
  if (Array.isArray(data)) {
    return {
      records: data.filter(isRecord),
      ...(datasetSplit === undefined ? {} : { datasetSplit })
    };
  }
  const questions = value["questions"];
  if (Array.isArray(questions)) {
    return {
      records: questions.filter(isRecord),
      ...(datasetSplit === undefined ? {} : { datasetSplit })
    };
  }
  throw new Error("DocVQA annotations must include data[] or questions[].");
}

function docVqaCaseFromRecord(
  record: JsonRecord,
  index: number,
  options: DocVqaLoaderOptions,
  datasetSplit?: string
): DocumentQaBenchmarkCase | undefined {
  const imagePath = imagePathFromRecord(record);
  const textPath = textPathFromRecord(record);
  const inlineText = inlineTextFromRecord(record);
  const question = stringValue(record["question"]);
  const acceptedAnswers = answersFromRecord(record);
  if (!imagePath || !question || acceptedAnswers.length === 0) {
    return undefined;
  }
  const id =
    idValue(record["questionId"]) ?? idValue(record["question_id"]) ?? `docvqa_${index + 1}`;
  const documentId = idValue(record["docId"]) ?? idValue(record["doc_id"]);
  const pageNumber = idValue(record["ucsf_document_page_no"]) ?? idValue(record["page"]);
  const expectedCitationPageNumber = pageNumberValue(
    record["expected_citation_page"] ?? record["page_number"] ?? record["page"] ?? pageNumber
  );
  const split =
    stringValue(record["data_split"]) ?? stringValue(record["dataset_split"]) ?? datasetSplit;
  return {
    dataset: "docvqa",
    id,
    title: path.basename(imagePath),
    sourceId: `docvqa:${id}`,
    imagePath,
    ...(textPath === undefined ? {} : { textPath }),
    ...(inlineText === undefined ? {} : { inlineText }),
    question,
    acceptedAnswers,
    ...(documentId === undefined ? {} : { documentId }),
    ...(pageNumber === undefined ? {} : { pageNumber }),
    ...(expectedCitationPageNumber === undefined ? {} : { expectedCitationPageNumber }),
    ...(split === undefined ? {} : { split }),
    tags: ["docvqa", ...(split === undefined ? [] : [split]), ...(options.tags ?? [])]
  };
}

function imagePathFromRecord(record: JsonRecord): string | undefined {
  const image = record["image"];
  return (
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
  const answers = record["answers"];
  if (Array.isArray(answers)) {
    return [
      ...new Set(
        answers.flatMap((answer) => {
          if (typeof answer === "string" && answer.trim()) {
            return [answer.trim()];
          }
          if (isRecord(answer) && typeof answer["answer"] === "string" && answer["answer"].trim()) {
            return [answer["answer"].trim()];
          }
          return [];
        })
      )
    ];
  }
  const answer = stringValue(record["answer"]) ?? stringValue(record["multiple_choice_answer"]);
  return answer ? [answer] : [];
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
