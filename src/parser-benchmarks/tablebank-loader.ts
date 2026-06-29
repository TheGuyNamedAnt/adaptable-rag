import { readFile } from "node:fs/promises";
import path from "node:path";

import type { DocumentParseRequest } from "../parsing/parser.js";
import type { ParserBenchmarkAnnotation, ParserBenchmarkCase } from "./benchmark-types.js";

export interface TableBankLoaderOptions {
  readonly maxCases?: number;
  readonly tags?: readonly string[];
}

export interface TableBankRequestOptions {
  readonly imagesRoot: string;
  readonly requestedAt: string;
}

type JsonRecord = Readonly<Record<string, unknown>>;

interface CocoImage {
  readonly id: string;
  readonly fileName: string;
  readonly width: number;
  readonly height: number;
}

interface CocoAnnotation {
  readonly id: string;
  readonly imageId: string;
  readonly bbox: readonly [number, number, number, number];
  readonly categoryName: string;
  readonly ignored: boolean;
  readonly text?: string;
  readonly html?: string;
}

export async function loadTableBankCasesFromFile(
  filePath: string,
  options: TableBankLoaderOptions = {}
): Promise<readonly ParserBenchmarkCase[]> {
  const json = JSON.parse(await readFile(filePath, "utf8"));
  return loadTableBankCases(json, options);
}

export function loadTableBankCases(
  value: unknown,
  options: TableBankLoaderOptions = {}
): readonly ParserBenchmarkCase[] {
  if (!isRecord(value)) {
    throw new Error("TableBank annotations must be a COCO-style JSON object.");
  }
  const images = imagesFromCoco(value);
  const categories = categoriesFromCoco(value);
  const annotations = annotationsFromCoco(value, categories);
  const annotationsByImageId = groupByImageId(annotations);
  const cases: ParserBenchmarkCase[] = [];

  for (const image of images) {
    const imageAnnotations = annotationsByImageId.get(image.id) ?? [];
    if (imageAnnotations.length === 0) {
      continue;
    }
    cases.push(tableBankCaseFromImage(image, imageAnnotations, options));
    if (options.maxCases !== undefined && cases.length >= options.maxCases) {
      break;
    }
  }

  return cases;
}

export async function createTableBankParseRequest(
  testCase: ParserBenchmarkCase,
  options: TableBankRequestOptions
): Promise<DocumentParseRequest> {
  const imagePath = testCase.page.imagePath;
  if (!imagePath) {
    throw new Error(`TableBank case "${testCase.id}" has no image path.`);
  }
  const resolvedPath = resolveBenchmarkAssetPath(options.imagesRoot, imagePath);
  return {
    sourceId: testCase.sourceId,
    sourceKind: "uploaded_file",
    title: testCase.title,
    contentType: contentTypeForImagePath(resolvedPath),
    bytes: await readFile(resolvedPath),
    path: resolvedPath,
    requestedAt: options.requestedAt,
    metadata: {
      benchmarkDataset: testCase.dataset,
      benchmarkCaseId: testCase.id,
      tableCount: testCase.annotations.length
    }
  };
}

function tableBankCaseFromImage(
  image: CocoImage,
  annotations: readonly CocoAnnotation[],
  options: TableBankLoaderOptions
): ParserBenchmarkCase {
  const benchmarkAnnotations = annotations.map(
    (annotation): ParserBenchmarkAnnotation => ({
      id: annotation.id,
      category: annotation.categoryName || "table",
      ignored: annotation.ignored,
      box: {
        x: annotation.bbox[0],
        y: annotation.bbox[1],
        width: annotation.bbox[2],
        height: annotation.bbox[3]
      },
      ...(annotation.text === undefined ? {} : { text: annotation.text }),
      ...(annotation.html === undefined ? {} : { html: annotation.html })
    })
  );
  const id = path.basename(image.fileName).replace(/\.[^.]+$/u, "");
  return {
    dataset: "tablebank",
    id,
    title: image.fileName,
    sourceId: `tablebank:${id}`,
    contentType: contentTypeForImagePath(image.fileName),
    page: {
      pageNumber: 1,
      width: image.width,
      height: image.height,
      imagePath: image.fileName
    },
    annotations: benchmarkAnnotations,
    expectedText: "",
    expectedReadingOrder: [],
    expectedTableHtml: benchmarkAnnotations.flatMap((annotation) =>
      annotation.category === "table" && annotation.html !== undefined ? [annotation.html] : []
    ),
    expectedFormulaLatex: [],
    tags: ["tablebank", "table-detection", ...(options.tags ?? [])],
    evaluationScope: {
      text: false,
      layout: true,
      tables: true,
      formulas: false,
      readingOrder: false
    }
  };
}

function imagesFromCoco(value: JsonRecord): readonly CocoImage[] {
  const images = Array.isArray(value["images"]) ? value["images"] : [];
  return images.flatMap((image) => {
    if (!isRecord(image)) {
      return [];
    }
    const id = idValue(image["id"]);
    const fileName = stringValue(image["file_name"]);
    const width = numberValue(image["width"]);
    const height = numberValue(image["height"]);
    if (!id || !fileName || width === undefined || height === undefined) {
      return [];
    }
    return [{ id, fileName, width, height }];
  });
}

function categoriesFromCoco(value: JsonRecord): ReadonlyMap<string, string> {
  const categories = Array.isArray(value["categories"]) ? value["categories"] : [];
  return new Map(
    categories.flatMap((category) => {
      if (!isRecord(category)) {
        return [];
      }
      const id = idValue(category["id"]);
      const name = stringValue(category["name"]);
      return id && name ? [[id, name]] : [];
    })
  );
}

function annotationsFromCoco(
  value: JsonRecord,
  categories: ReadonlyMap<string, string>
): readonly CocoAnnotation[] {
  const annotations = Array.isArray(value["annotations"]) ? value["annotations"] : [];
  return annotations.flatMap((annotation) => {
    if (!isRecord(annotation)) {
      return [];
    }
    const id = idValue(annotation["id"]);
    const imageId = idValue(annotation["image_id"]);
    const categoryId = idValue(annotation["category_id"]);
    const bbox = bboxValue(annotation["bbox"]);
    if (!id || !imageId || !bbox) {
      return [];
    }
    const text = stringValue(annotation["text"]);
    const html = stringValue(annotation["html"]);
    return [
      {
        id,
        imageId,
        bbox,
        categoryName: (categoryId ? categories.get(categoryId) : undefined) ?? "table",
        ignored: annotation["ignore"] === true || annotation["iscrowd"] === 1,
        ...(text === undefined ? {} : { text }),
        ...(html === undefined ? {} : { html })
      }
    ];
  });
}

function groupByImageId(
  annotations: readonly CocoAnnotation[]
): ReadonlyMap<string, readonly CocoAnnotation[]> {
  const grouped = new Map<string, CocoAnnotation[]>();
  for (const annotation of annotations) {
    grouped.set(annotation.imageId, [...(grouped.get(annotation.imageId) ?? []), annotation]);
  }
  return grouped;
}

function bboxValue(value: unknown): readonly [number, number, number, number] | undefined {
  if (!Array.isArray(value) || value.length < 4) {
    return undefined;
  }
  const x = numberValue(value[0]);
  const y = numberValue(value[1]);
  const width = numberValue(value[2]);
  const height = numberValue(value[3]);
  if (x === undefined || y === undefined || width === undefined || height === undefined) {
    return undefined;
  }
  return [x, y, width, height];
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
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
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
