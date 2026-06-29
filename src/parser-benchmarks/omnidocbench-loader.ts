import { readFile } from "node:fs/promises";
import path from "node:path";

import type { SourceKind } from "../documents/provenance.js";
import type { DocumentParseRequest } from "../parsing/parser.js";
import type {
  ParserBenchmarkAnnotation,
  ParserBenchmarkBox,
  ParserBenchmarkCase
} from "./benchmark-types.js";

export interface OmniDocBenchLoaderOptions {
  readonly maxCases?: number;
  readonly includeIgnoredAnnotations?: boolean;
  readonly contentType?: string;
  readonly tags?: readonly string[];
}

export interface OmniDocBenchRequestOptions {
  readonly imagesRoot?: string;
  readonly pdfRoot?: string;
  readonly requestedAt: string;
  readonly sourceKind?: SourceKind;
  readonly preferPdf?: boolean;
}

type JsonRecord = Readonly<Record<string, unknown>>;

export async function loadOmniDocBenchCasesFromFile(
  filePath: string,
  options: OmniDocBenchLoaderOptions = {}
): Promise<readonly ParserBenchmarkCase[]> {
  const json = JSON.parse(await readFile(filePath, "utf8"));
  return loadOmniDocBenchCases(json, options);
}

export function loadOmniDocBenchCases(
  value: unknown,
  options: OmniDocBenchLoaderOptions = {}
): readonly ParserBenchmarkCase[] {
  if (!Array.isArray(value)) {
    throw new Error("OmniDocBench annotations must be a JSON array.");
  }

  const cases: ParserBenchmarkCase[] = [];
  for (const [index, sample] of value.entries()) {
    if (!isRecord(sample)) {
      continue;
    }
    const testCase = omniDocBenchCaseFromSample(sample, index, options);
    if (testCase) {
      cases.push(testCase);
      if (options.maxCases !== undefined && cases.length >= options.maxCases) {
        break;
      }
    }
  }
  return cases;
}

export async function createOmniDocBenchParseRequest(
  testCase: ParserBenchmarkCase,
  options: OmniDocBenchRequestOptions
): Promise<DocumentParseRequest> {
  const sourceKind = options.sourceKind ?? "uploaded_file";
  const baseRequest = {
    sourceId: testCase.sourceId,
    sourceKind,
    title: testCase.title,
    requestedAt: options.requestedAt,
    metadata: {
      benchmarkDataset: testCase.dataset,
      benchmarkCaseId: testCase.id,
      pageNumber: testCase.page.pageNumber
    }
  };

  if (options.preferPdf !== false && options.pdfRoot) {
    const pdfPath = resolveBenchmarkAssetPath(options.pdfRoot, pdfPathForCase(testCase));
    return {
      ...baseRequest,
      contentType: "application/pdf",
      bytes: await readFile(pdfPath),
      path: pdfPath
    };
  }

  if (options.imagesRoot && testCase.page.imagePath) {
    const imagePath = resolveBenchmarkAssetPath(options.imagesRoot, testCase.page.imagePath);
    return {
      ...baseRequest,
      contentType: contentTypeForImagePath(imagePath),
      bytes: await readFile(imagePath),
      path: imagePath
    };
  }

  throw new Error(
    `OmniDocBench case "${testCase.id}" requires --images-root or --pdf-root to create a parser request.`
  );
}

function omniDocBenchCaseFromSample(
  sample: JsonRecord,
  index: number,
  options: OmniDocBenchLoaderOptions
): ParserBenchmarkCase | undefined {
  const pageInfo = isRecord(sample["page_info"]) ? sample["page_info"] : {};
  const imagePath = stringValue(pageInfo["image_path"]);
  const sourcePageNumber = integerValue(pageInfo["page_no"]);
  const pageNumber = 1;
  const width = numberValue(pageInfo["width"]) ?? 0;
  const height = numberValue(pageInfo["height"]) ?? 0;
  const rawAnnotations = Array.isArray(sample["layout_dets"]) ? sample["layout_dets"] : [];
  const annotations = rawAnnotations.flatMap((annotation, annotationIndex) =>
    isRecord(annotation)
      ? annotationFromOmniDocBench(annotation, annotationIndex, options.includeIgnoredAnnotations)
      : []
  );
  const activeAnnotations = annotations.filter((annotation) => !annotation.ignored);
  const orderedAnnotations = [...activeAnnotations].sort(compareAnnotationsByOrder);
  const expectedText = orderedAnnotations
    .map(annotationTextForBody)
    .filter((text) => text.trim().length > 0)
    .join("\n");
  const id = caseId(pageInfo, imagePath, index);

  return {
    dataset: "omnidocbench",
    id,
    title: imagePath ? path.basename(imagePath) : `omnidocbench-page-${index + 1}`,
    sourceId: `omnidocbench:${id}`,
    contentType: options.contentType ?? "image/png",
    page: {
      pageNumber,
      width,
      height,
      ...(imagePath === undefined ? {} : { imagePath }),
      attributes: {
        ...metadataRecord(pageInfo["page_attribute"]),
        ...(sourcePageNumber === undefined ? {} : { sourcePageNumber })
      }
    },
    annotations,
    expectedText,
    expectedReadingOrder: orderedAnnotations.map((annotation) => annotation.id),
    expectedTableHtml: activeAnnotations.flatMap((annotation) =>
      annotation.html && annotation.category === "table" ? [annotation.html] : []
    ),
    expectedFormulaLatex: activeAnnotations.flatMap((annotation) =>
      annotation.latex && /formula|equation/iu.test(annotation.category) ? [annotation.latex] : []
    ),
    tags: [
      "omnidocbench",
      ...(options.tags ?? []),
      ...stringMetadataValues(pageInfo["page_attribute"])
    ],
    evaluationScope: {
      text: true,
      layout: true,
      tables: true,
      formulas: true,
      readingOrder: true
    }
  };
}

