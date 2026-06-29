import type { LayoutRegionKind } from "../documents/layout.js";
import type { DocumentParseResult } from "../parsing/parser.js";
import type {
  ParserBenchmarkAnnotation,
  ParserBenchmarkBox,
  ParserBenchmarkCase,
  ParserBenchmarkCaseEvaluation,
  ParserBenchmarkReport,
  ParserBenchmarkRunResult,
  ParserBenchmarkThresholds
} from "./benchmark-types.js";

const DEFAULT_THRESHOLDS: Required<ParserBenchmarkThresholds> = {
  minimumTextSimilarity: 0.75,
  minimumLayoutRecall: 0.6,
  minimumTableRecall: 0.6,
  minimumFormulaRecall: 0.6,
  minimumReadingOrderScore: 0.7
};
const LARGE_TABLE_TEXT_COVERAGE_THRESHOLD = 0.85;
const FORMULA_TEXT_COVERAGE_THRESHOLD = 0.65;

export function evaluateParserBenchmarkResult(
  testCase: ParserBenchmarkCase,
  parseResult: DocumentParseResult,
  thresholds: ParserBenchmarkThresholds = {}
): ParserBenchmarkCaseEvaluation {
  const normalizedThresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const expectedAnnotations = testCase.annotations.filter(
    (annotation) => !annotation.ignored && annotation.box !== undefined
  );
  const matchedAnnotationCount = expectedAnnotations.filter((annotation) =>
    hasMatchingRegion(annotation, parseResult, testCase.page.pageNumber)
  ).length;
  const expectedTables = expectedAnnotations.filter(
    (annotation) => annotation.category === "table"
  );
  const matchedTableCount = expectedTables.filter((annotation) =>
    hasMatchingTable(annotation, parseResult, testCase.page.pageNumber)
  ).length;
  const expectedFormulas = expectedAnnotations.filter((annotation) =>
    /formula|equation/iu.test(annotation.category)
  );
  const matchedFormulaCount = expectedFormulas.filter((annotation) =>
    hasMatchingFormula(annotation, parseResult, testCase.page.pageNumber)
  ).length;
  const textSimilarity = testCase.evaluationScope.text
    ? benchmarkTextSimilarity(testCase, parseResult.document.body)
    : 1;
  const layoutRecall = testCase.evaluationScope.layout
    ? ratio(matchedAnnotationCount, expectedAnnotations.length)
    : 1;
  const tableRecall = testCase.evaluationScope.tables
    ? ratio(matchedTableCount, expectedTables.length)
    : 1;
  const formulaRecall = testCase.evaluationScope.formulas
    ? ratio(matchedFormulaCount, expectedFormulas.length)
    : 1;
  const readingOrderScore = testCase.evaluationScope.readingOrder
    ? expectedReadingOrderScore(testCase, parseResult)
    : 1;
  const warnings = evaluationWarnings({
    textSimilarity,
    layoutRecall,
    tableRecall,
    formulaRecall,
    readingOrderScore,
    evaluationScope: testCase.evaluationScope,
    thresholds: normalizedThresholds
  });

  return {
    caseId: testCase.id,
    sourceId: testCase.sourceId,
    status: warnings.length === 0 ? "passed" : "failed",
    textSimilarity,
    layoutRecall,
    tableRecall,
    formulaRecall,
    readingOrderScore,
    expectedAnnotationCount: expectedAnnotations.length,
    matchedAnnotationCount,
    expectedTableCount: expectedTables.length,
    matchedTableCount,
    expectedFormulaCount: expectedFormulas.length,
    matchedFormulaCount,
    warnings
  };
}

export function buildParserBenchmarkReport(
  dataset: ParserBenchmarkCase["dataset"],
  results: readonly ParserBenchmarkRunResult[],
  thresholds: ParserBenchmarkThresholds = {}
): ParserBenchmarkReport {
  const cases = results.map((result): ParserBenchmarkCaseEvaluation => {
    if (!result.parseResult) {
      return failedEvaluation(
        result.testCase,
        result.errorMessage ?? "Parser did not return a result."
      );
    }
    return evaluateParserBenchmarkResult(result.testCase, result.parseResult, thresholds);
  });
  const passedCount = cases.filter((testCase) => testCase.status === "passed").length;
  return {
    dataset,
    status: cases.length > 0 && passedCount === cases.length ? "passed" : "failed",
    caseCount: cases.length,
    passedCount,
    failedCount: cases.length - passedCount,
    averageTextSimilarity: average(cases.map((testCase) => testCase.textSimilarity)),
    averageLayoutRecall: average(cases.map((testCase) => testCase.layoutRecall)),
    averageTableRecall: average(cases.map((testCase) => testCase.tableRecall)),
    averageFormulaRecall: average(cases.map((testCase) => testCase.formulaRecall)),
    averageReadingOrderScore: average(cases.map((testCase) => testCase.readingOrderScore)),
    cases
  };
}

