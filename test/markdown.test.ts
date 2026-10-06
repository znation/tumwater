import test from "node:test";
import assert from "node:assert/strict";
import { markdownTable } from "../src/text/markdown.js";

test("markdownTable renders the header, an alignment separator, and body rows", () => {
  const lines = markdownTable(
    ["day", "ticks"],
    [
      ["09-08", "3"],
      ["09-09", "0"],
    ],
    ["left", "right"],
  );
  assert.deepEqual(lines, ["| day | ticks |", "| --- | ---: |", "| 09-08 | 3 |", "| 09-09 | 0 |"]);
});

test("markdownTable defaults every column to left alignment", () => {
  assert.deepEqual(markdownTable(["role", "landed"], [["feature", "$0.12"]]), [
    "| role | landed |",
    "| --- | --- |",
    "| feature | $0.12 |",
  ]);
});

test("markdownTable's separator always carries as many cells as the header", () => {
  const header = ["a", "b", "c", "d"];
  const lines = markdownTable(header, [], ["left", "right"]);
  assert.equal(lines.length, 2);
  const headLine = lines[0] ?? "";
  const sepLine = lines[1] ?? "";
  assert.equal(headLine.split("|").length, sepLine.split("|").length);
  assert.equal(sepLine, "| --- | ---: | --- | --- |");
});
