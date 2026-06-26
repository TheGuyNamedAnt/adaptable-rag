import { validateDocumentLayout, type DocumentLayoutValidationIssue } from "../documents/layout.js";
import type {
  DocumentParseRequest,
  DocumentParseResult,
  DocumentParser,
  DocumentParserWarning
} from "./parser.js";

export type DocumentParserContractSeverity = "error" | "warning";

export type DocumentParserContractIssueCode =
  | "parser_id_required"
  | "parser_description_required"
  | "invalid_parse_request"
  | "unsupported_input_mode"
  | "parser_threw"
  | "parse_source_mismatch"
  | "parse_parser_mismatch"
  | "empty_body"
  | "required_layout_missing"
  | "layout_invalid"
  | "declared_capability_mismatch"
  | "parser_warning_code_required"
  | "parser_warning_message_required"
  | "parser_warning_unexpected"
  | "parser_warning_leaks_sensitive_diagnostics";

export interface DocumentParserContractIssue {
  readonly severity: DocumentParserContractSeverity;
  readonly code: DocumentParserContractIssueCode;
  readonly path: string;
  readonly message: string;
}

export interface DocumentParserContractExpectations {
  readonly allowEmptyBody?: boolean;
  readonly requireLayout?: boolean;
  readonly allowParserWarnings?: boolean;
  readonly forbiddenDiagnosticPatterns?: readonly RegExp[];
}

export interface DocumentParserContractOptions {
  readonly parser: DocumentParser;
  readonly request: DocumentParseRequest;
  readonly expectations?: DocumentParserContractExpectations;
}

export interface DocumentParserContractResult {
  readonly parserId: string;
  readonly sourceId: string;
  readonly bodyLength: number;
  readonly warningCount: number;
  readonly layoutIssueCount: number;
  readonly parserWarnings: readonly DocumentParserWarning[];
  readonly layoutIssues: readonly DocumentLayoutValidationIssue[];
  readonly issues: readonly DocumentParserContractIssue[];
}

export class DocumentParserContractError extends Error {
  readonly result: DocumentParserContractResult;

  constructor(result: DocumentParserContractResult) {
    super(
      `Document parser contract failed for "${result.parserId}" on source "${result.sourceId}": ${result.issues
        .filter((issue) => issue.severity === "error")
        .map((issue) => issue.message)
        .join("; ")}`
    );
    this.name = "DocumentParserContractError";
    this.result = result;
  }
}

const DEFAULT_FORBIDDEN_DIAGNOSTIC_PATTERNS = [
  /bearer\s+[a-z0-9._-]+/iu,
  /api[_-]?key\s*[:=]\s*[^,\s]+/iu,
  /password\s*[:=]\s*[^,\s]+/iu,
  /secret\s*[:=]\s*[^,\s]+/iu,
  /token\s*[:=]\s*[^,\s]+/iu
] as const;

export async function assertDocumentParserContract(
  options: DocumentParserContractOptions
): Promise<DocumentParserContractResult> {
  const result = await validateDocumentParserContract(options);
  if (result.issues.some((issue) => issue.severity === "error")) {
    throw new DocumentParserContractError(result);
  }

  return result;
}

export async function validateDocumentParserContract(
  options: DocumentParserContractOptions
): Promise<DocumentParserContractResult> {
  const issues: DocumentParserContractIssue[] = [];
  const expectations = normalizeExpectations(options.expectations);
  validateStaticParserContract(options, expectations, issues);
  validateParseRequest(options, issues);

  let parsed: DocumentParseResult | undefined;
  try {
    parsed = await options.parser.parse(options.request);
  } catch (error) {
    issues.push({
      severity: "error",
      code: "parser_threw",
      path: "parser.parse",
      message: `Parser parse must return warnings instead of throwing: ${errorName(error)}.`
    });
  }

  if (!parsed) {
    return contractResult(options, undefined, [], issues);
  }

  const layoutIssues = validateParsedResult(options, parsed, expectations, issues);
  validateParserWarnings(parsed.warnings, expectations, issues);

  return contractResult(options, parsed, layoutIssues, issues);
}

interface NormalizedExpectations {
  readonly allowEmptyBody: boolean;
  readonly requireLayout: boolean;
  readonly allowParserWarnings: boolean;
  readonly forbiddenDiagnosticPatterns: readonly RegExp[];
}

function normalizeExpectations(
  expectations: DocumentParserContractExpectations | undefined
): NormalizedExpectations {
  return {
    allowEmptyBody: expectations?.allowEmptyBody ?? false,
    requireLayout: expectations?.requireLayout ?? false,
    allowParserWarnings: expectations?.allowParserWarnings ?? true,
    forbiddenDiagnosticPatterns:
      expectations?.forbiddenDiagnosticPatterns ?? DEFAULT_FORBIDDEN_DIAGNOSTIC_PATTERNS
  };
}

function validateStaticParserContract(
  options: DocumentParserContractOptions,
  expectations: NormalizedExpectations,
  issues: DocumentParserContractIssue[]
): void {
  if (!options.parser.id.trim()) {
    issues.push({
      severity: "error",
      code: "parser_id_required",
      path: "parser.id",
      message: "Parser id is required."
    });
  }

  if (!options.parser.description.trim()) {
    issues.push({
      severity: "error",
      code: "parser_description_required",
      path: "parser.description",
      message: "Parser description is required."
    });
  }

  if (expectations.requireLayout && !options.parser.capabilities.emitsLayout) {
    issues.push({
      severity: "error",
      code: "declared_capability_mismatch",
      path: "parser.capabilities.emitsLayout",
      message: "Parser contract requires layout, but parser declares emitsLayout=false."
    });
  }
}

