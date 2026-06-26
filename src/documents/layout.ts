export type LayoutCoordinateUnit = "pixel" | "point" | "normalized";

export const LAYOUT_COORDINATE_UNITS = [
  "pixel",
  "point",
  "normalized"
] as const satisfies readonly LayoutCoordinateUnit[];

export type DocumentLayoutStrategy =
  | "text_extraction"
  | "ocr_layout"
  | "table_structure"
  | "visual_page"
  | "hybrid";

export const DOCUMENT_LAYOUT_STRATEGIES = [
  "text_extraction",
  "ocr_layout",
  "table_structure",
  "visual_page",
  "hybrid"
] as const satisfies readonly DocumentLayoutStrategy[];

export type LayoutRegionKind =
  | "text"
  | "title"
  | "heading"
  | "paragraph"
  | "list"
  | "table"
  | "table_caption"
  | "figure"
  | "figure_caption"
  | "header"
  | "footer"
  | "reference"
  | "equation"
  | "page_image"
  | "unknown";

export const LAYOUT_REGION_KINDS = [
  "text",
  "title",
  "heading",
  "paragraph",
  "list",
  "table",
  "table_caption",
  "figure",
  "figure_caption",
  "header",
  "footer",
  "reference",
  "equation",
  "page_image",
  "unknown"
] as const satisfies readonly LayoutRegionKind[];

export type DocumentVisualAssetKind = "page_image" | "figure" | "table_crop" | "patch_grid";

export const DOCUMENT_VISUAL_ASSET_KINDS = [
  "page_image",
  "figure",
  "table_crop",
  "patch_grid"
] as const satisfies readonly DocumentVisualAssetKind[];

export type DocumentLayoutRelationKind =
  | "caption_for"
  | "explains"
  | "continues_as"
  | "references"
  | "same_section";

export const DOCUMENT_LAYOUT_RELATION_KINDS = [
  "caption_for",
  "explains",
  "continues_as",
  "references",
  "same_section"
] as const satisfies readonly DocumentLayoutRelationKind[];

export type LayoutMetadata = Readonly<Record<string, string | number | boolean>>;

export interface LayoutBox {
  readonly pageNumber: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly unit: LayoutCoordinateUnit;
}

export interface DocumentLayoutPage {
  readonly pageNumber: number;
  readonly width: number;
  readonly height: number;
  readonly unit: LayoutCoordinateUnit;
  readonly rotationDegrees?: number;
  readonly visualAssetId?: string;
}

export interface DocumentLayoutRegion {
  readonly id: string;
  readonly kind: LayoutRegionKind;
  readonly pageNumber: number;
  readonly box?: LayoutBox;
  readonly text?: string;
  readonly characterStart?: number;
  readonly characterEnd?: number;
  readonly parentId?: string;
  readonly childrenIds?: readonly string[];
  readonly confidence?: number;
  readonly metadata?: LayoutMetadata;
}

export interface DocumentTableCell {
  readonly rowIndex: number;
  readonly columnIndex: number;
  readonly rowSpan?: number;
  readonly columnSpan?: number;
  readonly text?: string;
  readonly regionId?: string;
  readonly box?: LayoutBox;
}

export interface DocumentTable {
  readonly id: string;
  readonly pageNumber: number;
  readonly regionId: string;
  readonly captionRegionId?: string;
  readonly box?: LayoutBox;
  readonly cells: readonly DocumentTableCell[];
  readonly summary?: string;
  readonly metadata?: LayoutMetadata;
}

export interface DocumentVisualAsset {
  readonly id: string;
  readonly kind: DocumentVisualAssetKind;
  readonly pageNumber: number;
  readonly mediaType: string;
  readonly uri?: string;
  readonly checksum?: string;
  readonly box?: LayoutBox;
  readonly metadata?: LayoutMetadata;
}

export interface DocumentLayoutRelation {
  readonly id: string;
  readonly kind: DocumentLayoutRelationKind;
  readonly fromRegionId: string;
  readonly toRegionId: string;
  readonly confidence?: number;
  readonly metadata?: LayoutMetadata;
}

