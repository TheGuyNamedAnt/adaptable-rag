import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import path from "node:path";

import {
  createTableBankParseRequest,
  loadTableBankCases,
  loadTableBankCasesFromFile
} from "./tablebank-loader.js";

const fixtureDir = path.join(
  process.cwd(),
  "src",
  "parser-benchmarks",
  "fixtures",
  "tablebank-mini"
);

test("TableBank loader converts COCO annotations into table-detection benchmark cases", () => {
  const cases = loadTableBankCases({
    images: [{ id: 1, file_name: "word/page_1.png", width: 800, height: 1000 }],
    categories: [{ id: 1, name: "table" }],
    annotations: [
      { id: 10, image_id: 1, category_id: 1, bbox: [100, 200, 300, 120] },
      { id: 11, image_id: 1, category_id: 1, bbox: [100, 500, 320, 180], iscrowd: 1 }
    ]
  });

  assert.equal(cases.length, 1);
  const testCase = cases[0]!;
  assert.equal(testCase.dataset, "tablebank");
  assert.equal(testCase.id, "page_1");
  assert.equal(testCase.page.imagePath, "word/page_1.png");
  assert.equal(testCase.annotations.length, 2);
  assert.equal(testCase.annotations[0]?.box?.x, 100);
  assert.equal(testCase.annotations[1]?.ignored, true);
  assert.equal(testCase.evaluationScope.text, false);
  assert.equal(testCase.evaluationScope.tables, true);
});

test("TableBank loader reads a fixture with image-backed table annotations", async () => {
  const cases = await loadTableBankCasesFromFile(path.join(fixtureDir, "annotations.json"));

  assert.equal(cases.length, 1);
  const testCase = cases[0]!;
  assert.equal(testCase.id, "mini-table");
  assert.equal(testCase.contentType, "image/png");
  assert.equal(testCase.page.width, 160);
  assert.equal(testCase.page.height, 100);
  assert.equal(testCase.page.imagePath, "mini-table.png");
  assert.equal(testCase.annotations[0]?.box?.x, 20);
  assert.equal(testCase.annotations[0]?.box?.width, 120);
  assert.equal(testCase.annotations[0]?.text, "Metric Value Revenue 120 Cost 75");
  assert.match(testCase.expectedTableHtml[0] ?? "", /Revenue/iu);
});

test("TableBank parse request reads real image bytes from the fixture root", async () => {
  const [testCase] = await loadTableBankCasesFromFile(path.join(fixtureDir, "annotations.json"));
  assert.ok(testCase);

  const request = await createTableBankParseRequest(testCase, {
    imagesRoot: path.join(fixtureDir, "images"),
    requestedAt: "2026-06-27T00:00:00.000Z"
  });
  const fixtureBytes = await readFile(path.join(fixtureDir, "images", "mini-table.png"));

  assert.equal(request.contentType, "image/png");
  assert.ok(request.bytes);
  assert.equal(request.bytes.length, fixtureBytes.length);
  assert.deepEqual([...request.bytes.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(request.metadata?.["benchmarkDataset"], "tablebank");
  assert.equal(request.metadata?.["tableCount"], 1);
});

test("TableBank loader skips images without table annotations", () => {
  const cases = loadTableBankCases({
    images: [{ id: 1, file_name: "empty.png", width: 800, height: 1000 }],
    categories: [{ id: 1, name: "table" }],
    annotations: []
  });

  assert.equal(cases.length, 0);
});
