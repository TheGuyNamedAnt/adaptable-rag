import { auditPagesForOcr, type PageOcrAuditOptions } from "../documents/page-ocr-audit.js";
export {
  auditPagesForOcr,
  type PageOcrAuditOptions,
  type PageOcrAuditPage,
  type PageOcrAuditReason,
  type PageOcrAuditResult
} from "../documents/page-ocr-audit.js";
import type { DocumentParseResult } from "./parser.js";

export function withPageOcrAuditMetadata(
  result: DocumentParseResult,
  options: PageOcrAuditOptions = {}
): DocumentParseResult {
  const audit = auditPagesForOcr(result.document.layout, options);
  return {
    ...result,
    document: {
      ...result.document,
      metadata: {
        ...result.document.metadata,
        pageOcrAuditJson: JSON.stringify(audit),
        pageOcrAuditPageCount: audit.pageCount,
        pageOcrNeededPageCount: audit.pagesNeedingOcr.length,
        pageOcrNeededPagesJson: JSON.stringify(audit.pagesNeedingOcr.map((page) => page.pageNumber))
      }
    }
  };
}
