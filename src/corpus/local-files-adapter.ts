import { lstat, open, readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import type { SourceKind } from "../documents/provenance.js";
import type { SourceSensitivity, TrustTier } from "../documents/trust-tier.js";
import type { DocumentParser, DocumentParserWarning } from "../parsing/parser.js";
import type { AccessScope } from "../security/access-scope.js";
import { hashText } from "../shared/hash.js";
import type {
  CorpusAdapter,
  CorpusAdapterWarning,
  CorpusLoadRequest,
  CorpusLoadResult
} from "./adapter.js";
import type { CorpusRecord, CorpusRecordMetadata } from "./corpus-record.js";
import { redactDiagnosticMessage } from "./structured-record-mapper.js";

export const LOCAL_FILES_ADAPTER_ID = "local-files";
export const DEFAULT_LOCAL_FILES_PARSER_CONCURRENCY = 1;
export const MAX_LOCAL_FILES_PARSER_CONCURRENCY = 32;

export type LocalFilesParserMode = "auto" | "disabled";

const DEFAULT_MAX_FILE_BYTES = 1_000_000;
const FILE_TYPE_DETECTION_BYTES = 65_536;
const DEFAULT_INCLUDE_EXTENSIONS = [
  ".md",
  ".mdx",
  ".txt",
  ".htm",
  ".html",
  ".json",
  ".jsonl",
  ".yaml",
  ".yml",
  ".csv",
  ".tsv",
  ".pdf",
  ".docx",
  ".xlsx",
  ".xlsm",
  ".pptx",
  ".png",
  ".jpg",
  ".jpeg",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".dart",
  ".py",
  ".sql"
] as const;
const DEFAULT_EXCLUDE_DIRECTORIES = [
  ".git",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules"
] as const;
const NAMED_HTML_ENTITIES = new Map<string, string>([
  ["amp", "&"],
  ["apos", "'"],
  ["copy", "\u00a9"],
  ["gt", ">"],
  ["laquo", "\u00ab"],
  ["ldquo", "\u201c"],
  ["lsquo", "\u2018"],
  ["lt", "<"],
  ["mdash", "\u2014"],
  ["nbsp", " "],
  ["ndash", "\u2013"],
  ["quot", '"'],
  ["raquo", "\u00bb"],
  ["rdquo", "\u201d"],
  ["reg", "\u00ae"],
  ["rsquo", "\u2019"]
]);

export type LocalFilesCorpusWarningCode =
  | "missing_source_config"
  | "source_root_missing"
  | "source_root_not_directory"
  | "path_outside_root"
  | "file_not_found"
  | "file_not_regular"
  | "symlink_skipped"
  | "extension_skipped"
  | "hidden_path_skipped"
  | "excluded_directory_skipped"
  | "file_too_large"
  | "empty_file_skipped"
  | "binary_file_skipped"
  | "file_read_failed"
  | "parser_missing"
  | "parser_failed"
  | "parser_warning"
  | "parser_output_invalid";

export interface LocalFilesAccessScopeConfig {
  readonly tenantId?: string;
  readonly namespaceId?: string;
  readonly teamIds?: readonly string[];
  readonly userIds?: readonly string[];
  readonly roles?: readonly string[];
  readonly tags?: readonly string[];
}

export interface LocalFilesSourceConfig {
  readonly sourceId: string;
  readonly rootDir: string;
  readonly files?: readonly string[];
  readonly recursive?: boolean;
  readonly includeExtensions?: readonly string[];
  readonly excludeDirectories?: readonly string[];
  readonly includeHidden?: boolean;
  readonly followSymlinks?: boolean;
  readonly maxFileBytes?: number;
  readonly parserMode?: LocalFilesParserMode;
  readonly parserId?: string;
  readonly parserRequireLayout?: boolean;
  readonly parserConcurrency?: number;
  readonly sourceKind?: SourceKind;
  readonly trustTier?: TrustTier;
  readonly sensitivity?: SourceSensitivity;
  readonly accessScope?: LocalFilesAccessScopeConfig;
  readonly capturedAt?: string;
  readonly owner?: string;
  readonly originUriBase?: string;
  readonly metadata?: CorpusRecordMetadata;
}

export interface LocalFilesCorpusAdapterOptions {
  readonly id?: string;
  readonly description?: string;
  readonly sources: readonly LocalFilesSourceConfig[];
  readonly parsers?: readonly DocumentParser[];
}

interface DiscoveredFile {
  readonly absolutePath: string;
  readonly relativePath: string;
}

type FileContentTypeSource = "extension" | "signature";

interface FileTypeDetection {
  readonly extension: string;
  readonly contentType?: string;
  readonly contentTypeSource?: FileContentTypeSource;
  readonly extensionContentType?: string;
  readonly signatureContentType?: string;
}

interface RawTextBody {
  readonly body: string;
  readonly metadata?: CorpusRecordMetadata;
}

interface FileRecordResult {
  readonly record?: CorpusRecord;
  readonly warnings: readonly CorpusAdapterWarning[];
}

export class LocalFilesCorpusAdapter implements CorpusAdapter {
  readonly id: string;
  readonly description: string;

  private readonly sources: ReadonlyMap<string, LocalFilesSourceConfig>;
  private readonly parsers: ReadonlyMap<string, DocumentParser>;

  constructor(options: LocalFilesCorpusAdapterOptions) {
    this.id = options.id ?? LOCAL_FILES_ADAPTER_ID;
    this.description = options.description ?? "Loads local text files as corpus records.";
    this.sources = sourceConfigMap(options.sources);
    this.parsers = parserMap(options.parsers ?? []);

    if (!this.id.trim()) {
      throw new Error("LocalFilesCorpusAdapter id is required.");
    }
  }

  async load(request: CorpusLoadRequest): Promise<CorpusLoadResult> {
    const warnings: CorpusAdapterWarning[] = [];
    const config = this.sources.get(request.source.id);

    if (!config) {
      warnings.push(
        warning(
          request.source.id,
          "missing_source_config",
          `No local-files source config exists for source "${request.source.id}".`
        )
      );
      return {
        sourceId: request.source.id,
        records: [],
        warnings
      };
    }

    const root = await resolveRoot(config, request.source.id, warnings);
    if (!root) {
      return {
        sourceId: request.source.id,
        records: [],
        warnings
      };
    }

    const files = await discoverFiles(config, root, request.source.id, warnings);
    const parserConcurrency = parserConcurrencyForSource(config);
    const records: CorpusRecord[] = [];
    const fileResults: readonly FileRecordResult[] = await mapWithConcurrency(
      files,
      parserConcurrency,
      async (file) => {
        const fileWarnings: CorpusAdapterWarning[] = [];
        const record = await recordFromFile(
          config,
          request,
          root,
          file,
          this.parsers,
          fileWarnings
        );
        return {
          ...(record === undefined ? {} : { record }),
          warnings: fileWarnings
        };
      }
    );

    for (const result of fileResults) {
      warnings.push(...result.warnings);
      if (result.record) {
        records.push(result.record);
      }
    }

    return {
      sourceId: request.source.id,
      records,
      warnings
    };
  }
}

async function mapWithConcurrency<T, R extends object>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<readonly R[]> {
  if (items.length === 0) {
    return [];
  }

  const results: R[] = [];
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      for (;;) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) {
          return;
        }

        const item = items[index];
        if (item === undefined) {
          throw new Error("Local file concurrency scheduler encountered a missing file entry.");
        }
        results[index] = await worker(item, index);
      }
    })
  );

  return Array.from({ length: items.length }, (_value, index) => {
    const result = results[index];
    if (result === undefined) {
      throw new Error("Local file concurrency scheduler did not produce a result.");
    }
    return result;
  });
}