function failedEvaluation(
  testCase: ParserBenchmarkCase,
  warning: string
): ParserBenchmarkCaseEvaluation {
  const expectedAnnotations = testCase.annotations.filter((annotation) => !annotation.ignored);
  const expectedTableCount = expectedAnnotations.filter(
    (annotation) => annotation.category === "table"
  ).length;
  const expectedFormulaCount = expectedAnnotations.filter((annotation) =>
    /formula|equation/iu.test(annotation.category)
  ).length;

  return {
    caseId: testCase.id,
    sourceId: testCase.sourceId,
    status: "failed",
    textSimilarity: 0,
    layoutRecall: 0,
    tableRecall: expectedTableCount === 0 ? 1 : 0,
    formulaRecall: expectedFormulaCount === 0 ? 1 : 0,
    readingOrderScore: 0,
    expectedAnnotationCount: expectedAnnotations.length,
    matchedAnnotationCount: 0,
    expectedTableCount,
    matchedTableCount: 0,
    expectedFormulaCount,
    matchedFormulaCount: 0,
    warnings: [warning]
  };
}

function benchmarkTextSimilarity(testCase: ParserBenchmarkCase, actualBody: string): number {
  const expectedText = expectedTextForTextSimilarity(testCase);
  return Math.max(
    normalizedEditSimilarity(expectedText, actualBody),
    tokenRecallSimilarity(expectedText, actualBody)
  );
}

function expectedTextForTextSimilarity(testCase: ParserBenchmarkCase): string {
  const proseText = testCase.annotations
    .filter(
      (annotation) => !annotation.ignored && shouldIncludeAnnotationInTextSimilarity(annotation)
    )
    .map((annotation) => annotation.text ?? textFromHtml(annotation.html ?? ""))
    .filter((text) => text.trim().length > 0)
    .join("\n");
  return proseText.trim() ? proseText : testCase.expectedText;
}

function shouldIncludeAnnotationInTextSimilarity(annotation: ParserBenchmarkAnnotation): boolean {
  if (annotation.category === "table" || annotation.category === "figure") {
    return false;
  }
  return !/formula|equation/iu.test(annotation.category);
}

function hasMatchingRegion(
  annotation: ParserBenchmarkAnnotation,
  parseResult: DocumentParseResult,
  pageNumber: number,
  forcedKind?: LayoutRegionKind
): boolean {
  return matchingLayoutRegions(annotation, parseResult, pageNumber, forcedKind).length > 0;
}

function matchingLayoutRegions(
  annotation: ParserBenchmarkAnnotation,
  parseResult: DocumentParseResult,
  pageNumber: number,
  forcedKind?: LayoutRegionKind
): NonNullable<DocumentParseResult["document"]["layout"]>["regions"] {
  const expectedBox = annotation.box;
  if (!expectedBox || !parseResult.document.layout) {
    return [];
  }
  const expectedKind = forcedKind ?? benchmarkCategoryToRegionKind(annotation.category);
  return parseResult.document.layout.regions.filter((region) => {
    if (!region.box || region.pageNumber !== pageNumber) {
      return false;
    }
    if (expectedKind !== "unknown" && !regionKindMatches(expectedKind, region.kind)) {
      return false;
    }
    return boxesMatch(expectedBox, region.box);
  });
}

function hasMatchingTable(
  annotation: ParserBenchmarkAnnotation,
  parseResult: DocumentParseResult,
  pageNumber: number
): boolean {
  if (hasMatchingRegion(annotation, parseResult, pageNumber, "table")) {
    return true;
  }
  const expectedTokens = tableComparableTokens(annotation.html ?? annotation.text ?? "");
  if (expectedTokens.length === 0 || !parseResult.document.layout?.tables?.length) {
    return false;
  }
  return parseResult.document.layout.tables.some((table) => {
    if (table.pageNumber !== pageNumber) {
      return false;
    }
    const tableText = normalizeText(
      [
        table.summary ?? "",
        ...table.cells.flatMap((cell) => (cell.text === undefined ? [] : [cell.text]))
      ].join(" ")
    );
    const tableTokens = new Set(tableComparableTokens(tableText));
    const matchedTokens = expectedTokens.filter((token) => tableTokens.has(token)).length;
    const requiredCoverage = expectedTokens.length <= 5 ? 1 : LARGE_TABLE_TEXT_COVERAGE_THRESHOLD;
    return ratio(matchedTokens, expectedTokens.length) >= requiredCoverage;
  });
}

