import {
  CommandLayoutParser,
  type CommandLayoutParserCommand,
  type CommandLayoutParserRunner
} from "./command-layout-parser.js";
import { DelimitedTableParser } from "./delimited-table-parser.js";
import { DocumentParserRouter, type ParserRouterCandidate } from "./parser-router.js";
import { PlainTextParser } from "./plain-text-parser.js";
import { SecHtmlParser } from "./sec-html-parser.js";
import type { DocumentParser } from "./parser.js";

export type LocalVisualParserEngine = "pdf_text" | "docling" | "mineru" | "paddleocr" | "custom";
export type LocalStructuredParserEngine =
  | "delimited_table"
  | "sec_html"
  | "openpyxl_command"
  | "custom";

export type LocalDocumentParserPreset =
  | "balanced"
  | "plain_text_first"
  | "ocr_heavy"
  | "table_heavy"
  | "structure_heavy"
  | "visual_heavy";

export interface LocalVisualParserConfig {
  readonly engine: LocalVisualParserEngine;
  readonly command?: CommandLayoutParserCommand;
  readonly parserId?: string;
  readonly priority?: number;
  readonly maxBytes?: number;
  readonly runner?: CommandLayoutParserRunner;
}

export interface LocalStructuredParserConfig {
  readonly engine: LocalStructuredParserEngine;
  readonly command?: CommandLayoutParserCommand;
  readonly parserId?: string;
  readonly priority?: number;
  readonly maxBytes?: number;
  readonly runner?: CommandLayoutParserRunner;
}

export interface LocalDocumentParserRouterOptions {
  readonly parserId?: string;
  readonly parserVersion?: string;
  readonly preset?: LocalDocumentParserPreset;
  readonly requireLayout?: boolean;
  readonly preferTables?: boolean;
  readonly preferVisualAssets?: boolean;
  readonly minimumBodyCharacters?: number;
  readonly structuredParsers?: readonly LocalStructuredParserConfig[];
  readonly visualParsers?: readonly LocalVisualParserConfig[];
  readonly extraLocalParsers?: readonly ParserRouterCandidate[];
}

export function createLocalDocumentParserRouter(
  options: LocalDocumentParserRouterOptions = {}
): DocumentParser {
  const preset = options.preset ?? "balanced";
  const presetPolicy = policyForLocalDocumentParserPreset(preset);
  const candidates: ParserRouterCandidate[] = [
    ...localStructuredParserCandidates(
      options.structuredParsers ?? defaultLocalStructuredParsers()
    ),
    {
      parser: new PlainTextParser({
        supportedContentTypes: [
          "text/*",
          "application/json",
          "application/x-ndjson",
          "application/yaml"
        ]
      }),
      tier: "fast_native",
      priority: 0,
      ...(options.minimumBodyCharacters === undefined
        ? {}
        : { minimumBodyCharacters: options.minimumBodyCharacters })
    },
    ...localVisualParserCandidates(options.visualParsers ?? defaultLocalVisualParsers(preset)),
    ...(options.extraLocalParsers ?? [])
  ];

  return new DocumentParserRouter({
    id: options.parserId ?? "local-document-parser-router",
    ...(options.parserVersion === undefined ? {} : { version: options.parserVersion }),
    description:
      "Free local parser router that tries native text first and escalates only to local layout/visual parsers.",
    candidates,
    policy: {
      requireLayout: options.requireLayout ?? presetPolicy.requireLayout,
      preferTables: options.preferTables ?? presetPolicy.preferTables,
      preferVisualAssets: options.preferVisualAssets ?? presetPolicy.preferVisualAssets,
      minimumBodyCharacters: options.minimumBodyCharacters ?? 1,
      allowPaidCloud: false
    }
  });
}

export function createBestCombinedLocalParserRouter(
  options: LocalDocumentParserRouterOptions = {}
): DocumentParser {
  return createLocalDocumentParserRouter({
    preset: "balanced",
    ...options
  });
}

export function defaultLocalStructuredParsers(): readonly LocalStructuredParserConfig[] {
  return [
    { engine: "delimited_table", priority: -20 },
    { engine: "sec_html", priority: -15 },
    { engine: "openpyxl_command", priority: -10 }
  ];
}

export function defaultLocalVisualParsers(
  preset: LocalDocumentParserPreset = "balanced"
): readonly LocalVisualParserConfig[] {
  switch (preset) {
    case "plain_text_first":
    case "balanced":
      return [
        { engine: "pdf_text", priority: 5 },
        { engine: "docling", priority: 10 },
        { engine: "paddleocr", priority: 20 },
        { engine: "mineru", priority: 30 }
      ];
    case "ocr_heavy":
      return [
        { engine: "pdf_text", priority: 5 },
        { engine: "paddleocr", priority: 10 },
        { engine: "mineru", priority: 20 },
        { engine: "docling", priority: 30 }
      ];
    case "table_heavy":
      return [
        { engine: "pdf_text", priority: 5 },
        { engine: "paddleocr", priority: 10 },
        { engine: "mineru", priority: 20 },
        { engine: "docling", priority: 30 }
      ];
    case "structure_heavy":
      return [
        { engine: "pdf_text", priority: 5 },
        { engine: "docling", priority: 10 },
        { engine: "mineru", priority: 20 },
        { engine: "paddleocr", priority: 30 }
      ];
    case "visual_heavy":
      return [
        { engine: "pdf_text", priority: 5 },
        { engine: "paddleocr", priority: 10 },
        { engine: "mineru", priority: 20 },
        { engine: "docling", priority: 30 }
      ];
  }
}