async function resolveRoot(
  config: LocalFilesSourceConfig,
  sourceId: string,
  warnings: CorpusAdapterWarning[]
): Promise<string | undefined> {
  try {
    const resolved = await realpath(path.resolve(config.rootDir));
    const rootStat = await stat(resolved);
    if (!rootStat.isDirectory()) {
      warnings.push(
        warning(
          sourceId,
          "source_root_not_directory",
          `Source root is not a directory: ${resolved}`
        )
      );
      return undefined;
    }

    return resolved;
  } catch (error) {
    warnings.push(
      warning(
        sourceId,
        "source_root_missing",
        `Source root is not readable: ${errorMessage(error)}`
      )
    );
    return undefined;
  }
}

async function discoverFiles(
  config: LocalFilesSourceConfig,
  root: string,
  sourceId: string,
  warnings: CorpusAdapterWarning[]
): Promise<readonly DiscoveredFile[]> {
  const discovered = new Map<string, DiscoveredFile>();

  if (config.files && config.files.length > 0) {
    for (const configuredPath of config.files) {
      const resolved = path.isAbsolute(configuredPath)
        ? path.resolve(configuredPath)
        : path.resolve(root, configuredPath);
      await collectPath(config, root, resolved, sourceId, warnings, discovered);
    }
    return [...discovered.values()].sort(compareDiscoveredFiles);
  }

  await collectDirectory(config, root, root, sourceId, warnings, discovered);
  return [...discovered.values()].sort(compareDiscoveredFiles);
}

async function collectPath(
  config: LocalFilesSourceConfig,
  root: string,
  candidatePath: string,
  sourceId: string,
  warnings: CorpusAdapterWarning[],
  discovered: Map<string, DiscoveredFile>
): Promise<void> {
  const checked = await safePathForRead(config, root, candidatePath, sourceId, warnings);
  if (!checked) {
    return;
  }

  const pathStat = await lstat(checked.absolutePath);
  if (pathStat.isDirectory()) {
    if (config.recursive === false) {
      await collectDirectoryEntries(
        config,
        root,
        checked.absolutePath,
        sourceId,
        warnings,
        discovered
      );
    } else {
      await collectDirectory(config, root, checked.absolutePath, sourceId, warnings, discovered);
    }
    return;
  }

  if (!pathStat.isFile()) {
    warnings.push(
      warning(sourceId, "file_not_regular", `Path is not a regular file: ${checked.relativePath}`)
    );
    return;
  }

  addFileIfAllowed(config, sourceId, warnings, discovered, checked);
}

async function collectDirectory(
  config: LocalFilesSourceConfig,
  root: string,
  directory: string,
  sourceId: string,
  warnings: CorpusAdapterWarning[],
  discovered: Map<string, DiscoveredFile>
): Promise<void> {
  if (shouldSkipDirectory(config, root, directory, sourceId, warnings)) {
    return;
  }

  await collectDirectoryEntries(config, root, directory, sourceId, warnings, discovered);
}