function hasMatchingFormula(
  annotation: ParserBenchmarkAnnotation,
  parseResult: DocumentParseResult,
  pageNumber: number
): boolean {
  const needle = normalizeText(annotation.latex ?? annotation.text ?? "");
  if (!needle) {
    return hasMatchingRegion(annotation, parseResult, pageNumber, "equation");
  }
  const bodyText = normalizeText(parseResult.document.body);
  if (bodyText.includes(needle)) {
    return true;
  }

  const expectedTokens = formulaComparableTokens(needle);
  if (expectedTokens.length === 0) {
    return false;
  }
  const equationRegionTexts =
    parseResult.document.layout?.regions
      .filter((region) => region.pageNumber === pageNumber && region.kind === "equation")
      .flatMap((region) => (region.text === undefined ? [] : [region.text])) ?? [];
  const candidateTexts = [...equationRegionTexts, parseResult.document.body];
  if (
    candidateTexts.some((candidateText) => {
      const candidateTokens = new Set(formulaComparableTokens(candidateText));
      const matchedTokens = expectedTokens.filter((token) => candidateTokens.has(token)).length;
      return ratio(matchedTokens, expectedTokens.length) >= FORMULA_TEXT_COVERAGE_THRESHOLD;
    })
  ) {
    return true;
  }
  return hasMatchingRegion(annotation, parseResult, pageNumber, "equation");
}

function expectedReadingOrderScore(
  testCase: ParserBenchmarkCase,
  parseResult: DocumentParseResult
): number {
  const positions = testCase.expectedReadingOrder
    .map((id) => testCase.annotations.find((annotation) => annotation.id === id))
    .filter((annotation): annotation is ParserBenchmarkAnnotation => annotation !== undefined)
    .map((annotation) => expectedReadingOrderPosition(testCase, annotation, parseResult));
  if (positions.length < 2) {
    return 1;
  }
  const foundPositions = positions.filter((position) => position >= 0);
  if (foundPositions.length < 2) {
    return 0;
  }
  let orderedPairs = 0;
  let comparablePairs = 0;
  for (let firstIndex = 0; firstIndex < positions.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < positions.length; secondIndex += 1) {
      const first = positions[firstIndex]!;
      const second = positions[secondIndex]!;
      if (first < 0 || second < 0) {
        continue;
      }
      comparablePairs += 1;
      if (first <= second) {
        orderedPairs += 1;
      }
    }
  }
  return ratio(orderedPairs, comparablePairs);
}

function expectedReadingOrderPosition(
  testCase: ParserBenchmarkCase,
  annotation: ParserBenchmarkAnnotation,
  parseResult: DocumentParseResult
): number {
  const matchingRegionPositions = matchingLayoutRegions(
    annotation,
    parseResult,
    testCase.page.pageNumber
  )
    .map((region) => region.characterStart)
    .filter((position): position is number => position !== undefined);
  if (matchingRegionPositions.length > 0) {
    return Math.min(...matchingRegionPositions);
  }

  const snippet = benchmarkComparableText(
    annotation.text ?? annotation.latex ?? textFromHtml(annotation.html ?? "")
  );
  if (snippet.length < 3) {
    return -1;
  }
  return benchmarkComparableText(parseResult.document.body).indexOf(snippet);
}

function evaluationWarnings(input: {
  readonly textSimilarity: number;
  readonly layoutRecall: number;
  readonly tableRecall: number;
  readonly formulaRecall: number;
  readonly readingOrderScore: number;
  readonly evaluationScope: ParserBenchmarkCase["evaluationScope"];
  readonly thresholds: Required<ParserBenchmarkThresholds>;
}): readonly string[] {
  const warnings: string[] = [];
  if (input.evaluationScope.text && input.textSimilarity < input.thresholds.minimumTextSimilarity) {
    warnings.push(
      `Text similarity ${input.textSimilarity} below ${input.thresholds.minimumTextSimilarity}.`
    );
  }
  if (input.evaluationScope.layout && input.layoutRecall < input.thresholds.minimumLayoutRecall) {
    warnings.push(
      `Layout recall ${input.layoutRecall} below ${input.thresholds.minimumLayoutRecall}.`
    );
  }
  if (input.evaluationScope.tables && input.tableRecall < input.thresholds.minimumTableRecall) {
    warnings.push(
      `Table recall ${input.tableRecall} below ${input.thresholds.minimumTableRecall}.`
    );
  }
  if (
    input.evaluationScope.formulas &&
    input.formulaRecall < input.thresholds.minimumFormulaRecall
  ) {
    warnings.push(
      `Formula recall ${input.formulaRecall} below ${input.thresholds.minimumFormulaRecall}.`
    );
  }
  if (
    input.evaluationScope.readingOrder &&
    input.readingOrderScore < input.thresholds.minimumReadingOrderScore
  ) {
    warnings.push(
      `Reading order score ${input.readingOrderScore} below ${input.thresholds.minimumReadingOrderScore}.`
    );
  }
  return warnings;
}