export function policyForLocalDocumentParserPreset(
  preset: LocalDocumentParserPreset
): Pick<
  Required<LocalDocumentParserRouterOptions>,
  "requireLayout" | "preferTables" | "preferVisualAssets"
> {
  switch (preset) {
    case "plain_text_first":
    case "balanced":
      return { requireLayout: false, preferTables: false, preferVisualAssets: false };
    case "ocr_heavy":
      return { requireLayout: true, preferTables: false, preferVisualAssets: false };
    case "table_heavy":
      return { requireLayout: true, preferTables: true, preferVisualAssets: false };
    case "structure_heavy":
      return { requireLayout: true, preferTables: true, preferVisualAssets: true };
    case "visual_heavy":
      return { requireLayout: true, preferTables: false, preferVisualAssets: true };
  }
}

export function localVisualParserCandidates(
  configs: readonly LocalVisualParserConfig[]
): readonly ParserRouterCandidate[] {
  return configs.map((config) => ({
    parser: new CommandLayoutParser({
      parserId: config.parserId ?? `${config.engine}-local-layout-parser`,
      description: `${config.engine} local layout parser adapter.`,
      command: commandForLocalVisualParser(config),
      supportedContentTypes: supportedContentTypesForLocalVisualParser(config.engine),
      ...(config.maxBytes === undefined ? {} : { maxBytes: config.maxBytes }),
      ...(config.runner === undefined ? {} : { runner: config.runner })
    }),
    tier:
      config.engine === "docling" || config.engine === "pdf_text" ? "layout_local" : "visual_local",
    priority: config.priority ?? defaultPriority(config.engine),
    requireLayout: true
  }));
}

export function localStructuredParserCandidates(
  configs: readonly LocalStructuredParserConfig[]
): readonly ParserRouterCandidate[] {
  return configs.map((config) => {
    if (config.engine === "delimited_table") {
      return {
        parser: new DelimitedTableParser({
          parserId: config.parserId ?? "delimited-table-parser",
          supportedContentTypes: ["text/csv", "text/tab-separated-values"],
          ...(config.maxBytes === undefined ? {} : { maxBytes: config.maxBytes })
        }),
        tier: "fast_native",
        priority: config.priority ?? -20,
        requireLayout: true
      };
    }

    if (config.engine === "sec_html") {
      return {
        parser: new SecHtmlParser({
          parserId: config.parserId ?? "sec-html-parser",
          ...(config.maxBytes === undefined ? {} : { maxBytes: config.maxBytes })
        }),
        tier: "fast_native",
        priority: config.priority ?? -15,
        requireLayout: true
      };
    }

    return {
      parser: new CommandLayoutParser({
        parserId: config.parserId ?? `${config.engine}-structured-parser`,
        description: `${config.engine} local structured spreadsheet parser adapter.`,
        command: commandForLocalStructuredParser(config),
        supportedContentTypes: [
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "application/vnd.ms-excel.sheet.macroEnabled.12"
        ],
        ...(config.maxBytes === undefined ? {} : { maxBytes: config.maxBytes }),
        ...(config.runner === undefined ? {} : { runner: config.runner })
      }),
      tier: "fast_native",
      priority: config.priority ?? -10,
      requireLayout: true
    };
  });
}

export function commandForLocalStructuredParser(
  config: LocalStructuredParserConfig
): CommandLayoutParserCommand {
  if (config.command) {
    return config.command;
  }

  switch (config.engine) {
    case "delimited_table":
      throw new Error("Delimited table parser is built in and does not use a command.");
    case "sec_html":
      throw new Error("SEC HTML parser is built in and does not use a command.");
    case "openpyxl_command":
      return {
        executable: process.execPath,
        args: ["scripts/openpyxl-rag-parser.mjs"],
        timeoutMs: 120_000
      };
    case "custom":
      throw new Error("Custom local structured parser requires a command.");
  }
}

function supportedContentTypesForLocalVisualParser(
  engine: LocalVisualParserEngine
): readonly string[] {
  if (engine === "docling" || engine === "custom") {
    return [
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "image/*"
    ];
  }
  if (engine === "pdf_text") {
    return ["application/pdf"];
  }
  return ["application/pdf", "image/*"];
}

export function commandForLocalVisualParser(
  config: LocalVisualParserConfig
): CommandLayoutParserCommand {
  if (config.command) {
    return config.command;
  }

  switch (config.engine) {
    case "pdf_text":
      return {
        executable: process.execPath,
        args: ["scripts/pdf-rag-parser.mjs"],
        timeoutMs: 120_000
      };
    case "docling":
      return {
        executable: process.execPath,
        args: ["scripts/docling-rag-parser.mjs"],
        timeoutMs: 120_000
      };
    case "paddleocr":
      return { executable: "paddleocr-rag-parser", timeoutMs: 180_000 };
    case "mineru":
      return { executable: "mineru-rag-parser", timeoutMs: 240_000 };
    case "custom":
      throw new Error("Custom local visual parser requires a command.");
  }
}

function defaultPriority(engine: LocalVisualParserEngine): number {
  switch (engine) {
    case "pdf_text":
      return 5;
    case "docling":
      return 10;
    case "paddleocr":
      return 20;
    case "mineru":
      return 30;
    case "custom":
      return 100;
  }
}
