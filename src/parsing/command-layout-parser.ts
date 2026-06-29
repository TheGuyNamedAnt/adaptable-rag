import { execFile } from "node:child_process";

import type { DocumentLayout } from "../documents/layout.js";
import { validateDocumentLayout } from "../documents/layout.js";
import type {
  DocumentParseRequest,
  DocumentParseResult,
  DocumentParser,
  DocumentParserCapabilities,
  DocumentParserWarning
} from "./parser.js";
import { safeParserDiagnosticMessage, sanitizeParserWarning } from "./parser-diagnostics.js";

export interface CommandLayoutParserCommand {
  readonly executable: string;
  readonly args?: readonly string[];
  readonly timeoutMs?: number;
  readonly env?: Readonly<Record<string, string>>;
}

export interface CommandLayoutParserOptions {
  readonly command: CommandLayoutParserCommand;
  readonly parserId?: string;
  readonly parserVersion?: string;
  readonly description?: string;
  readonly supportedContentTypes?: readonly string[];
  readonly emitsTables?: boolean;
  readonly emitsVisualAssets?: boolean;
  readonly maxBytes?: number;
  readonly runner?: CommandLayoutParserRunner;
}

export interface CommandLayoutParserInput {
  readonly sourceId: string;
  readonly sourceKind: string;
  readonly title: string;
  readonly contentType?: string;
  readonly text?: string;
  readonly bytesBase64?: string;
  readonly originUri?: string;
  readonly path?: string;
  readonly requestedAt: string;
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
  readonly contract: {
    readonly output: string;
    readonly requirement: string;
  };
}

export interface CommandLayoutParserOutput {
  readonly body: string;
  readonly layout: DocumentLayout;
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
  readonly warnings?: readonly DocumentParserWarning[];
}

export type CommandLayoutParserRunner = (
  command: CommandLayoutParserCommand,
  input: CommandLayoutParserInput
) => Promise<unknown>;

export class CommandLayoutParser implements DocumentParser {
  readonly id: string;
  readonly description: string;
  readonly version: string;
  readonly capabilities: DocumentParserCapabilities;

  private readonly command: CommandLayoutParserCommand;
  private readonly runner: CommandLayoutParserRunner;

  constructor(options: CommandLayoutParserOptions) {
    this.id = options.parserId ?? "command-layout-parser";
    this.description =
      options.description ??
      "Local command parser adapter for layout, table, and visual-asset extraction.";
    this.version = options.parserVersion ?? "1.0.0";
    this.command = options.command;
    this.runner = options.runner ?? runCommandLayoutParser;
    this.capabilities = {
      inputMode: "text_or_binary",
      emitsLayout: true,
      emitsTables: options.emitsTables ?? true,
      emitsVisualAssets: options.emitsVisualAssets ?? true,
      ...(options.supportedContentTypes === undefined
        ? {}
        : { supportedContentTypes: options.supportedContentTypes }),
      ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes })
    };
  }

  async parse(request: DocumentParseRequest): Promise<DocumentParseResult> {
    try {
      const output = parseCommandOutput(
        await this.runner(this.command, buildCommandInput(request))
      );
      const validation = validateDocumentLayout(output.layout, output.body);
      if (!validation.valid) {
        return fallbackResult(this, request, {
          code: "command_layout_invalid",
          message: `Command parser layout failed validation with ${validation.errors.length} error(s).`
        });
      }

      return {
        sourceId: request.sourceId,
        parserId: this.id,
        parserVersion: this.version,
        document: {
          body: output.body,
          layout: output.layout,
          ...(output.metadata === undefined ? {} : { metadata: output.metadata })
        },
        warnings: output.warnings ?? []
      };
    } catch (error) {
      return fallbackResult(this, request, {
        code: "command_layout_failed",
        message: safeParserDiagnosticMessage(error)
      });
    }
  }
}

export function buildCommandInput(request: DocumentParseRequest): CommandLayoutParserInput {
  return {
    sourceId: request.sourceId,
    sourceKind: request.sourceKind,
    title: request.title,
    ...(request.contentType === undefined ? {} : { contentType: request.contentType }),
    ...(request.text === undefined ? {} : { text: request.text }),
    ...(request.bytes === undefined
      ? {}
      : { bytesBase64: Buffer.from(request.bytes).toString("base64") }),
    ...(request.originUri === undefined ? {} : { originUri: request.originUri }),
    ...(request.path === undefined ? {} : { path: request.path }),
    requestedAt: request.requestedAt,
    ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
    contract: {
      output:
        "Return JSON with body, layout.pages, layout.regions, optional layout.relations, optional layout.tables, optional layout.visualAssets, optional metadata, and optional warnings.",
      requirement:
        "Every text region must include characterStart/characterEnd offsets into body. Visual assets should include page number, media type, optional URI, and optional box."
    }
  };
}

export async function runCommandLayoutParser(
  command: CommandLayoutParserCommand,
  input: CommandLayoutParserInput
): Promise<unknown> {
  const stdout = await execFileJson(command, JSON.stringify(input));
  return JSON.parse(stdout);
}

function execFileJson(command: CommandLayoutParserCommand, stdin: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command.executable,
      [...(command.args ?? [])],
      {
        timeout: command.timeoutMs ?? 60_000,
        env: { ...process.env, ...(command.env ?? {}) },
        maxBuffer: 64 * 1024 * 1024
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || error.message));
          return;
        }
        resolve(stdout);
      }
    );
    child.stdin?.end(stdin);
  });
}

function parseCommandOutput(value: unknown): CommandLayoutParserOutput {
  const record = typeof value === "string" ? JSON.parse(value) : value;
  if (!isRecord(record) || typeof record["body"] !== "string" || !isRecord(record["layout"])) {
    throw new Error("Command parser output must include body and layout object.");
  }

  return {
    body: record["body"],
    layout: record["layout"] as unknown as DocumentLayout,
    ...(isMetadata(record["metadata"]) ? { metadata: record["metadata"] } : {}),
    warnings: readWarnings(record["warnings"])
  };
}

function fallbackResult(
  parser: CommandLayoutParser,
  request: DocumentParseRequest,
  warning: DocumentParserWarning
): DocumentParseResult {
  return {
    sourceId: request.sourceId,
    parserId: parser.id,
    parserVersion: parser.version,
    document: {
      body: request.text ?? "",
      metadata: {
        ...(request.metadata ?? {}),
        parserFailed: true,
        parserFailureCode: warning.code,
        parserFailureMessage: warning.message
      }
    },
    warnings: [warning]
  };
}

function readWarnings(value: unknown): readonly DocumentParserWarning[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    if (
      !isRecord(item) ||
      typeof item["code"] !== "string" ||
      typeof item["message"] !== "string"
    ) {
      return [];
    }
    return [
      sanitizeParserWarning({
        code: item["code"],
        message: item["message"],
        ...(typeof item["path"] === "string" ? { path: item["path"] } : {})
      })
    ];
  });
}

function isMetadata(value: unknown): value is Readonly<Record<string, string | number | boolean>> {
  return (
    isRecord(value) &&
    Object.values(value).every((entry) => ["string", "number", "boolean"].includes(typeof entry))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