export interface DocumentLayout {
  readonly parserId: string;
  readonly parserVersion?: string;
  readonly strategy: DocumentLayoutStrategy;
  readonly pages: readonly DocumentLayoutPage[];
  readonly regions: readonly DocumentLayoutRegion[];
  readonly relations?: readonly DocumentLayoutRelation[];
  readonly tables?: readonly DocumentTable[];
  readonly visualAssets?: readonly DocumentVisualAsset[];
  readonly warnings?: readonly string[];
  readonly metadata?: LayoutMetadata;
}

export type DocumentLayoutValidationSeverity = "error" | "warning";

export type DocumentLayoutValidationCode =
  | "layout_required"
  | "missing_parser_id"
  | "invalid_layout_strategy"
  | "missing_pages"
  | "invalid_page"
  | "duplicate_page_number"
  | "duplicate_id"
  | "invalid_region_kind"
  | "invalid_region_page"
  | "invalid_region_box"
  | "invalid_character_range"
  | "region_text_mismatch"
  | "invalid_confidence"
  | "invalid_parent_reference"
  | "invalid_child_reference"
  | "invalid_layout_relation"
  | "invalid_table_reference"
  | "invalid_table_cell"
  | "invalid_visual_asset";

export interface DocumentLayoutValidationIssue {
  readonly severity: DocumentLayoutValidationSeverity;
  readonly code: DocumentLayoutValidationCode;
  readonly path: string;
  readonly message: string;
}

export interface DocumentLayoutValidationResult {
  readonly valid: boolean;
  readonly issues: readonly DocumentLayoutValidationIssue[];
  readonly errors: readonly DocumentLayoutValidationIssue[];
  readonly warnings: readonly DocumentLayoutValidationIssue[];
}

export function validateDocumentLayout(
  layout: DocumentLayout | null | undefined,
  body: string
): DocumentLayoutValidationResult {
  const issues: DocumentLayoutValidationIssue[] = [];

  if (!layout) {
    issues.push(
      issue("error", "layout_required", "layout", "Document layout is required for validation.")
    );
    return result(issues);
  }

  if (!layout.parserId.trim()) {
    issues.push(issue("error", "missing_parser_id", "parserId", "Layout parserId is required."));
  }

  if (!isDocumentLayoutStrategy(layout.strategy)) {
    issues.push(
      issue(
        "error",
        "invalid_layout_strategy",
        "strategy",
        `Unknown document layout strategy "${layout.strategy}".`
      )
    );
  }

  if (layout.pages.length === 0) {
    issues.push(issue("error", "missing_pages", "pages", "Layout must include at least one page."));
  }

  const pagesByNumber = validatePages(layout.pages, issues);
  const globalIds = new Set<string>();
  const regionsById = validateRegions(layout.regions, body, pagesByNumber, globalIds, issues);
  validateRegionGraph(layout.regions, regionsById, issues);
  validateLayoutRelations(layout.relations ?? [], regionsById, globalIds, issues);
  validateTables(layout.tables ?? [], pagesByNumber, regionsById, globalIds, issues);
  validateVisualAssets(layout.visualAssets ?? [], pagesByNumber, globalIds, issues);

  return result(issues);
}

export function isDocumentLayoutStrategy(value: string): value is DocumentLayoutStrategy {
  return DOCUMENT_LAYOUT_STRATEGIES.some((strategy) => strategy === value);
}

export function isLayoutRegionKind(value: string): value is LayoutRegionKind {
  return LAYOUT_REGION_KINDS.some((kind) => kind === value);
}

export function isLayoutCoordinateUnit(value: string): value is LayoutCoordinateUnit {
  return LAYOUT_COORDINATE_UNITS.some((unit) => unit === value);
}

export function isDocumentLayoutRelationKind(value: string): value is DocumentLayoutRelationKind {
  return DOCUMENT_LAYOUT_RELATION_KINDS.some((kind) => kind === value);
}