async function collectDirectoryEntries(
  config: LocalFilesSourceConfig,
  root: string,
  directory: string,
  sourceId: string,
  warnings: CorpusAdapterWarning[],
  discovered: Map<string, DiscoveredFile>
): Promise<void> {
  let entries: readonly string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    warnings.push(
      warning(
        sourceId,
        "file_read_failed",
        `Could not read directory ${relativeToRoot(root, directory)}: ${errorMessage(error)}`
      )
    );
    return;
  }

  for (const entry of [...entries].sort()) {
    const absolutePath = path.join(directory, entry);
    const checked = await safePathForRead(config, root, absolutePath, sourceId, warnings);
    if (!checked) {
      continue;
    }

    const entryStat = await lstat(checked.absolutePath);
    if (entryStat.isDirectory()) {
      if (config.recursive === false) {
        continue;
      }
      await collectDirectory(config, root, checked.absolutePath, sourceId, warnings, discovered);
      continue;
    }

    if (!entryStat.isFile()) {
      warnings.push(
        warning(sourceId, "file_not_regular", `Path is not a regular file: ${checked.relativePath}`)
      );
      continue;
    }

    addFileIfAllowed(config, sourceId, warnings, discovered, checked);
  }
}

async function safePathForRead(
  config: LocalFilesSourceConfig,
  root: string,
  candidatePath: string,
  sourceId: string,
  warnings: CorpusAdapterWarning[]
): Promise<DiscoveredFile | undefined> {
  let entryStat;
  try {
    entryStat = await lstat(candidatePath);
  } catch {
    warnings.push(warning(sourceId, "file_not_found", `Path does not exist: ${candidatePath}`));
    return undefined;
  }

  if (entryStat.isSymbolicLink()) {
    if (!config.followSymlinks) {
      warnings.push(warning(sourceId, "symlink_skipped", `Symlink skipped: ${candidatePath}`));
      return undefined;
    }
  }

  let resolvedPath: string;
  try {
    resolvedPath = entryStat.isSymbolicLink() ? await realpath(candidatePath) : candidatePath;
  } catch (error) {
    warnings.push(
      warning(sourceId, "file_read_failed", `Could not resolve path: ${errorMessage(error)}`)
    );
    return undefined;
  }

  const absolutePath = path.resolve(resolvedPath);
  if (!isInsideRoot(root, absolutePath)) {
    warnings.push(
      warning(sourceId, "path_outside_root", `Path is outside source root: ${absolutePath}`)
    );
    return undefined;
  }

  return {
    absolutePath,
    relativePath: relativeToRoot(root, absolutePath)
  };
}

function addFileIfAllowed(
  config: LocalFilesSourceConfig,
  sourceId: string,
  warnings: CorpusAdapterWarning[],
  discovered: Map<string, DiscoveredFile>,
  file: DiscoveredFile
): void {
  if (shouldSkipHiddenPath(config, sourceId, warnings, file.relativePath)) {
    return;
  }

  const extension = path.extname(file.relativePath).toLowerCase();
  if (!allowedExtensions(config).has(extension)) {
    warnings.push(
      warning(
        sourceId,
        "extension_skipped",
        `Skipped file with disallowed extension: ${file.relativePath}`
      )
    );
    return;
  }

  discovered.set(file.absolutePath, file);
}

async function recordFromFile(
  config: LocalFilesSourceConfig,
  request: CorpusLoadRequest,
  root: string,
  file: DiscoveredFile,
  parsers: ReadonlyMap<string, DocumentParser>,
  warnings: CorpusAdapterWarning[]
): Promise<CorpusRecord | undefined> {
  let fileStat;
  try {
    fileStat = await stat(file.absolutePath);
  } catch (error) {
    warnings.push(
      warning(
        request.source.id,
        "file_read_failed",
        `Could not stat file ${file.relativePath}: ${errorMessage(error)}`
      )
    );
    return undefined;
  }

  const maxFileBytes = config.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  if (fileStat.size > maxFileBytes) {
    warnings.push(
      warning(
        request.source.id,
        "file_too_large",
        `Skipped file ${file.relativePath}; ${fileStat.size} bytes exceeds ${maxFileBytes}.`
      )
    );
    return undefined;
  }

  const fileType = await detectFileType(
    file,
    path.extname(file.relativePath).toLowerCase(),
    fileStat.size,
    request.source.id,
    warnings
  );
  const parser = parserForFile({
    config,
    sourceId: request.source.id,
    relativePath: file.relativePath,
    contentType: fileType.contentType,
    fileSizeBytes: fileStat.size,
    parsers,
    warnings
  });
  if (config.parserId && config.parserMode !== "disabled" && !parser) {
    return undefined;
  }

  if (parser) {
    if (
      parser.capabilities.maxBytes !== undefined &&
      fileStat.size > parser.capabilities.maxBytes
    ) {
      warnings.push(
        warning(
          request.source.id,
          "file_too_large",
          `Skipped file ${file.relativePath}; ${fileStat.size} bytes exceeds parser maxBytes=${parser.capabilities.maxBytes}.`
        )
      );
      return undefined;
    }

    return parsedRecordFromFile(
      config,
      request,
      root,
      file,
      fileStat.size,
      fileType,
      parser,
      warnings
    );
  }

  return textRecordFromFile(
    config,
    request,
    root,
    file,
    fileStat.size,
    fileType,
    fileStat.mtime.toISOString(),
    warnings
  );
}

