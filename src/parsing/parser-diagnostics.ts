import { redactText } from "../shared/provider-boundary.js";
import type { DocumentParserWarning } from "./parser.js";

const MAX_DIAGNOSTIC_LENGTH = 1000;

export function safeParserDiagnosticMessage(error: unknown): string {
  const rawMessage = error instanceof Error ? error.message : String(error);
  return safeParserWarningMessage(rawMessage, "Parser failed.");
}

export function sanitizeParserWarning(warning: DocumentParserWarning): DocumentParserWarning {
  return {
    ...warning,
    message: safeParserWarningMessage(warning.message, "Parser warning was empty.")
  };
}

function safeParserWarningMessage(message: string, fallback: string): string {
  const redacted = redactText(message).trim();
  if (!redacted) {
    return fallback;
  }
  if (redacted.length <= MAX_DIAGNOSTIC_LENGTH) {
    return redacted;
  }
  return `${redacted.slice(0, MAX_DIAGNOSTIC_LENGTH - 3)}...`;
}
