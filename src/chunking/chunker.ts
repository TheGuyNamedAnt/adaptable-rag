import type { RagChunk, ChunkSafetyFlag } from "../documents/chunk.js";
import type { RagDocument } from "../documents/document.js";
import type { DocumentLayout, LayoutBox } from "../documents/layout.js";
import { DEFAULT_CHUNKING_POLICY, type ChunkingPolicy } from "./chunk-policy.js";
import { hashText } from "./hash.js";

export interface ChunkDocumentRequest {
  readonly document: RagDocument;
  readonly policy?: ChunkingPolicy;
}

export interface ChunkingWarning {
  readonly documentId: string;
  readonly code: string;
  readonly message: string;
}

export interface ChunkDocumentResult {
  readonly documentId: string;
  readonly chunks: readonly RagChunk[];
  readonly warnings: readonly ChunkingWarning[];
}

interface TextWindow {
  readonly text: string;
  readonly characterStart: number;
  readonly characterEnd: number;
  readonly isProtected?: boolean;
}

interface TextSegment {
  readonly text: string;
  readonly characterStart: number;
  readonly characterEnd: number;
}

interface ProtectedRange {
  readonly characterStart: number;
  readonly characterEnd: number;
}

interface LayoutEvidence {
  readonly layoutRegionIds: readonly string[];
  readonly boundingBoxes: readonly LayoutBox[];
  readonly pageNumber?: number;
}