async function textRecordFromFile(
  config: LocalFilesSourceConfig,
  request: CorpusLoadRequest,
  root: string,
  file: DiscoveredFile,
  fileSizeBytes: number,
  fileType: FileTypeDetection,
  fileCapturedAt: string,
  warnings: CorpusAdapterWarning[]
): Promise<CorpusRecord | undefined> {
  let body: string;
  try {
    body = await readFile(file.absolutePath, "utf8");
  } catch (error) {
    warnings.push(
      warning(
        request.source.id,
        "file_read_failed",
        `Could not read file ${file.relativePath}: ${errorMessage(error)}`
      )
    );
    return undefined;
  }

  const normalized = normalizeRawTextBody(body, fileType);

  if (!normalized.body.trim()) {
    warnings.push(
      warning(request.source.id, "empty_file_skipped", `Skipped empty file: ${file.relativePath}`)
    );
    return undefined;
  }

  if (body.includes("\u0000")) {
    warnings.push(
      warning(
        request.source.id,
        "binary_file_skipped",
        `Skipped binary-looking file: ${file.relativePath}`
      )
    );
    return undefined;
  }

  const title = titleForFile(file.relativePath, normalized.body);
  const resolvedOriginUri = originUri(config, file.relativePath);

  return {
    id: documentId(request.source.id, file.relativePath),
    sourceId: request.source.id,
    sourceKind: config.sourceKind ?? "local_file",
    title,
    body: normalized.body,
    trustTier: config.trustTier ?? request.source.trustTierFloor ?? "trusted_internal",
    sensitivity: config.sensitivity ?? "internal",
    accessScope: accessScopeForFile(config, request),
    ...(resolvedOriginUri ? { originUri: resolvedOriginUri } : {}),
    path: file.relativePath,
    ...(config.owner ? { owner: config.owner } : {}),
    capturedAt: config.capturedAt ?? fileCapturedAt,
    checksum: hashText(normalized.body),
    metadata: {
      ...fileMetadata(config, root, file.relativePath, fileType, fileSizeBytes),
      ...(normalized.metadata ?? {})
    }
  };
}

function normalizeRawTextBody(body: string, fileType: FileTypeDetection): RawTextBody {
  if (!isHtmlFileType(fileType)) {
    return { body };
  }

  const normalized = htmlToSearchableText(body);
  if (!normalized.trim()) {
    return { body };
  }

  return {
    body: normalized,
    metadata: {
      rawTextTransform: "html_to_text",
      rawTextOriginalHash: hashText(body)
    }
  };
}

async function parsedRecordFromFile(
  config: LocalFilesSourceConfig,
  request: CorpusLoadRequest,
  root: string,
  file: DiscoveredFile,
  fileSizeBytes: number,
  fileType: FileTypeDetection,
  parser: DocumentParser,
  warnings: CorpusAdapterWarning[]
): Promise<CorpusRecord | undefined> {
  const contentType = fileType.contentType;
  if (
    contentType &&
    parser.capabilities.supportedContentTypes &&
    !supportsContentType(parser.capabilities.supportedContentTypes, contentType)
  ) {
    warnings.push(
      warning(
        request.source.id,
        "parser_output_invalid",
        `Parser "${parser.id}" does not support ${contentType} for ${file.relativePath}.`
      )
    );
    return undefined;
  }

  const parserInput = await readParserInput(parser, request.source.id, file, warnings);
  if (!parserInput) {
    return undefined;
  }

  const resolvedOriginUri = originUri(config, file.relativePath);
  const sourceKind = config.sourceKind ?? "local_file";
  const fallbackTitle = parserInput.text
    ? titleForFile(file.relativePath, parserInput.text)
    : titleFromPath(file.relativePath);

  let parsed;
  try {
    parsed = await parser.parse({
      sourceId: request.source.id,
      sourceKind,
      title: fallbackTitle,
      ...(contentType ? { contentType } : {}),
      ...parserInput,
      ...(resolvedOriginUri ? { originUri: resolvedOriginUri } : {}),
      path: file.relativePath,
      requestedAt: request.requestedAt,
      metadata: fileMetadata(config, root, file.relativePath, fileType, fileSizeBytes)
    });
  } catch (error) {
    warnings.push(
      warning(
        request.source.id,
        "parser_failed",
        `Parser "${parser.id}" failed for ${file.relativePath}: ${redactDiagnosticMessage(error)}`
      )
    );
    return undefined;
  }

  for (const parserWarning of parsed.warnings) {
    warnings.push(
      parserWarningForFile(request.source.id, file.relativePath, parser, parserWarning)
    );
  }

  if (parsed.sourceId !== request.source.id) {
    warnings.push(
      warning(
        request.source.id,
        "parser_output_invalid",
        `Parser "${parser.id}" returned sourceId "${parsed.sourceId}" for ${file.relativePath}.`
      )
    );
    return undefined;
  }

  if (parsed.parserId !== parser.id) {
    warnings.push(
      warning(
        request.source.id,
        "parser_output_invalid",
        `Parser "${parser.id}" returned parserId "${parsed.parserId}" for ${file.relativePath}.`
      )
    );
    return undefined;
  }

  const body = parsed.document.body;
  if (!body.trim()) {
    warnings.push(
      warning(
        request.source.id,
        "parser_output_invalid",
        `Parser "${parser.id}" returned an empty body for ${file.relativePath}.`
      )
    );
    return undefined;
  }

  if (body.includes("\u0000")) {
    warnings.push(
      warning(
        request.source.id,
        "parser_output_invalid",
        `Parser "${parser.id}" returned binary-looking text for ${file.relativePath}.`
      )
    );
    return undefined;
  }

  if (config.parserRequireLayout && !parsed.document.layout) {
    warnings.push(
      warning(
        request.source.id,
        "parser_output_invalid",
        `Parser "${parser.id}" did not return required layout for ${file.relativePath}.`
      )
    );
    return undefined;
  }

  const parserVersion = parsed.parserVersion ?? parser.version;

  return {
    id: documentId(request.source.id, file.relativePath),
    sourceId: request.source.id,
    sourceKind,
    title: titleForFile(file.relativePath, body),
    body,
    trustTier: config.trustTier ?? request.source.trustTierFloor ?? "trusted_internal",
    sensitivity: config.sensitivity ?? "internal",
    accessScope: accessScopeForFile(config, request),
    ...(resolvedOriginUri ? { originUri: resolvedOriginUri } : {}),
    path: file.relativePath,
    ...(config.owner ? { owner: config.owner } : {}),
    capturedAt: config.capturedAt ?? request.requestedAt,
    checksum: hashText(body),
    ...(parsed.document.layout ? { layout: parsed.document.layout } : {}),
    metadata: {
      ...(config.metadata ?? {}),
      ...(parsed.document.metadata ?? {}),
      relativePath: file.relativePath,
      extension: fileType.extension,
      fileSizeBytes,
      ...fileTypeMetadata(fileType),
      sourceRootHash: hashText(root),
      parserId: parsed.parserId,
      ...(parserVersion ? { parserVersion } : {})
    }
  };
}