function validatePages(
  pages: readonly DocumentLayoutPage[],
  issues: DocumentLayoutValidationIssue[]
): Map<number, DocumentLayoutPage> {
  const pagesByNumber = new Map<number, DocumentLayoutPage>();

  for (const [index, page] of pages.entries()) {
    const path = `pages.${index}`;

    if (!Number.isInteger(page.pageNumber) || page.pageNumber < 1) {
      issues.push(
        issue(
          "error",
          "invalid_page",
          `${path}.pageNumber`,
          "Page number must be a positive integer."
        )
      );
    }

    if (pagesByNumber.has(page.pageNumber)) {
      issues.push(
        issue(
          "error",
          "duplicate_page_number",
          `${path}.pageNumber`,
          `Duplicate layout page number ${page.pageNumber}.`
        )
      );
    } else {
      pagesByNumber.set(page.pageNumber, page);
    }

    if (!isPositiveFinite(page.width) || !isPositiveFinite(page.height)) {
      issues.push(
        issue(
          "error",
          "invalid_page",
          `${path}.width/height`,
          "Page width and height must be positive finite numbers."
        )
      );
    }

    if (!isLayoutCoordinateUnit(page.unit)) {
      issues.push(
        issue("error", "invalid_page", `${path}.unit`, `Unknown page unit "${page.unit}".`)
      );
    }

    if (
      page.rotationDegrees !== undefined &&
      (!Number.isFinite(page.rotationDegrees) || Math.abs(page.rotationDegrees) > 360)
    ) {
      issues.push(
        issue(
          "error",
          "invalid_page",
          `${path}.rotationDegrees`,
          "Page rotationDegrees must be finite and within -360..360."
        )
      );
    }
  }

  return pagesByNumber;
}

function validateRegions(
  regions: readonly DocumentLayoutRegion[],
  body: string,
  pagesByNumber: ReadonlyMap<number, DocumentLayoutPage>,
  globalIds: Set<string>,
  issues: DocumentLayoutValidationIssue[]
): Map<string, DocumentLayoutRegion> {
  const regionsById = new Map<string, DocumentLayoutRegion>();

  for (const [index, region] of regions.entries()) {
    const path = `regions.${index}`;

    registerGlobalId(region.id, path, globalIds, issues);
    if (region.id.trim()) {
      regionsById.set(region.id, region);
    }

    if (!isLayoutRegionKind(region.kind)) {
      issues.push(
        issue(
          "error",
          "invalid_region_kind",
          `${path}.kind`,
          `Unknown layout region kind "${region.kind}".`
        )
      );
    }

    if (!pagesByNumber.has(region.pageNumber)) {
      issues.push(
        issue(
          "error",
          "invalid_region_page",
          `${path}.pageNumber`,
          `Region references unknown page ${region.pageNumber}.`
        )
      );
    }

    if (region.box) {
      validateBox(region.box, pagesByNumber.get(region.pageNumber), `${path}.box`, issues, {
        code: "invalid_region_box",
        expectedPageNumber: region.pageNumber
      });
    }

    validateCharacterRange(region, body, path, issues);

    if (
      region.confidence !== undefined &&
      (!Number.isFinite(region.confidence) || region.confidence < 0 || region.confidence > 1)
    ) {
      issues.push(
        issue(
          "error",
          "invalid_confidence",
          `${path}.confidence`,
          "Region confidence must be a finite number from 0 to 1."
        )
      );
    }
  }

  return regionsById;
}

