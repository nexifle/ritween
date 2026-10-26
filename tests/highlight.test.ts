import { test } from "node:test";
import assert from "node:assert/strict";
import { highlight, highlightLines } from "../src/preview/highlight";

function kinds(code: string) {
  return highlight(code)
    .filter((token) => token.text.trim() !== "")
    .map((token) => `${token.kind}:${token.text}`);
}

test("highlight marks keywords, numbers, comments, strings, and calls", () => {
  assert.deepEqual(
    kinds('export const n = 1; // hi\nconst name = "pulse";'),
    [
      "keyword:export",
      "keyword:const",
      "plain:n",
      "punctuation:=",
      "number:1",
      "punctuation:;",
      "comment:// hi",
      "keyword:const",
      "plain:name",
      "punctuation:=",
      'string:"pulse"',
      "punctuation:;",
    ],
  );
  assert.ok(kinds("createIntro()").includes("function:createIntro"));
  assert.ok(kinds("type Scene = { name: string }").includes("type:Scene"));
  const template = kinds("const label = `A${name}B`;");
  assert.ok(template.includes("string:`A"));
  assert.ok(template.includes("plain:name"));
  assert.ok(template.includes("string:B`"));
});

test("highlight keeps line breaks for the source view", () => {
  const lines = highlightLines("const a = 1;\nconst b = 2;\n");
  assert.equal(lines.length, 2);
  assert.equal(lines[0].some((token) => token.text === "a"), true);
  assert.equal(lines[1].some((token) => token.text === "b"), true);
});
