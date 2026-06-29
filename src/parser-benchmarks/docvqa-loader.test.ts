import assert from "node:assert/strict";
import test from "node:test";

import { loadDocVqaCases } from "./docvqa-loader.js";

test("DocVQA loader converts data records into document QA benchmark cases", () => {
  const cases = loadDocVqaCases({
    dataset_name: "docvqa",
    dataset_split: "train",
    data: [
      {
        questionId: 42,
        image: "documents/txpn0095_1.png",
        docId: 1968,
        ucsf_document_page_no: "1",
        question: "Who signed the letter?",
        answers: ["Edward R. Shannon", "Edward Shannon"],
        data_split: "train"
      }
    ]
  });

  assert.equal(cases.length, 1);
  const testCase = cases[0]!;
  assert.equal(testCase.dataset, "docvqa");
  assert.equal(testCase.id, "42");
  assert.equal(testCase.imagePath, "documents/txpn0095_1.png");
  assert.equal(testCase.question, "Who signed the letter?");
  assert.deepEqual(testCase.acceptedAnswers, ["Edward R. Shannon", "Edward Shannon"]);
  assert.equal(testCase.documentId, "1968");
  assert.equal(testCase.pageNumber, "1");
  assert.ok(testCase.tags.includes("train"));
});

test("DocVQA loader accepts array records and answer objects", () => {
  const cases = loadDocVqaCases([
    {
      question_id: "q1",
      image: "documents/page.png",
      question: "What is the invoice number?",
      answers: [{ answer: "INV-100" }, { answer: "INV 100" }]
    }
  ]);

  assert.equal(cases[0]?.id, "q1");
  assert.deepEqual(cases[0]?.acceptedAnswers, ["INV-100", "INV 100"]);
});

test("DocVQA loader accepts Hugging Face-style image objects", () => {
  const cases = loadDocVqaCases([
    {
      question_id: "q2",
      image: { path: "documents/hf-page.png" },
      question: "What is the total?",
      answer: "120"
    }
  ]);

  assert.equal(cases[0]?.imagePath, "documents/hf-page.png");
  assert.equal(cases[0]?.title, "hf-page.png");
});

test("DocVQA loader accepts fixture text and expected citation page metadata", () => {
  const cases = loadDocVqaCases([
    {
      question_id: "fixture-1",
      image: "tiny-page.png",
      document_text_path: "tiny-page.txt",
      expected_citation_page: 2,
      question: "What is the total due?",
      answers: ["$42.50"]
    }
  ]);

  assert.equal(cases[0]?.textPath, "tiny-page.txt");
  assert.equal(cases[0]?.expectedCitationPageNumber, 2);
});