function validateParseRequest(
  options: DocumentParserContractOptions,
  issues: DocumentParserContractIssue[]
): void {
  const hasText = options.request.text !== undefined;
  const hasBytes = options.request.bytes !== undefined;

  if (!options.request.sourceId.trim()) {
    issues.push({
      severity: "error",
      code: "invalid_parse_request",
      path: "request.sourceId",
      message: "Parse request sourceId is required."
    });
  }

  if (!options.request.title.trim()) {
    issues.push({
      severity: "error",
      code: "invalid_parse_request",
      path: "request.title",
      message: "Parse request title is required."
    });
  }

  if (!hasText && !hasBytes) {
    issues.push({
      severity: "error",
      code: "invalid_parse_request",
      path: "request.text/bytes",
      message: "Parse request must include text or bytes."
    });
  }

  if (options.parser.capabilities.inputMode === "text" && !hasText) {
    issues.push({
      severity: "error",
      code: "unsupported_input_mode",
      path: "request.text",
      message: "Parser requires text input."
    });
  }

  if (options.parser.capabilities.inputMode === "binary" && !hasBytes) {
    issues.push({
      severity: "error",
      code: "unsupported_input_mode",
      path: "request.bytes",
      message: "Parser requires binary input."
    });
  }

  if (
    options.request.bytes &&
    options.parser.capabilities.maxBytes !== undefined &&
    options.request.bytes.byteLength > options.parser.capabilities.maxBytes
  ) {
    issues.push({
      severity: "error",
      code: "invalid_parse_request",
      path: "request.bytes",
      message: `Parse request exceeds parser maxBytes=${options.parser.capabilities.maxBytes}.`
    });
  }
}

function validateParsedResult(
  options: DocumentParserContractOptions,
  parsed: DocumentParseResult,
  expectations: NormalizedExpectations,
  issues: DocumentParserContractIssue[]
): readonly DocumentLayoutValidationIssue[] {
  if (parsed.sourceId !== options.request.sourceId) {
    issues.push({
      severity: "error",
      code: "parse_source_mismatch",
      path: "result.sourceId",
      message: "Parse result sourceId must match the request sourceId."
    });
  }

  if (parsed.parserId !== options.parser.id) {
    issues.push({
      severity: "error",
      code: "parse_parser_mismatch",
      path: "result.parserId",
      message: "Parse result parserId must match the parser id."
    });
  }

  if (!expectations.allowEmptyBody && !parsed.document.body.trim()) {
    issues.push({
      severity: "error",
      code: "empty_body",
      path: "result.document.body",
      message: "Parsed document body is required."
    });
  }

  if (expectations.requireLayout && !parsed.document.layout) {
    issues.push({
      severity: "error",
      code: "required_layout_missing",
      path: "result.document.layout",
      message: "Parser contract requires a validated layout."
    });
  }

  if (parsed.document.layout && !options.parser.capabilities.emitsLayout) {
    issues.push({
      severity: "error",
      code: "declared_capability_mismatch",
      path: "parser.capabilities.emitsLayout",
      message: "Parser returned layout while declaring emitsLayout=false."
    });
  }

  if (!parsed.document.layout) {
    return [];
  }

  const layoutValidation = validateDocumentLayout(parsed.document.layout, parsed.document.body);
  for (const layoutIssue of layoutValidation.errors) {
    issues.push({
      severity: "error",
      code: "layout_invalid",
      path: `result.document.layout.${layoutIssue.path}`,
      message: layoutIssue.message
    });
  }

  return layoutValidation.issues;
}

function validateParserWarnings(
  warnings: readonly DocumentParserWarning[],
  expectations: NormalizedExpectations,
  issues: DocumentParserContractIssue[]
): void {
  if (!expectations.allowParserWarnings && warnings.length > 0) {
    issues.push({
      severity: "error",
      code: "parser_warning_unexpected",
      path: "result.warnings",
      message: "Parser warnings were not expected by this contract fixture."
    });
  }

  for (const [index, warning] of warnings.entries()) {
    if (!warning.code.trim()) {
      issues.push({
        severity: "error",
        code: "parser_warning_code_required",
        path: `result.warnings.${index}.code`,
        message: "Parser warning code is required."
      });
    }

    if (!warning.message.trim()) {
      issues.push({
        severity: "error",
        code: "parser_warning_message_required",
        path: `result.warnings.${index}.message`,
        message: "Parser warning message is required."
      });
    }

    if (expectations.forbiddenDiagnosticPatterns.some((pattern) => pattern.test(warning.message))) {
      issues.push({
        severity: "error",
        code: "parser_warning_leaks_sensitive_diagnostics",
        path: `result.warnings.${index}.message`,
        message: "Parser warning message appears to leak sensitive diagnostics."
      });
    }
  }
}

function contractResult(
  options: DocumentParserContractOptions,
  parsed: DocumentParseResult | undefined,
  layoutIssues: readonly DocumentLayoutValidationIssue[],
  issues: readonly DocumentParserContractIssue[]
): DocumentParserContractResult {
  return {
    parserId: options.parser.id,
    sourceId: options.request.sourceId,
    bodyLength: parsed?.document.body.length ?? 0,
    warningCount: parsed?.warnings.length ?? 0,
    layoutIssueCount: layoutIssues.length,
    parserWarnings: parsed?.warnings ?? [],
    layoutIssues,
    issues
  };
}

function errorName(error: unknown): string {
  if (error instanceof Error) {
    return error.name;
  }

  return typeof error;
}