export class ChunkingPolicyError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid chunking policy:\n${issues.join("\n")}`);
    this.name = "ChunkingPolicyError";
    this.issues = issues;
  }
}

export function chunkDocument(request: ChunkDocumentRequest): ChunkDocumentResult {
  const policy = request.policy ?? DEFAULT_CHUNKING_POLICY;
  assertValidChunkingPolicy(policy);

  const document = request.document;
  const body = document.body;

  if (!body.trim()) {
    return {
      documentId: document.id,
      chunks: [],
      warnings: [
        {
          documentId: document.id,
          code: "empty_document",
          message: "Document body is empty after normalization."
        }
      ]
    };
  }

  const windows = normalizeTextWindows(body, createTextWindows(document, policy), policy);
  if (windows.length > policy.maxChunksPerDocument) {
    throw new ChunkingPolicyError([
      `Document "${document.id}" would create ${windows.length} chunks, exceeding maxChunksPerDocument=${policy.maxChunksPerDocument}.`
    ]);
  }

  const chunks: RagChunk[] = [];

  for (const [index, window] of windows.entries()) {
    const textHash = hashText(window.text);
    const id = buildChunkId(document.id, index, textHash);
    const locator = buildLocator(body, window, policy);
    const safetyFlags = detectSafetyFlags(window.text, policy);
    const layoutEvidence = layoutEvidenceForWindow(document.layout, window);

    chunks.push({
      id,
      documentId: document.id,
      namespaceId: document.namespaceId,
      text: window.text,
      index,
      textHash,
      characterStart: window.characterStart,
      characterEnd: window.characterEnd,
      tokenEstimate: estimateTokens(window.text),
      ...(layoutEvidence.layoutRegionIds.length > 0
        ? { layoutRegionIds: layoutEvidence.layoutRegionIds }
        : {}),
      ...(layoutEvidence.boundingBoxes.length > 0
        ? { boundingBoxes: layoutEvidence.boundingBoxes }
        : {}),
      safetyFlags,
      provenance: document.provenance,
      citation: {
        sourceId: document.provenance.sourceId,
        chunkId: id,
        title: document.title,
        locator,
        ...(layoutEvidence.pageNumber !== undefined
          ? { pageNumber: layoutEvidence.pageNumber }
          : {}),
        ...(layoutEvidence.boundingBoxes.length > 0
          ? { boundingBoxes: layoutEvidence.boundingBoxes }
          : {}),
        ...(layoutEvidence.layoutRegionIds.length > 0
          ? { layoutRegionIds: layoutEvidence.layoutRegionIds }
          : {})
      },
      accessScope: document.accessScope,
      metadata: {
        ...(document.metadata ?? {}),
        chunkingPolicyId: policy.id,
        ...(policy.version === undefined ? {} : { chunkingPolicyVersion: policy.version }),
        chunkerVersion: "1"
      }
    });
  }

  return {
    documentId: document.id,
    chunks,
    warnings: []
  };
}

export function chunkDocuments(
  documents: readonly RagDocument[],
  policy: ChunkingPolicy = DEFAULT_CHUNKING_POLICY
): readonly RagChunk[] {
  return documents.flatMap((document) => chunkDocument({ document, policy }).chunks);
}

function layoutEvidenceForWindow(
  layout: DocumentLayout | undefined,
  window: TextWindow
): LayoutEvidence {
  if (!layout) {
    return {
      layoutRegionIds: [],
      boundingBoxes: []
    };
  }

  const layoutRegionIds: string[] = [];
  const boundingBoxes: LayoutBox[] = [];
  let pageNumber: number | undefined;
  const regionsById = new Map(layout.regions.map((region) => [region.id, region]));

  for (const region of layout.regions) {
    if (!regionOverlapsWindow(region.characterStart, region.characterEnd, window)) {
      continue;
    }

    addRegionEvidence(region.id, regionsById, layoutRegionIds, boundingBoxes);
    pageNumber ??= region.pageNumber;

    pageNumber ??= region.box?.pageNumber;
  }

  for (const relatedRegionId of relatedLayoutRegionIds(layout, layoutRegionIds)) {
    addRegionEvidence(relatedRegionId, regionsById, layoutRegionIds, boundingBoxes);
  }
  const orderedLayoutRegionIds = orderLayoutRegionIds(layout, layoutRegionIds);
  const orderedBoundingBoxes = orderedLayoutRegionIds.flatMap((regionId) => {
    const box = regionsById.get(regionId)?.box;
    return box ? [box] : [];
  });

  return {
    layoutRegionIds: orderedLayoutRegionIds,
    boundingBoxes: orderedBoundingBoxes,
    ...(pageNumber !== undefined ? { pageNumber } : {})
  };
}

function relatedLayoutRegionIds(
  layout: DocumentLayout,
  seedRegionIds: readonly string[]
): readonly string[] {
  const seen = new Set(seedRegionIds);
  const queue = [...seedRegionIds];
  const related: string[] = [];

  while (queue.length > 0 && seen.size < 100) {
    const current = queue.shift();
    if (!current) {
      continue;
    }

    for (const relation of layout.relations ?? []) {
      const neighbor =
        relation.fromRegionId === current
          ? relation.toRegionId
          : relation.toRegionId === current
            ? relation.fromRegionId
            : undefined;
      if (neighbor === undefined || seen.has(neighbor)) {
        continue;
      }

      seen.add(neighbor);
      related.push(neighbor);
      queue.push(neighbor);
    }
  }

  return related;
}

function addRegionEvidence(
  regionId: string,
  regionsById: ReadonlyMap<string, DocumentLayout["regions"][number]>,
  layoutRegionIds: string[],
  boundingBoxes: LayoutBox[]
): void {
  if (layoutRegionIds.includes(regionId)) {
    return;
  }

  const region = regionsById.get(regionId);
  if (!region) {
    return;
  }

  layoutRegionIds.push(region.id);
  if (region.box) {
    boundingBoxes.push(region.box);
  }
}

function orderLayoutRegionIds(
  layout: DocumentLayout,
  layoutRegionIds: readonly string[]
): readonly string[] {
  const selected = new Set(layoutRegionIds);
  return layout.regions.filter((region) => selected.has(region.id)).map((region) => region.id);
}

function regionOverlapsWindow(
  characterStart: number | undefined,
  characterEnd: number | undefined,
  window: TextWindow
): boolean {
  if (characterStart === undefined || characterEnd === undefined) {
    return false;
  }

  return characterStart < window.characterEnd && characterEnd > window.characterStart;
}

function createTextWindows(document: RagDocument, policy: ChunkingPolicy): readonly TextWindow[] {
  const body = document.body;
  const protectedRanges =
    policy.preserveStructuredLayoutRegions === true ? protectedRangesForLayout(document) : [];
  if (protectedRanges.length > 0) {
    return windowsWithProtectedRanges(body, policy, protectedRanges);
  }

  if (body.length <= policy.maxCharacters) {
    return makeWindow(body, 0, body.length, policy);
  }

  if (policy.boundaryStrategy === "line") {
    return windowsFromSeparator(body, "\n", policy);
  }

  if (policy.boundaryStrategy === "paragraph") {
    return windowsFromSeparator(body, "\n\n", policy);
  }

  return characterWindows(body, policy);
}

function protectedRangesForLayout(document: RagDocument): readonly ProtectedRange[] {
  const layout = document.layout;
  if (!layout) {
    return [];
  }

  return mergeProtectedRanges(
    layout.regions
      .filter((region) =>
        ["table", "table_caption", "figure", "figure_caption", "equation"].includes(region.kind)
      )
      .flatMap((region) =>
        region.characterStart === undefined || region.characterEnd === undefined
          ? []
          : [
              {
                characterStart: region.characterStart,
                characterEnd: region.characterEnd
              }
            ]
      )
  );
}

function windowsWithProtectedRanges(
  body: string,
  policy: ChunkingPolicy,
  protectedRanges: readonly ProtectedRange[]
): readonly TextWindow[] {
  const windows: TextWindow[] = [];
  let cursor = 0;

  for (const range of protectedRanges) {
    if (cursor < range.characterStart) {
      windows.push(
        ...createUnprotectedTextWindows(body.slice(cursor, range.characterStart), policy, cursor)
      );
    }
    windows.push(...protectedTextWindows(body, range, policy));
    cursor = range.characterEnd;
  }

  if (cursor < body.length) {
    windows.push(...createUnprotectedTextWindows(body.slice(cursor), policy, cursor));
  }

  return windows;
}

function protectedTextWindows(
  body: string,
  range: ProtectedRange,
  policy: ChunkingPolicy
): readonly TextWindow[] {
  if (range.characterEnd - range.characterStart <= policy.maxCharacters) {
    return makeWindow(body, range.characterStart, range.characterEnd, policy, 0, true);
  }

  return createUnprotectedTextWindows(
    body.slice(range.characterStart, range.characterEnd),
    policy,
    range.characterStart
  ).map((window) => ({ ...window, isProtected: true }));
}

function createUnprotectedTextWindows(
  body: string,
  policy: ChunkingPolicy,
  offset: number
): readonly TextWindow[] {
  const windows =
    body.length <= policy.maxCharacters
      ? makeWindow(body, 0, body.length, policy, offset)
      : policy.boundaryStrategy === "line"
        ? windowsFromSeparator(body, "\n", policy).map(offsetWindow(offset))
        : policy.boundaryStrategy === "paragraph"
          ? windowsFromSeparator(body, "\n\n", policy).map(offsetWindow(offset))
          : characterWindows(body, policy, offset);
  return windows;
}

function offsetWindow(offset: number): (window: TextWindow) => TextWindow {
  return (window) => ({
    ...window,
    characterStart: window.characterStart + offset,
    characterEnd: window.characterEnd + offset
  });
}

function mergeProtectedRanges(ranges: readonly ProtectedRange[]): readonly ProtectedRange[] {
  const sorted = [...ranges]
    .filter((range) => range.characterStart >= 0 && range.characterEnd > range.characterStart)
    .sort((first, second) => first.characterStart - second.characterStart);
  const merged: ProtectedRange[] = [];

  for (const range of sorted) {
    const previous = merged[merged.length - 1];
    if (!previous || range.characterStart > previous.characterEnd) {
      merged.push(range);
      continue;
    }
    merged[merged.length - 1] = {
      characterStart: previous.characterStart,
      characterEnd: Math.max(previous.characterEnd, range.characterEnd)
    };
  }

  return merged;
}

function windowsFromSeparator(
  body: string,
  separator: string,
  policy: ChunkingPolicy
): readonly TextWindow[] {
  const windows: TextWindow[] = [];
  let currentStart = -1;
  let currentEnd = 0;

  for (const segment of splitWithPositions(body, separator)) {
    if (currentStart === -1) {
      currentStart = segment.characterStart;
      currentEnd = segment.characterEnd;
      continue;
    }

    const candidateEnd = segment.characterEnd;
    const candidateLength = candidateEnd - currentStart;

    if (
      candidateLength > policy.maxCharacters &&
      currentEnd - currentStart >= policy.minCharacters
    ) {
      const flushEnd = segment.characterStart;
      windows.push(...makeWindow(body, currentStart, flushEnd, policy));
      const overlapStart = Math.max(currentStart, flushEnd - policy.overlapCharacters);
      currentStart = policy.overlapCharacters > 0 ? overlapStart : segment.characterStart;
      currentEnd = candidateEnd;
    } else {
      currentEnd = candidateEnd;
    }
  }

  if (currentStart !== -1) {
    windows.push(...makeWindow(body, currentStart, currentEnd, policy));
  }

  return windows.flatMap((window) =>
    window.text.length > policy.maxCharacters
      ? characterWindows(window.text, policy, window.characterStart)
      : [window]
  );
}

function splitWithPositions(body: string, separator: string): readonly TextSegment[] {
  const segments: TextSegment[] = [];
  let start = 0;

  while (start <= body.length) {
    const separatorIndex = body.indexOf(separator, start);
    const end = separatorIndex === -1 ? body.length : separatorIndex;

    segments.push({
      text: body.slice(start, end),
      characterStart: start,
      characterEnd: end
    });

    if (separatorIndex === -1) {
      break;
    }

    start = separatorIndex + separator.length;
  }

  return segments;
}

function characterWindows(body: string, policy: ChunkingPolicy, offset = 0): readonly TextWindow[] {
  const windows: TextWindow[] = [];
  const step = Math.max(1, policy.maxCharacters - policy.overlapCharacters);

  for (let start = 0; start < body.length; start += step) {
    const end = Math.min(body.length, start + policy.maxCharacters);
    windows.push(...makeWindow(body, start, end, policy, offset));

    if (end >= body.length) {
      break;
    }
  }

  return windows;
}

function makeWindow(
  body: string,
  characterStart: number,
  characterEnd: number,
  policy: ChunkingPolicy,
  offset = 0,
  isProtected = false
): readonly TextWindow[] {
  let start = characterStart;
  let end = characterEnd;

  if (!policy.preserveWhitespace) {
    while (start < end && /\s/.test(body[start] ?? "")) {
      start += 1;
    }

    while (end > start && /\s/.test(body[end - 1] ?? "")) {
      end -= 1;
    }
  }

  const text = body.slice(start, end);
  if (!text.trim()) {
    return [];
  }

  return [
    {
      text,
      characterStart: offset + start,
      characterEnd: offset + end,
      ...(isProtected ? { isProtected: true } : {})
    }
  ];
}

function normalizeTextWindows(
  body: string,
  windows: readonly TextWindow[],
  policy: ChunkingPolicy
): readonly TextWindow[] {
  return mergeSmallWindows(
    body,
    windows.filter((window) => !shouldDropLowInformationWindow(window, policy)),
    policy
  );
}

function shouldDropLowInformationWindow(window: TextWindow, policy: ChunkingPolicy): boolean {
  const text = window.text.trim();
  return text.length < policy.minCharacters && isLikelyDocumentFurniture(text);
}

function isLikelyDocumentFurniture(text: string): boolean {
  const normalized = text
    .replace(/[ \t\f\v]+/gu, " ")
    .replace(/\n+/gu, " ")
    .trim();

  if (!normalized) {
    return true;
  }

  if (/^[\d\s.()-]+$/u.test(normalized)) {
    return true;
  }

  if (/^[_\-=\s]{3,}$/u.test(normalized)) {
    return true;
  }

  if (/^page\s+\d+(?:\s+of\s+\d+)?$/iu.test(normalized)) {
    return true;
  }

  if (/^\d+\.?\s+table of contents(?:\s*\|.*)?$/iu.test(normalized)) {
    return true;
  }

  if (/^\d+\s+part\s+[ivxlcdm]+\s+item\s+\d+[a-z]?$/iu.test(normalized)) {
    return true;
  }

  return false;
}

function mergeSmallWindows(
  body: string,
  windows: readonly TextWindow[],
  policy: ChunkingPolicy
): readonly TextWindow[] {
  const result: TextWindow[] = [];
  const pending = [...windows];

  for (let index = 0; index < pending.length; index += 1) {
    const window = pending[index];
    if (!window) {
      continue;
    }

    if (window.text.trim().length >= policy.minCharacters) {
      result.push(window);
      continue;
    }

    const previous = result[result.length - 1];
    if (previous && canMergeWindows(body, previous, window, policy)) {
      result[result.length - 1] = mergeWindows(body, previous, window);
      continue;
    }

    const next = pending[index + 1];
    if (next && canMergeWindows(body, window, next, policy)) {
      pending[index + 1] = mergeWindows(body, window, next);
      continue;
    }

    result.push(window);
  }

  return result;
}

function canMergeWindows(
  body: string,
  first: TextWindow,
  second: TextWindow,
  policy: ChunkingPolicy
): boolean {
  if (first.isProtected === true && second.isProtected === true) {
    return false;
  }

  const start = Math.min(first.characterStart, second.characterStart);
  const end = Math.max(first.characterEnd, second.characterEnd);
  if (end - start > policy.maxCharacters) {
    return false;
  }

  const gap =
    first.characterEnd <= second.characterStart
      ? body.slice(first.characterEnd, second.characterStart)
      : second.characterEnd <= first.characterStart
        ? body.slice(second.characterEnd, first.characterStart)
        : "";
  return !gap.trim();
}

function mergeWindows(body: string, first: TextWindow, second: TextWindow): TextWindow {
  const characterStart = Math.min(first.characterStart, second.characterStart);
  const characterEnd = Math.max(first.characterEnd, second.characterEnd);
  return {
    text: body.slice(characterStart, characterEnd),
    characterStart,
    characterEnd,
    ...(first.isProtected === true || second.isProtected === true ? { isProtected: true } : {})
  };
}

function buildChunkId(documentId: string, index: number, textHash: string): string {
  return `chunk_${hashText(`${documentId}:${index}:${textHash}`)}`;
}

function buildLocator(body: string, window: TextWindow, policy: ChunkingPolicy): string {
  const locatorRange = contentRange(body, window) ?? window;

  if (policy.locatorStrategy === "line_range") {
    return formatRange(
      "line",
      lineNumberAt(body, locatorRange.characterStart),
      lineNumberAt(body, locatorRange.characterEnd - 1)
    );
  }

  if (policy.locatorStrategy === "paragraph_range") {
    return formatRange(
      "paragraph",
      paragraphNumberAt(body, locatorRange.characterStart),
      paragraphNumberAt(body, locatorRange.characterEnd - 1)
    );
  }

  return `chars ${window.characterStart}-${window.characterEnd}`;
}

function contentRange(body: string, window: TextWindow): TextWindow | undefined {
  let start = window.characterStart;
  let end = window.characterEnd;

  while (start < end && /\s/.test(body[start] ?? "")) {
    start += 1;
  }

  while (end > start && /\s/.test(body[end - 1] ?? "")) {
    end -= 1;
  }

  if (start >= end) {
    return undefined;
  }

  return {
    text: body.slice(start, end),
    characterStart: start,
    characterEnd: end
  };
}

function formatRange(label: string, start: number, end: number): string {
  return start === end ? `${label} ${start}` : `${label}s ${start}-${end}`;
}

function lineNumberAt(body: string, characterIndex: number): number {
  const safeIndex = Math.max(0, Math.min(characterIndex, Math.max(0, body.length - 1)));
  let line = 1;

  for (let index = 0; index < safeIndex; index += 1) {
    if (body[index] === "\n") {
      line += 1;
    }
  }

  return line;
}

function paragraphNumberAt(body: string, characterIndex: number): number {
  const safeIndex = Math.max(0, Math.min(characterIndex, Math.max(0, body.length - 1)));
  const prefix = body.slice(0, safeIndex + 1);
  const separators = prefix.match(/\n\s*\n/g);
  return (separators?.length ?? 0) + 1;
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function detectSafetyFlags(text: string, policy: ChunkingPolicy): readonly ChunkSafetyFlag[] {
  if (!policy.detectSuspiciousText) {
    return [];
  }

  const flags = new Set<ChunkSafetyFlag>();
  const lower = text.toLowerCase();

  if (
    lower.includes("ignore previous instructions") ||
    lower.includes("ignore all previous instructions") ||
    lower.includes("system prompt") ||
    lower.includes("developer message") ||
    lower.includes("reveal your instructions") ||
    lower.includes("do not obey")
  ) {
    flags.add("possible_prompt_injection");
  }

  if (
    /api[_-]?key/i.test(text) ||
    /bearer\s+[a-z0-9._-]{12,}/i.test(text) ||
    /password\s*=/i.test(text) ||
    /sk_live_[a-z0-9]+/i.test(text) ||
    /BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY/.test(text)
  ) {
    flags.add("secret_like_text");
  }

  if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text)) {
    flags.add("sensitive_personal_data");
  }

  if (text.length > policy.maxCharacters) {
    flags.add("oversized_chunk");
  }

  return [...flags];
}

export function assertValidChunkingPolicy(policy: ChunkingPolicy): void {
  const issues: string[] = [];

  if (!policy.id.trim()) {
    issues.push("id is required.");
  }

  if (policy.version !== undefined && !policy.version.trim()) {
    issues.push("version cannot be blank.");
  }

  if (!Number.isInteger(policy.maxCharacters) || policy.maxCharacters < 1) {
    issues.push("maxCharacters must be a positive integer.");
  }

  if (!Number.isInteger(policy.minCharacters) || policy.minCharacters < 1) {
    issues.push("minCharacters must be a positive integer.");
  }

  if (policy.minCharacters > policy.maxCharacters) {
    issues.push("minCharacters cannot exceed maxCharacters.");
  }

  if (!Number.isInteger(policy.overlapCharacters) || policy.overlapCharacters < 0) {
    issues.push("overlapCharacters must be a non-negative integer.");
  }

  if (policy.overlapCharacters >= policy.maxCharacters) {
    issues.push("overlapCharacters must be smaller than maxCharacters.");
  }

  if (!Number.isInteger(policy.maxChunksPerDocument) || policy.maxChunksPerDocument < 1) {
    issues.push("maxChunksPerDocument must be a positive integer.");
  }

  if (!["paragraph", "line", "character_window"].includes(policy.boundaryStrategy)) {
    issues.push(`Unknown boundaryStrategy "${policy.boundaryStrategy}".`);
  }

  if (!["character_range", "line_range", "paragraph_range"].includes(policy.locatorStrategy)) {
    issues.push(`Unknown locatorStrategy "${policy.locatorStrategy}".`);
  }

  for (const [path, value] of [
    ["preserveWhitespace", policy.preserveWhitespace],
    ["preserveStructuredLayoutRegions", policy.preserveStructuredLayoutRegions ?? false],
    ["includeTextHash", policy.includeTextHash],
    ["detectSuspiciousText", policy.detectSuspiciousText]
  ] as const) {
    if (typeof value !== "boolean") {
      issues.push(`${path} must be a boolean.`);
    }
  }

  if (issues.length > 0) {
    throw new ChunkingPolicyError(issues);
  }
}