function validateRegionGraph(
  regions: readonly DocumentLayoutRegion[],
  regionsById: ReadonlyMap<string, DocumentLayoutRegion>,
  issues: DocumentLayoutValidationIssue[]
): void {
  for (const [index, region] of regions.entries()) {
    const path = `regions.${index}`;

    if (region.parentId) {
      const parent = regionsById.get(region.parentId);
      if (!parent || parent.id === region.id) {
        issues.push(
          issue(
            "error",
            "invalid_parent_reference",
            `${path}.parentId`,
            `Region parentId "${region.parentId}" does not reference a valid parent region.`
          )
        );
      }
    }

    for (const [childIndex, childId] of (region.childrenIds ?? []).entries()) {
      const child = regionsById.get(childId);
      if (!child || child.id === region.id) {
        issues.push(
          issue(
            "error",
            "invalid_child_reference",
            `${path}.childrenIds.${childIndex}`,
            `Region child id "${childId}" does not reference a valid child region.`
          )
        );
        continue;
      }

      if (child.parentId && child.parentId !== region.id) {
        issues.push(
          issue(
            "error",
            "invalid_child_reference",
            `${path}.childrenIds.${childIndex}`,
            `Child region "${childId}" points at parent "${child.parentId}" instead of "${region.id}".`
          )
        );
      }
    }
  }
}

function validateLayoutRelations(
  relations: readonly DocumentLayoutRelation[],
  regionsById: ReadonlyMap<string, DocumentLayoutRegion>,
  globalIds: Set<string>,
  issues: DocumentLayoutValidationIssue[]
): void {
  for (const [index, relation] of relations.entries()) {
    const path = `relations.${index}`;
    registerGlobalId(relation.id, path, globalIds, issues);

    if (!isDocumentLayoutRelationKind(relation.kind)) {
      issues.push(
        issue(
          "error",
          "invalid_layout_relation",
          `${path}.kind`,
          `Unknown layout relation kind "${relation.kind}".`
        )
      );
    }

    const from = regionsById.get(relation.fromRegionId);
    const to = regionsById.get(relation.toRegionId);
    if (!from) {
      issues.push(
        issue(
          "error",
          "invalid_layout_relation",
          `${path}.fromRegionId`,
          `Layout relation fromRegionId "${relation.fromRegionId}" does not reference a valid region.`
        )
      );
    }

    if (!to) {
      issues.push(
        issue(
          "error",
          "invalid_layout_relation",
          `${path}.toRegionId`,
          `Layout relation toRegionId "${relation.toRegionId}" does not reference a valid region.`
        )
      );
    }

    if (from && to && from.id === to.id) {
      issues.push(
        issue(
          "error",
          "invalid_layout_relation",
          `${path}.toRegionId`,
          "Layout relation cannot point a region at itself."
        )
      );
    }

    if (
      relation.confidence !== undefined &&
      (!Number.isFinite(relation.confidence) || relation.confidence < 0 || relation.confidence > 1)
    ) {
      issues.push(
        issue(
          "error",
          "invalid_layout_relation",
          `${path}.confidence`,
          "Layout relation confidence must be a finite number from 0 to 1."
        )
      );
    }
  }
}

function validateTables(
  tables: readonly DocumentTable[],
  pagesByNumber: ReadonlyMap<number, DocumentLayoutPage>,
  regionsById: ReadonlyMap<string, DocumentLayoutRegion>,
  globalIds: Set<string>,
  issues: DocumentLayoutValidationIssue[]
): void {
  for (const [index, table] of tables.entries()) {
    const path = `tables.${index}`;
    registerGlobalId(table.id, path, globalIds, issues);

    const page = pagesByNumber.get(table.pageNumber);
    if (!page) {
      issues.push(
        issue(
          "error",
          "invalid_table_reference",
          `${path}.pageNumber`,
          `Table references unknown page ${table.pageNumber}.`
        )
      );
    }

    const tableRegion = regionsById.get(table.regionId);
    if (!tableRegion || tableRegion.kind !== "table") {
      issues.push(
        issue(
          "error",
          "invalid_table_reference",
          `${path}.regionId`,
          `Table regionId "${table.regionId}" must reference a table layout region.`
        )
      );
    }

    if (table.captionRegionId) {
      const caption = regionsById.get(table.captionRegionId);
      if (!caption || caption.kind !== "table_caption") {
        issues.push(
          issue(
            "error",
            "invalid_table_reference",
            `${path}.captionRegionId`,
            `Table captionRegionId "${table.captionRegionId}" must reference a table_caption region.`
          )
        );
      }
    }

    if (table.box) {
      validateBox(table.box, page, `${path}.box`, issues, {
        code: "invalid_table_reference",
        expectedPageNumber: table.pageNumber
      });
    }

    for (const [cellIndex, cell] of table.cells.entries()) {
      validateTableCell(cell, cellIndex, table, page, regionsById, issues);
    }
  }
}