async function readParserInput(
  parser: DocumentParser,
  sourceId: string,
  file: DiscoveredFile,
  warnings: CorpusAdapterWarning[]
): Promise<{ readonly text?: string; readonly bytes?: Uint8Array } | undefined> {
  if (parser.capabilities.inputMode === "text") {
    const text = await readTextFile(sourceId, file, warnings);
    return text === undefined ? undefined : { text };
  }

  if (parser.capabilities.inputMode === "binary") {
    const bytes = await readBytesFile(sourceId, file, warnings);
    return bytes === undefined ? undefined : { bytes };
  }

  const bytes = await readBytesFile(sourceId, file, warnings);
  if (bytes === undefined) {
    return undefined;
  }

  const text = bytes.toString("utf8");
  if (text.includes("\u0000")) {
    return { bytes };
  }

  return {
    text,
    bytes
  };
}

async function readTextFile(
  sourceId: string,
  file: DiscoveredFile,
  warnings: CorpusAdapterWarning[]
): Promise<string | undefined> {
  try {
    const text = await readFile(file.absolutePath, "utf8");
    if (text.includes("\u0000")) {
      warnings.push(
        warning(
          sourceId,
          "binary_file_skipped",
          `Skipped binary-looking file: ${file.relativePath}`
        )
      );
      return undefined;
    }
    return text;
  } catch (error) {
    warnings.push(
      warning(
        sourceId,
        "file_read_failed",
        `Could not read file ${file.relativePath}: ${errorMessage(error)}`
      )
    );
    return undefined;
  }
}

async function readBytesFile(
  sourceId: string,
  file: DiscoveredFile,
  warnings: CorpusAdapterWarning[]
): Promise<Buffer | undefined> {
  try {
    return await readFile(file.absolutePath);
  } catch (error) {
    warnings.push(
      warning(
        sourceId,
        "file_read_failed",
        `Could not read file ${file.relativePath}: ${errorMessage(error)}`
      )
    );
    return undefined;
  }
}

async function detectFileType(
  file: DiscoveredFile,
  extension: string,
  fileSizeBytes: number,
  _sourceId: string,
  _warnings: CorpusAdapterWarning[]
): Promise<FileTypeDetection> {
  const extensionContentType = contentTypeForExtension(extension);
  const prefix = await readFilePrefix(file, fileSizeBytes);
  const signatureContentType = prefix ? contentTypeFromSignature(prefix) : undefined;
  const contentType = preferredContentType({
    extension,
    extensionContentType,
    signatureContentType
  });
  const contentTypeSource =
    contentType && signatureContentType === contentType
      ? ("signature" as const)
      : contentType && extensionContentType === contentType
        ? ("extension" as const)
        : undefined;

  return {
    extension,
    ...(contentType ? { contentType } : {}),
    ...(contentTypeSource ? { contentTypeSource } : {}),
    ...(extensionContentType ? { extensionContentType } : {}),
    ...(signatureContentType ? { signatureContentType } : {})
  };
}

