import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

import type { GraphApprovalRunResult } from "./graph-approval.js";

export interface GraphApprovalDecisionLedger {
  record(result: GraphApprovalRunResult): void;
}

export interface JsonlGraphApprovalDecisionLedgerOptions {
  readonly filePath: string;
}

export class JsonlGraphApprovalDecisionLedger implements GraphApprovalDecisionLedger {
  private readonly filePath: string;

  constructor(options: JsonlGraphApprovalDecisionLedgerOptions) {
    this.filePath = options.filePath;
  }

  record(result: GraphApprovalRunResult): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    appendFileSync(this.filePath, `${JSON.stringify(result)}\n`, "utf8");
  }

  readAll(): readonly GraphApprovalRunResult[] {
    if (!existsSync(this.filePath)) {
      return [];
    }

    return readFileSync(this.filePath, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as GraphApprovalRunResult);
  }
}
