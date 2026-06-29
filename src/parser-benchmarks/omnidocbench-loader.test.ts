import assert from "node:assert/strict";
import test from "node:test";

import { loadOmniDocBenchCases } from "./omnidocbench-loader.js";

test("OmniDocBench loader converts JSON annotations into parser benchmark cases", () => {
  const cases = loadOmniDocBenchCases([
    {
      page_info: {
        page_no: 3,
        width: 1000,
        height: 1200,
        image_path: "images/report_page.png",
        page_attribute: { language: "english", page_type: "financial_report" }
      },
      layout_dets: [
        {
          category_type: "title",
          poly: [10, 20, 400, 20, 400, 60, 10, 60],
          ignore: false,
          order: 0,
          anno_id: 7,
          text: "Annual Report"
        },
        {
          category_type: "table",
          poly: [10, 100, 500, 100, 500, 220, 10, 220],
          ignore: false,
          order: 1,
          anno_id: 8,
          html: "<table><tr><td>Revenue</td><td>120</td></tr></table>"
        },
        {
          category_type: "text_block",
          poly: [0, 0, 1, 0, 1, 1, 0, 1],
          ignore: true,
          order: 2,
          anno_id: 9,
          text: "Ignored watermark"
        }
      ]
    }
  ]);

  assert.equal(cases.length, 1);
  const testCase = cases[0]!;
  assert.equal(testCase.id, "report_page");
  assert.equal(testCase.page.pageNumber, 1);
  assert.equal(testCase.page.width, 1000);
  assert.equal(testCase.page.attributes?.["sourcePageNumber"], 3);
  assert.equal(testCase.annotations.length, 2);
  assert.equal(testCase.expectedText, "Annual Report\nRevenue 120");
  assert.deepEqual(testCase.expectedReadingOrder, ["7", "8"]);
  assert.deepEqual(testCase.expectedTableHtml, [
    "<table><tr><td>Revenue</td><td>120</td></tr></table>"
  ]);
  assert.ok(testCase.tags.includes("financial_report"));
});

test("OmniDocBench loader can keep ignored annotations when requested", () => {
  const cases = loadOmniDocBenchCases(
    [
      {
        page_info: { page_no: 1, width: 100, height: 100 },
        layout_dets: [
          {
            category_type: "text_block",
            poly: [0, 0, 10, 0, 10, 10, 0, 10],
            ignore: true,
            anno_id: 1,
            text: "Watermark"
          }
        ]
      }
    ],
    { includeIgnoredAnnotations: true }
  );

  assert.equal(cases[0]?.annotations.length, 1);
  assert.equal(cases[0]?.expectedText, "");
});

test("OmniDocBench loader drops structural noise annotations by default", () => {
  const cases = loadOmniDocBenchCases([
    {
      page_info: { page_no: 1, width: 100, height: 100 },
      layout_dets: [
        {
          category_type: "text_block",
          poly: [0, 0, 10, 0, 10, 10, 0, 10],
          ignore: false,
          order: 0,
          anno_id: 1,
          text: "Body"
        },
        {
          category_type: "page_number",
          poly: [40, 90, 60, 90, 60, 100, 40, 100],
          ignore: false,
          order: 1,
          anno_id: 2,
          text: "7"
        },
        {
          category_type: "list_group",
          poly: [0, 20, 50, 20, 50, 80, 0, 80],
          ignore: false,
          anno_id: 3
        },
        {
          category_type: "abandon",
          poly: [0, 80, 50, 80, 50, 90, 0, 90],
          ignore: false,
          anno_id: 4
        }
      ]
    }
  ]);

  assert.deepEqual(
    cases[0]?.annotations.map((annotation) => annotation.id),
    ["1"]
  );
  assert.equal(cases[0]?.expectedText, "Body");
});
