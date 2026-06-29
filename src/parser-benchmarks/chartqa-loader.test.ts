import assert from "node:assert/strict";
import test from "node:test";

import { loadChartQaCases } from "./chartqa-loader.js";

test("ChartQA loader converts original repo records into document QA benchmark cases", () => {
  const cases = loadChartQaCases(
    [
      {
        imgname: "10095.png",
        query: "How many values are below 40 in Unfavorable graph?",
        label: "6"
      }
    ],
    { split: "train" }
  );

  assert.equal(cases.length, 1);
  const testCase = cases[0]!;
  assert.equal(testCase.dataset, "chartqa");
  assert.equal(testCase.id, "10095_1");
  assert.equal(testCase.imagePath, "10095.png");
  assert.equal(testCase.question, "How many values are below 40 in Unfavorable graph?");
  assert.deepEqual(testCase.acceptedAnswers, ["6"]);
  assert.equal(testCase.split, "train");
  assert.ok(testCase.tags.includes("chartqa"));
  assert.ok(testCase.tags.includes("train"));
});

test("ChartQA loader accepts Hugging Face-style image/query/label records", () => {
  const cases = loadChartQaCases({
    split: "val",
    data: [
      {
        image: { path: "png/chart.png" },
        query: "Is the trend increasing?",
        label: ["Yes"],
        human_or_machine: "0"
      }
    ]
  });

  assert.equal(cases[0]?.imagePath, "png/chart.png");
  assert.deepEqual(cases[0]?.acceptedAnswers, ["Yes"]);
  assert.equal(cases[0]?.split, "val");
  assert.ok(cases[0]?.tags.includes("human"));
});

test("ChartQA loader converts numeric and boolean answers to strings", () => {
  const cases = loadChartQaCases([
    {
      imgname: "chart.png",
      query: "Is this a pie chart?",
      label: true
    },
    {
      imgname: "chart.png",
      query: "What is the value?",
      label: 42
    }
  ]);

  assert.deepEqual(
    cases.map((testCase) => testCase.acceptedAnswers),
    [["Yes"], ["42"]]
  );
});

test("ChartQA loader accepts fixture chart text and expected citation page metadata", () => {
  const cases = loadChartQaCases([
    {
      imgname: "chart.png",
      query: "What is Q4 revenue?",
      label: "125",
      chart_text: "Q4 revenue: 125",
      expected_citation_page: 1
    }
  ]);

  assert.equal(cases[0]?.inlineText, "Q4 revenue: 125");
  assert.equal(cases[0]?.expectedCitationPageNumber, 1);
});
