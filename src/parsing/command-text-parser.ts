import { execFile } from "node:child_process";

import type {
  DocumentParseRequest,
  DocumentParseResult,
  DocumentParser,
  DocumentParserCapabilities,
  DocumentParserWarning
} from "./parser.js";
import { safeParserDiagnosticMessage, sanitizeParserWarning } from "./parser-diagnostics.js";

export interface CommandTextParserCommand {
  readonly executable: string;
  readonly args?: readonly string[];
  readonly timeoutMs?: number;
  readonly env?: Readonly<Record<string, string>>;
}

export interface CommandTextParserOptions {
  readonly command: CommandTextParserCommand;
  readonly parserId?: string;
  readonly parserVersion?: string;
  readonly description?: string;
  readonly supportedContentTypes?: readonly string[];
  readonly maxBytes?: number;
  readonly runner?: CommandTextParserRunner;
}

export interface CommandTextParserInput {
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

export interface CommandTextParserOutput {
  readonly body: string;
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
  readonly warnings?: readonly DocumentParserWarning[];
}

export type CommandTextParserRunner = (
  command: CommandTextParserCommand,
  input: CommandTextParserInput
) => Promise<unknown>;

export class CommandTextParser implements DocumentParser {
  readonly id: string;
  readonly description: string;
  readonly version: string;
  readonly capabilities: DocumentParserCapabilities;

  private readonly command: CommandTextParserCommand;
  private readonly runner: CommandTextParserRunner;

  constructor(options: CommandTextParserOptions) {
    this.id = options.parserId ?? "command-text-parser";
    this.description =
      options.description ?? "Local command parser adapter for text and Markdown extraction.";
    this.version = options.parserVersion ?? "1.0.0";
    this.command = options.command;
    this.runner = options.runner ?? runCommandTextParser;
    this.capabilities = {
      inputMode: "text_or_binary",
      emitsLayout: false,
      emitsTables: false,
      emitsVisualAssets: false,
      ...(options.supportedContentTypes === undefined
        ? {}
        : { supportedContentTypes: options.supportedContentTypes }),
      ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes })
    };
  }

  async parse(request: DocumentParseRequest): Promise<DocumentParseResult> {
    try {
      const output = parseCommandOutput(
        await this.runner(this.command, buildCommandTextInput(request))
      );
      return {
        sourceId: request.sourceId,
        parserId: this.id,
        parserVersion: this.version,
        document: {
          body: output.body,
          ...(output.metadata === undefined ? {} : { metadata: output.metadata })
        },
        warnings: output.warnings ?? []
      };
    } catch (error) {
      const message = safeParserDiagnosticMessage(error);
      return {
        sourceId: request.sourceId,
        parserId: this.id,
        parserVersion: this.version,
        document: {
          body: "",
          metadata: {
            ...(request.metadata ?? {}),
            parserFailed: true,
            parserFailureCode: "command_text_failed",
            parserFailureMessage: message
          }
        },
        warnings: [
          {
            code: "command_text_failed",
            message
          }
        ]
      };
    }
  }
}

export function buildCommandTextInput(request: DocumentParseRequest): CommandTextParserInput {
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
      output: "Return JSON with body, optional metadata, and optional warnings.",
      requirement: "Body must be normalized text or Markdown suitable for downstream RAG chunking."
    }
  };
}

export async function runCommandTextParser(
  command: CommandTextParserCommand,
  input: CommandTextParserInput
): Promise<unknown> {
  const stdout = await execFileJson(command, JSON.stringify(input));
  return JSON.parse(stdout);
}

function execFileJson(command: CommandTextParserCommand, stdin: string): Promise<string> {
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

function parseCommandOutput(value: unknown): CommandTextParserOutput {
  const record = typeof value === "string" ? JSON.parse(value) : value;
  if (!isRecord(record) || typeof record["body"] !== "string") {
    throw new Error("Command text parser output must include body.");
  }

  return {
    body: record["body"],
    ...(isMetadata(record["metadata"]) ? { metadata: record["metadata"] } : {}),
    warnings: readWarnings(record["warnings"])
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