function preferredContentType(input: {
  readonly extension: string;
  readonly extensionContentType: string | undefined;
  readonly signatureContentType: string | undefined;
}): string | undefined {
  if (
    (input.extension === ".htm" || input.extension === ".html") &&
    input.extensionContentType === "text/html" &&
    input.signatureContentType === "application/xml"
  ) {
    return input.extensionContentType;
  }

  return input.signatureContentType ?? input.extensionContentType;
}

async function readFilePrefix(
  file: DiscoveredFile,
  fileSizeBytes: number
): Promise<Buffer | undefined> {
  const handle = await open(file.absolutePath, "r").catch(() => undefined);
  if (!handle) {
    return undefined;
  }

  try {
    const buffer = Buffer.alloc(Math.min(fileSizeBytes, FILE_TYPE_DETECTION_BYTES));
    const result = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, result.bytesRead);
  } catch {
    return undefined;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function contentTypeFromSignature(prefix: Buffer): string | undefined {
  if (startsWithBytes(prefix, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    return "application/pdf";
  }

  if (startsWithBytes(prefix, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }

  if (startsWithBytes(prefix, [0xff, 0xd8, 0xff])) {
    return "image/jpeg";
  }

  if (startsWithBytes(prefix, [0x50, 0x4b, 0x03, 0x04])) {
    return officeContentTypeFromZipPrefix(prefix);
  }

  return textContentTypeFromPrefix(prefix);
}

function officeContentTypeFromZipPrefix(prefix: Buffer): string | undefined {
  const sample = prefix.toString("latin1");
  if (sample.includes("word/document.xml")) {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }

  if (sample.includes("ppt/presentation.xml")) {
    return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  }

  if (sample.includes("xl/workbook.xml")) {
    return sample.includes("vbaProject.bin")
      ? "application/vnd.ms-excel.sheet.macroEnabled.12"
      : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  }

  return undefined;
}

function textContentTypeFromPrefix(prefix: Buffer): string | undefined {
  const trimmed = prefix
    .toString("utf8")
    .replace(/^\uFEFF/u, "")
    .trimStart();
  if (/^(?:<!doctype\s+html\b|<html\b)/iu.test(trimmed)) {
    return "text/html";
  }

  if (/^<\?xml\b/iu.test(trimmed)) {
    return "application/xml";
  }

  return undefined;
}

function startsWithBytes(buffer: Buffer, bytes: readonly number[]): boolean {
  return bytes.every((byte, index) => buffer[index] === byte);
}

function parserForFile(input: {
  readonly config: LocalFilesSourceConfig;
  readonly sourceId: string;
  readonly relativePath: string;
  readonly contentType: string | undefined;
  readonly fileSizeBytes: number;
  readonly parsers: ReadonlyMap<string, DocumentParser>;
  readonly warnings: CorpusAdapterWarning[];
}): DocumentParser | undefined {
  if (input.config.parserMode === "disabled") {
    return undefined;
  }

  if (input.config.parserId) {
    const parser = input.parsers.get(input.config.parserId);
    if (!parser) {
      input.warnings.push(
        warning(
          input.sourceId,
          "parser_missing",
          `No parser "${input.config.parserId}" is registered for ${input.relativePath}.`
        )
      );
    }

    return parser;
  }

  const contentType = input.contentType;
  if (!contentType) {
    return undefined;
  }

  return [...input.parsers.values()]
    .filter(
      (parser) =>
        supportsParserContentType(parser, contentType) &&
        parserWithinByteLimit(parser, input.fileSizeBytes)
    )
    .sort(
      (first, second) =>
        parserSpecificity(second, contentType) - parserSpecificity(first, contentType)
    )[0];
}

function supportsParserContentType(parser: DocumentParser, contentType: string): boolean {
  if (!parser.capabilities.supportedContentTypes) {
    return true;
  }

  return supportsContentType(parser.capabilities.supportedContentTypes, contentType);
}

function parserWithinByteLimit(parser: DocumentParser, fileSizeBytes: number): boolean {
  return (
    parser.capabilities.maxBytes === undefined || fileSizeBytes <= parser.capabilities.maxBytes
  );
}

function parserSpecificity(parser: DocumentParser, contentType: string): number {
  const supported = parser.capabilities.supportedContentTypes ?? [];
  const exactMatch = supported.includes(contentType) ? 100 : 0;
  const wildcardMatch = supported.some(
    (candidate) => candidate.endsWith("/*") && contentType.startsWith(candidate.slice(0, -1))
  )
    ? 50
    : 0;
  const openEnded = supported.length === 0 ? 10 : 0;
  const capabilityScore =
    (parser.capabilities.emitsLayout ? 5 : 0) +
    (parser.capabilities.emitsTables ? 3 : 0) +
    (parser.capabilities.emitsVisualAssets ? 2 : 0);
  return exactMatch + wildcardMatch + openEnded + capabilityScore;
}

function parserWarningForFile(
  sourceId: string,
  relativePath: string,
  parser: DocumentParser,
  parserWarning: DocumentParserWarning
): CorpusAdapterWarning {
  return warning(
    sourceId,
    "parser_warning",
    `Parser "${parser.id}" warning "${parserWarning.code}" for ${relativePath}: ${redactDiagnosticMessage(
      parserWarning.message
    )}`
  );
}

function fileMetadata(
  config: LocalFilesSourceConfig,
  root: string,
  relativePath: string,
  fileType: FileTypeDetection,
  fileSizeBytes: number
): CorpusRecordMetadata {
  return {
    ...(config.metadata ?? {}),
    relativePath,
    extension: fileType.extension,
    fileSizeBytes,
    ...fileTypeMetadata(fileType),
    sourceRootHash: hashText(root)
  };
}

function isHtmlFileType(fileType: FileTypeDetection): boolean {
  return (
    fileType.contentType === "text/html" ||
    fileType.extensionContentType === "text/html" ||
    fileType.signatureContentType === "text/html"
  );
}

function htmlToSearchableText(html: string): string {
  const visibleHtml = html
    .replace(/<!--[\s\S]*?-->/gu, " ")
    .replace(/<script\b[\s\S]*?<\/script>/giu, " ")
    .replace(/<style\b[\s\S]*?<\/style>/giu, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/giu, " ")
    .replace(/<template\b[\s\S]*?<\/template>/giu, " ");

  const withTables = visibleHtml.replace(
    /<table\b[\s\S]*?<\/table>/giu,
    (tableHtml) => `\n\n${htmlTableToText(tableHtml)}\n\n`
  );

  return normalizePlainTextLines(
    decodeHtmlEntities(
      withTables
        .replace(/<br\s*\/?>/giu, "\n")
        .replace(/<\/(?:p|div|section|article|header|footer|h[1-6]|li|tr)>/giu, "\n")
        .replace(/<[^>]+>/gu, " ")
    )
  );
}

function htmlTableToText(tableHtml: string): string {
  return matches(tableHtml, /<tr\b[\s\S]*?<\/tr>/giu)
    .map((rowHtml) =>
      matches(rowHtml, /<t[dh]\b[\s\S]*?<\/t[dh]>/giu)
        .map(normalizeHtmlCellText)
        .filter((cell) => cell.length > 0)
        .join(" | ")
    )
    .filter((row) => row.length > 0)
    .join("\n");
}

function normalizeHtmlCellText(cellHtml: string): string {
  return decodeHtmlEntities(
    cellHtml
      .replace(/<br\s*\/?>/giu, " ")
      .replace(/<[^>]+>/gu, " ")
      .replace(/\s+/gu, " ")
      .trim()
  );
}

function normalizePlainTextLines(text: string): string {
  const lines = text
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v]+/gu, " ").trim())
    .filter((line) => line.length > 0);

  const result: string[] = [];
  for (const line of lines) {
    if (result[result.length - 1] !== line) {
      result.push(line);
    }
  }

  return result.join("\n\n");
}

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/giu, (entity, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      return characterFromCodePoint(Number.parseInt(body.slice(2), 16), entity);
    }

    if (body.startsWith("#")) {
      return characterFromCodePoint(Number.parseInt(body.slice(1), 10), entity);
    }

    return NAMED_HTML_ENTITIES.get(body.toLowerCase()) ?? entity;
  });
}