function benchmarkCategoryToRegionKind(category: string): LayoutRegionKind {
  if (/figure_caption|figure_footnote/iu.test(category)) {
    return "figure_caption";
  }
  if (/table_caption|table_footnote/iu.test(category)) {
    return "table_caption";
  }
  if (/title/iu.test(category)) {
    return "title";
  }
  if (/table/iu.test(category)) {
    return "table";
  }
  if (/figure|image/iu.test(category)) {
    return "figure";
  }
  if (/formula|equation/iu.test(category)) {
    return "equation";
  }
  if (/header/iu.test(category)) {
    return "header";
  }
  if (/footer/iu.test(category)) {
    return "footer";
  }
  if (/list/iu.test(category)) {
    return "list";
  }
  if (/text|paragraph/iu.test(category)) {
    return "paragraph";
  }
  return "unknown";
}

function regionKindMatches(expectedKind: LayoutRegionKind, actualKind: LayoutRegionKind): boolean {
  if (expectedKind === actualKind) {
    return true;
  }
  if (expectedKind === "title" && actualKind === "heading") {
    return true;
  }
  if (expectedKind === "heading" && actualKind === "title") {
    return true;
  }
  if (expectedKind === "paragraph" && actualKind === "list") {
    return true;
  }
  if (expectedKind === "header" && ["heading", "paragraph", "title"].includes(actualKind)) {
    return true;
  }
  if (expectedKind === "table_caption" && actualKind === "paragraph") {
    return true;
  }
  if (expectedKind === "figure_caption" && actualKind === "paragraph") {
    return true;
  }
  return false;
}

function boxesMatch(expectedBox: ParserBenchmarkBox, actualBox: ParserBenchmarkBox): boolean {
  if (boxIou(expectedBox, actualBox) >= 0.5) {
    return true;
  }
  return boxCoverage(expectedBox, actualBox) >= 0.75 && boxAreaRatio(actualBox, expectedBox) <= 8;
}

function boxIou(first: ParserBenchmarkBox, second: ParserBenchmarkBox): number {
  const left = Math.max(first.x, second.x);
  const top = Math.max(first.y, second.y);
  const right = Math.min(first.x + first.width, second.x + second.width);
  const bottom = Math.min(first.y + first.height, second.y + second.height);
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
  const union = first.width * first.height + second.width * second.height - intersection;
  return union <= 0 ? 0 : intersection / union;
}

function boxCoverage(expected: ParserBenchmarkBox, actual: ParserBenchmarkBox): number {
  const left = Math.max(expected.x, actual.x);
  const top = Math.max(expected.y, actual.y);
  const right = Math.min(expected.x + expected.width, actual.x + actual.width);
  const bottom = Math.min(expected.y + expected.height, actual.y + actual.height);
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
  const expectedArea = expected.width * expected.height;
  return expectedArea <= 0 ? 0 : intersection / expectedArea;
}

function boxAreaRatio(first: ParserBenchmarkBox, second: ParserBenchmarkBox): number {
  const firstArea = first.width * first.height;
  const secondArea = second.width * second.height;
  return secondArea <= 0 ? Number.POSITIVE_INFINITY : firstArea / secondArea;
}

function normalizedEditSimilarity(expected: string, actual: string): number {
  const expectedText = benchmarkComparableText(expected);
  const actualText = benchmarkComparableText(actual);
  if (!expectedText && !actualText) {
    return 1;
  }
  if (!expectedText || !actualText) {
    return 0;
  }
  const distance = levenshteinDistance(expectedText, actualText);
  return roundScore(1 - distance / Math.max(expectedText.length, actualText.length));
}

function tokenRecallSimilarity(expected: string, actual: string): number {
  const expectedTokens = comparableTokens(expected);
  if (expectedTokens.length === 0) {
    return benchmarkComparableText(actual) ? 0 : 1;
  }
  const actualTokenCounts = new Map<string, number>();
  for (const token of comparableTokens(actual)) {
    actualTokenCounts.set(token, (actualTokenCounts.get(token) ?? 0) + 1);
  }
  let matchedTokens = 0;
  for (const token of expectedTokens) {
    const remaining = actualTokenCounts.get(token) ?? 0;
    if (remaining <= 0) {
      continue;
    }
    matchedTokens += 1;
    actualTokenCounts.set(token, remaining - 1);
  }
  return ratio(matchedTokens, expectedTokens.length);
}