function validateTableCell(
  cell: DocumentTableCell,
  cellIndex: number,
  table: DocumentTable,
  page: DocumentLayoutPage | undefined,
  regionsById: ReadonlyMap<string, DocumentLayoutRegion>,
  issues: DocumentLayoutValidationIssue[]
): void {
  const path = `tables.${table.id}.cells.${cellIndex}`;

  if (!Number.isInteger(cell.rowIndex) || cell.rowIndex < 0) {
    issues.push(
      issue("error", "invalid_table_cell", `${path}.rowIndex`, "Cell rowIndex must be >= 0.")
    );
  }

  if (!Number.isInteger(cell.columnIndex) || cell.columnIndex < 0) {
    issues.push(
      issue("error", "invalid_table_cell", `${path}.columnIndex`, "Cell columnIndex must be >= 0.")
    );
  }

  if (cell.rowSpan !== undefined && (!Number.isInteger(cell.rowSpan) || cell.rowSpan < 1)) {
    issues.push(
      issue("error", "invalid_table_cell", `${path}.rowSpan`, "Cell rowSpan must be >= 1.")
    );
  }

  if (
    cell.columnSpan !== undefined &&
    (!Number.isInteger(cell.columnSpan) || cell.columnSpan < 1)
  ) {
    issues.push(
      issue("error", "invalid_table_cell", `${path}.columnSpan`, "Cell columnSpan must be >= 1.")
    );
  }

  if (cell.regionId && !regionsById.has(cell.regionId)) {
    issues.push(
      issue(
        "error",
        "invalid_table_cell",
        `${path}.regionId`,
        `Cell regionId "${cell.regionId}" does not reference a layout region.`
      )
    );
  }

  if (cell.box) {
    validateBox(cell.box, page, `${path}.box`, issues, {
      code: "invalid_table_cell",
      expectedPageNumber: table.pageNumber
    });
  }
}

function validateVisualAssets(
  visualAssets: readonly DocumentVisualAsset[],
  pagesByNumber: ReadonlyMap<number, DocumentLayoutPage>,
  globalIds: Set<string>,
  issues: DocumentLayoutValidationIssue[]
): void {
  for (const [index, asset] of visualAssets.entries()) {
    const path = `visualAssets.${index}`;
    registerGlobalId(asset.id, path, globalIds, issues);

    const page = pagesByNumber.get(asset.pageNumber);
    if (!page) {
      issues.push(
        issue(
          "error",
          "invalid_visual_asset",
          `${path}.pageNumber`,
          `Visual asset references unknown page ${asset.pageNumber}.`
        )
      );
    }

    if (!DOCUMENT_VISUAL_ASSET_KINDS.includes(asset.kind)) {
      issues.push(
        issue(
          "error",
          "invalid_visual_asset",
          `${path}.kind`,
          `Unknown visual asset kind "${asset.kind}".`
        )
      );
    }

    if (!asset.mediaType.trim()) {
      issues.push(
        issue(
          "error",
          "invalid_visual_asset",
          `${path}.mediaType`,
          "Visual asset mediaType is required."
        )
      );
    }

    if (asset.box) {
      validateBox(asset.box, page, `${path}.box`, issues, {
        code: "invalid_visual_asset",
        expectedPageNumber: asset.pageNumber
      });
    }
  }
}