function characterFromCodePoint(codePoint: number, fallback: string): string {
  if (!Number.isInteger(codePoint) || codePoint < 0) {
    return fallback;
  }

  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return fallback;
  }
}

function matches(value: string, pattern: RegExp): readonly string[] {
  return [...value.matchAll(pattern)].map((match) => match[0] ?? "");
}

function fileTypeMetadata(fileType: FileTypeDetection): CorpusRecordMetadata {
  return {
    ...(fileType.contentType ? { contentType: fileType.contentType } : {}),
    ...(fileType.contentTypeSource ? { contentTypeSource: fileType.contentTypeSource } : {}),
    ...(fileType.extensionContentType
      ? { extensionContentType: fileType.extensionContentType }
      : {}),
    ...(fileType.signatureContentType
      ? { signatureContentType: fileType.signatureContentType }
      : {})
  };
}

function accessScopeForFile(
  config: LocalFilesSourceConfig,
  request: CorpusLoadRequest
): AccessScope {
  const configured = config.accessScope;
  return {
    tenantId: configured?.tenantId ?? request.requestedBy.tenantId,
    namespaceId: configured?.namespaceId ?? request.profile.namespaceId,
    ...(configured?.teamIds !== undefined ? { teamIds: configured.teamIds } : {}),
    ...(configured?.userIds !== undefined ? { userIds: configured.userIds } : {}),
    ...(configured?.roles !== undefined ? { roles: configured.roles } : {}),
    ...(configured?.tags !== undefined
      ? { tags: configured.tags }
      : { tags: request.source.tags ?? [] })
  };
}

function shouldSkipDirectory(
  config: LocalFilesSourceConfig,
  root: string,
  directory: string,
  sourceId: string,
  warnings: CorpusAdapterWarning[]
): boolean {
  const relativePath = relativeToRoot(root, directory);
  if (relativePath === ".") {
    return false;
  }

  const directoryName = path.basename(directory);
  if (excludeDirectories(config).has(directoryName)) {
    warnings.push(
      warning(sourceId, "excluded_directory_skipped", `Skipped directory: ${relativePath}`)
    );
    return true;
  }

  return shouldSkipHiddenPath(config, sourceId, warnings, relativePath);
}