function comparableTokens(value: string): readonly string[] {
  return benchmarkComparableText(value)
    .split(" ")
    .filter((token) => token.length > 1);
}

function levenshteinDistance(first: string, second: string): number {
  const previous = Array.from({ length: second.length + 1 }, (_unused, index) => index);
  const current = Array.from({ length: second.length + 1 }, () => 0);
  for (let firstIndex = 1; firstIndex <= first.length; firstIndex += 1) {
    current[0] = firstIndex;
    for (let secondIndex = 1; secondIndex <= second.length; secondIndex += 1) {
      const substitutionCost = first[firstIndex - 1] === second[secondIndex - 1] ? 0 : 1;
      current[secondIndex] = Math.min(
        previous[secondIndex]! + 1,
        current[secondIndex - 1]! + 1,
        previous[secondIndex - 1]! + substitutionCost
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[second.length]!;
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/gu, " ").trim();
}

function normalizeHtmlText(value: string): string {
  return normalizeText(
    value
      .replace(/<[^>]+>/gu, " ")
      .replace(/&nbsp;/giu, " ")
      .replace(/&amp;/giu, "&")
  );
}

function textFromHtml(value: string): string {
  return value
    .replace(/<[^>]+>/gu, " ")
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/\s+/gu, " ")
    .trim();
}

function benchmarkComparableText(value: string): string {
  return normalizeText(value)
    .replace(/(\p{L})-\s+(\p{L})/gu, "$1$2")
    .replace(/ν/gu, "v")
    .replace(/≤/gu, " le ")
    .replace(/≥/gu, " ge ")
    .replace(/[·×]/gu, " ")
    .replace(/\\pmod/giu, " mod ")
    .replace(/\\cdot/giu, " ")
    .replace(/\\leq/giu, " le ")
    .replace(/\\geq/giu, " ge ")
    .replace(/\\prime/giu, " prime ")
    .replace(/\\(?:left|right|quad|qquad|mathrm|text|tag|begin|end)/giu, " ")
    .replace(/[{}$]/gu, " ")
    .replace(/[_^]/gu, " ")
    .replace(/[^\p{L}\p{N}.]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function tableComparableTokens(value: string): readonly string[] {
  const normalized = normalizeHtmlText(value)
    .replace(/ν/gu, "v")
    .replace(/\\(?:nu|upsilon)/giu, "v")
    .replace(/\\[a-z]+/giu, " ")
    .replace(/[{}$]/gu, "")
    .replace(/[_^]/gu, "")
    .replace(/[|()]/gu, " ")
    .replace(/-{2,}/gu, " ")
    .replace(/[^\p{L}\p{N}.]+/gu, " ")
    .trim();
  return [...new Set(normalized.split(" ").filter((token) => token.length > 0))];
}

function formulaComparableTokens(value: string): readonly string[] {
  const normalized = normalizeText(value)
    .replace(/ν/gu, "v")
    .replace(/≤/gu, " le ")
    .replace(/≥/gu, " ge ")
    .replace(/[·×]/gu, " ")
    .replace(/\\pmod/giu, " mod ")
    .replace(/\\cdot/giu, " ")
    .replace(/\\leq/giu, " le ")
    .replace(/\\geq/giu, " ge ")
    .replace(/\\succeq/giu, " ge ")
    .replace(/\\[a-z]+/giu, " ")
    .replace(/\\(?:left|right|quad|qquad|mathrm|text|tag|begin|end)/giu, " ")
    .replace(/[{}$]/gu, " ")
    .replace(/[_^]/gu, " ")
    .replace(/[^\p{L}\p{N}.]+/gu, " ")
    .trim();
  const rawTokens = normalized.split(" ").filter((token) => token.length > 0);
  const tokens = new Set<string>();
  for (const token of rawTokens) {
    tokens.add(token);
    for (const part of token.match(/\p{L}+|\p{N}+(?:\.\p{N}+)?/gu) ?? []) {
      tokens.add(part);
    }
  }
  return [...tokens];
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : roundScore(numerator / denominator);
}

function average(values: readonly number[]): number {
  return values.length === 0
    ? 0
    : roundScore(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function roundScore(value: number): number {
  return Math.max(0, Math.min(1, Math.round(value * 1000) / 1000));
}