function registerGlobalId(
  id: string,
  path: string,
  globalIds: Set<string>,
  issues: DocumentLayoutValidationIssue[]
): void {
  if (!id.trim()) {
    issues.push(issue("error", "duplicate_id", `${path}.id`, "Layout ids must be non-empty."));
    return;
  }

  if (globalIds.has(id)) {
    issues.push(issue("error", "duplicate_id", `${path}.id`, `Duplicate layout id "${id}".`));
    return;
  }

  globalIds.add(id);
}

function validateCharacterRange(
  region: DocumentLayoutRegion,
  body: string,
  path: string,
  issues: DocumentLayoutValidationIssue[]
): void {
  const hasStart = region.characterStart !== undefined;
  const hasEnd = region.characterEnd !== undefined;

  if (hasStart !== hasEnd) {
    issues.push(
      issue(
        "error",
        "invalid_character_range",
        `${path}.characterStart/characterEnd`,
        "Layout region must provide both characterStart and characterEnd or neither."
      )
    );
    return;
  }

  if (!hasStart || !hasEnd) {
    return;
  }

  const start = region.characterStart;
  const end = region.characterEnd;
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end <= start ||
    end > body.length
  ) {
    issues.push(
      issue(
        "error",
        "invalid_character_range",
        `${path}.characterStart/characterEnd`,
        "Layout region character range is invalid for the normalized document body."
      )
    );
    return;
  }

  if (region.text !== undefined && body.slice(start, end) !== region.text) {
    issues.push(
      issue(
        "error",
        "region_text_mismatch",
        `${path}.text`,
        "Layout region text must match the recorded character range exactly."
      )
    );
  }
}

function validateBox(
  box: LayoutBox,
  page: DocumentLayoutPage | undefined,
  path: string,
  issues: DocumentLayoutValidationIssue[],
  options: {
    readonly code:
      | "invalid_region_box"
      | "invalid_table_reference"
      | "invalid_table_cell"
      | "invalid_visual_asset";
    readonly expectedPageNumber: number;
  }
): void {
  if (box.pageNumber !== options.expectedPageNumber) {
    issues.push(
      issue(
        "error",
        options.code,
        `${path}.pageNumber`,
        `Box pageNumber ${box.pageNumber} must match parent page ${options.expectedPageNumber}.`
      )
    );
  }

  if (!isLayoutCoordinateUnit(box.unit)) {
    issues.push(
      issue("error", options.code, `${path}.unit`, `Unknown layout box unit "${box.unit}".`)
    );
  }

  if (
    !isNonNegativeFinite(box.x) ||
    !isNonNegativeFinite(box.y) ||
    !isPositiveFinite(box.width) ||
    !isPositiveFinite(box.height)
  ) {
    issues.push(
      issue(
        "error",
        options.code,
        path,
        "Layout box coordinates must be finite, non-negative, and have positive size."
      )
    );
    return;
  }

  if (box.unit === "normalized") {
    if (box.x + box.width > 1 + Number.EPSILON || box.y + box.height > 1 + Number.EPSILON) {
      issues.push(
        issue("error", options.code, path, "Normalized layout boxes must fit inside 0..1.")
      );
    }
    return;
  }

  if (page && page.unit === box.unit) {
    if (box.x + box.width > page.width || box.y + box.height > page.height) {
      issues.push(issue("error", options.code, path, "Layout box must fit inside the page."));
    }
  } else if (page) {
    issues.push(
      issue("error", options.code, `${path}.unit`, "Layout box unit must match its page unit.")
    );
  }
}

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function isNonNegativeFinite(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function issue(
  severity: DocumentLayoutValidationSeverity,
  code: DocumentLayoutValidationCode,
  path: string,
  message: string
): DocumentLayoutValidationIssue {
  return {
    severity,
    code,
    path,
    message
  };
}

function result(issues: readonly DocumentLayoutValidationIssue[]): DocumentLayoutValidationResult {
  const errors = issues.filter((validationIssue) => validationIssue.severity === "error");
  const warnings = issues.filter((validationIssue) => validationIssue.severity === "warning");

  return {
    valid: errors.length === 0,
    issues,
    errors,
    warnings
  };
}