function shouldSkipHiddenPath(
  config: LocalFilesSourceConfig,
  sourceId: string,
  warnings: CorpusAdapterWarning[],
  relativePath: string
): boolean {
  if (config.includeHidden) {
    return false;
  }

  if (relativePath.split("/").some((part) => part.startsWith(".") && part.length > 1)) {
    warnings.push(warning(sourceId, "hidden_path_skipped", `Skipped hidden path: ${relativePath}`));
    return true;
  }

  return false;
}

function titleForFile(relativePath: string, body: string): string {
  const heading = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
  if (heading) {
    return heading;
  }

  const basename = path.basename(relativePath, path.extname(relativePath)).replace(/[-_]+/g, " ");
  return basename.replace(/\s+/g, " ").trim() || relativePath;
}

function titleFromPath(relativePath: string): string {
  const basename = path.basename(relativePath, path.extname(relativePath)).replace(/[-_]+/g, " ");
  return basename.replace(/\s+/g, " ").trim() || relativePath;
}

function documentId(sourceId: string, relativePath: string): string {
  const stem = path.basename(relativePath, path.extname(relativePath));
  const safeStem = stem
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const suffix = hashText(`${sourceId}:${relativePath}`).slice(0, 16);
  return [sourceId, safeStem || "file", suffix].join("_");
}

function originUri(config: LocalFilesSourceConfig, relativePath: string): string | undefined {
  if (!config.originUriBase?.trim()) {
    return undefined;
  }

  return `${config.originUriBase.replace(/\/+$/u, "")}/${relativePath}`;
}

function allowedExtensions(config: LocalFilesSourceConfig): ReadonlySet<string> {
  return new Set((config.includeExtensions ?? DEFAULT_INCLUDE_EXTENSIONS).map(normalizeExtension));
}

function excludeDirectories(config: LocalFilesSourceConfig): ReadonlySet<string> {
  return new Set(config.excludeDirectories ?? DEFAULT_EXCLUDE_DIRECTORIES);
}

function normalizeExtension(extension: string): string {
  const trimmed = extension.trim().toLowerCase();
  return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
}

function sourceConfigMap(
  configs: readonly LocalFilesSourceConfig[]
): ReadonlyMap<string, LocalFilesSourceConfig> {
  const map = new Map<string, LocalFilesSourceConfig>();

  for (const config of configs) {
    if (!config.sourceId.trim()) {
      throw new Error("Local file source config sourceId is required.");
    }

    if (map.has(config.sourceId)) {
      throw new Error(`Duplicate local file source config "${config.sourceId}".`);
    }

    parserConcurrencyForSource(config);
    map.set(config.sourceId, config);
  }

  return map;
}

function parserConcurrencyForSource(config: LocalFilesSourceConfig): number {
  if (config.parserConcurrency === undefined) {
    return DEFAULT_LOCAL_FILES_PARSER_CONCURRENCY;
  }

  if (
    !Number.isInteger(config.parserConcurrency) ||
    config.parserConcurrency < 1 ||
    config.parserConcurrency > MAX_LOCAL_FILES_PARSER_CONCURRENCY
  ) {
    throw new Error(
      `Local file source config "${config.sourceId}" parserConcurrency must be an integer between 1 and ${MAX_LOCAL_FILES_PARSER_CONCURRENCY}.`
    );
  }

  return config.parserConcurrency;
}

function parserMap(parsers: readonly DocumentParser[]): ReadonlyMap<string, DocumentParser> {
  const map = new Map<string, DocumentParser>();

  for (const parser of parsers) {
    if (!parser.id.trim()) {
      throw new Error("Local file parser id is required.");
    }

    if (map.has(parser.id)) {
      throw new Error(`Duplicate local file parser "${parser.id}".`);
    }

    map.set(parser.id, parser);
  }

  return map;
}

function contentTypeForExtension(extension: string): string | undefined {
  switch (extension) {
    case ".csv":
      return "text/csv";
    case ".tsv":
      return "text/tab-separated-values";
    case ".docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".xls":
      return "application/vnd.ms-excel";
    case ".xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case ".xlsm":
      return "application/vnd.ms-excel.sheet.macroEnabled.12";
    case ".pptx":
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    case ".json":
      return "application/json";
    case ".jsonl":
      return "application/x-ndjson";
    case ".md":
    case ".mdx":
      return "text/markdown";
    case ".htm":
    case ".html":
      return "text/html";
    case ".pdf":
      return "application/pdf";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".txt":
      return "text/plain";
    case ".yaml":
    case ".yml":
      return "application/yaml";
    default:
      return undefined;
  }
}

function supportsContentType(
  supportedContentTypes: readonly string[],
  contentType: string
): boolean {
  return supportedContentTypes.some((supported) =>
    supported.endsWith("/*")
      ? contentType.startsWith(supported.slice(0, supported.length - 1))
      : supported === contentType
  );
}

function warning(
  sourceId: string,
  code: LocalFilesCorpusWarningCode,
  message: string
): CorpusAdapterWarning {
  return {
    sourceId,
    code,
    message
  };
}

function relativeToRoot(root: string, value: string): string {
  const relativePath = path.relative(root, value);
  return relativePath ? toPosixPath(relativePath) : ".";
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

function isInsideRoot(root: string, value: string): boolean {
  const relativePath = path.relative(root, value);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function compareDiscoveredFiles(first: DiscoveredFile, second: DiscoveredFile): number {
  return first.relativePath.localeCompare(second.relativePath);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown filesystem error.";
}