function annotationFromOmniDocBench(
  annotation: JsonRecord,
  index: number,
  includeIgnoredAnnotations = false
): readonly ParserBenchmarkAnnotation[] {
  const category = stringValue(annotation["category_type"]) ?? "unknown";
  const ignored = annotation["ignore"] === true || isOmniDocBenchStructuralNoiseCategory(category);
  if (ignored && !includeIgnoredAnnotations) {
    return [];
  }
  const id = String(integerValue(annotation["anno_id"]) ?? `${category}_${index}`);
  const order = integerValue(annotation["order"]);
  const box = boxFromPoly(annotation["poly"]);
  const text = stringValue(annotation["text"]);
  const latex = stringValue(annotation["latex"]);
  const html = stringValue(annotation["html"]);
  return [
    {
      id,
      category,
      ignored,
      ...(order === undefined ? {} : { order }),
      ...(box === undefined ? {} : { box }),
      ...(text === undefined ? {} : { text }),
      ...(latex === undefined ? {} : { latex }),
      ...(html === undefined ? {} : { html }),
      attributes: metadataRecord(annotation["attribute"])
    }
  ];
}

function isOmniDocBenchStructuralNoiseCategory(category: string): boolean {
  return category === "abandon" || category === "page_number" || /_group$/iu.test(category);
}

function boxFromPoly(value: unknown): ParserBenchmarkBox | undefined {
  if (!Array.isArray(value) || value.length < 8) {
    return undefined;
  }
  const numbers = value.map((entry) => numberValue(entry));
  if (numbers.some((entry) => entry === undefined)) {
    return undefined;
  }
  const coordinates = numbers as number[];
  const xs = [coordinates[0]!, coordinates[2]!, coordinates[4]!, coordinates[6]!];
  const ys = [coordinates[1]!, coordinates[3]!, coordinates[5]!, coordinates[7]!];
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY
  };
}

function compareAnnotationsByOrder(
  first: ParserBenchmarkAnnotation,
  second: ParserBenchmarkAnnotation
): number {
  return (first.order ?? Number.MAX_SAFE_INTEGER) - (second.order ?? Number.MAX_SAFE_INTEGER);
}

function annotationTextForBody(annotation: ParserBenchmarkAnnotation): string {
  return annotation.text ?? annotation.latex ?? textFromHtml(annotation.html ?? "");
}

function textFromHtml(html: string): string {
  return html
    .replace(/<[^>]+>/gu, " ")
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/\s+/gu, " ")
    .trim();
}

function caseId(pageInfo: JsonRecord, imagePath: string | undefined, index: number): string {
  if (imagePath) {
    return path.basename(imagePath).replace(/\.[^.]+$/u, "");
  }
  const pageNumber = integerValue(pageInfo["page_no"]);
  return pageNumber === undefined ? `page_${index + 1}` : `page_${pageNumber}`;
}

function pdfPathForCase(testCase: ParserBenchmarkCase): string {
  if (testCase.page.pdfPath) {
    return testCase.page.pdfPath;
  }
  if (testCase.page.imagePath) {
    return testCase.page.imagePath.replace(/\.[^.]+$/u, ".pdf");
  }
  return `${testCase.id}.pdf`;
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

function metadataRecord(value: unknown): Readonly<Record<string, string | number | boolean>> {
  if (!isRecord(value)) {
    return {};
  }
  const entries = Object.entries(value).flatMap(
    ([key, entry]): [string, string | number | boolean][] =>
      ["string", "number", "boolean"].includes(typeof entry)
        ? [[key, entry as string | number | boolean]]
        : []
  );
  return Object.fromEntries(entries);
}

function stringMetadataValues(value: unknown): readonly string[] {
  if (!isRecord(value)) {
    return [];
  }
  return Object.values(value).flatMap((entry) => (typeof entry === "string" ? [entry] : []));
}

function integerValue(value: unknown): number | undefined {
  const number = numberValue(value);
  return number === undefined ? undefined : Math.trunc(number);
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
