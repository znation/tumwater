import test from "node:test";
import assert from "node:assert/strict";
import { GUI_CLIENT_MARKDOWN_JS } from "../src/ui/gui/gui-client-markdown.js";
import { GUI_CLIENT_JS } from "../src/ui/gui/gui-client.js";
import { clientScope } from "./helpers/gui-client-scope.js";

// The dashboard's Markdown renderer (src/ui/gui/gui-client-markdown.ts): it renders the loops'
// Markdown (backlog bodies, the failure digest) browser-side, and everything it renders came
// from a model, so its escaping and its link handling are safety properties, not cosmetics.
// gui-client.test.ts covers the renderer's happy paths; these pin the edges it leaves open.

const load = () =>
  clientScope<{ renderMarkdown(src: string, breaks?: boolean): string; mdInline(s: string): string }>(
    ["markdown"],
    ["renderMarkdown", "mdInline"],
  );

test("GUI_CLIENT_JS carries the markdown module verbatim", () => {
  assert.ok(GUI_CLIENT_JS.includes(GUI_CLIENT_MARKDOWN_JS), "the module's constant appears verbatim in the assembled script");
});

test("heading edges: the h1 level stays the view's, six hashes cap out, seven is prose", () => {
  const { renderMarkdown } = load();
  assert.equal(renderMarkdown("### Part"), "<h4>Part</h4>");
  assert.equal(renderMarkdown("###### Deep"), "<h6>Deep</h6>", "the view's own title is the h1, so six hashes tops out at h6");
  assert.equal(renderMarkdown("####### seven"), "<p>####### seven</p>", "seven hashes is not an ATX heading");
  assert.equal(renderMarkdown("#tag"), "<p>#tag</p>", "no space after the hashes is not a heading");
});

test("paragraph edges: CRLF input, and ampersands cannot forge entities", () => {
  const { renderMarkdown, mdInline } = load();
  assert.equal(renderMarkdown("a\r\nb"), "<p>a b</p>", "CRLF line endings are normalized");
  assert.equal(mdInline("a & b"), "a &amp; b");
  assert.equal(mdInline("&lt;img&gt;"), "a".length ? "&amp;lt;img&amp;gt;" : "", "a written-out entity is escaped again, not re-parsed");
});

test("inline-code edges: an empty span, a partial span, and markup inside a span", () => {
  const { mdInline } = load();
  assert.equal(mdInline("``"), "``", "an empty span renders as its backticks");
  assert.equal(mdInline("a `b and `c`"), "a <code>b and </code>c`", "a matched pair forms a span and the trailing run stays prose");
  assert.equal(mdInline("`<b>`"), "<code>&lt;b&gt;</code>", "code span contents are escaped like any other text");
});

test("fence edges: an unclosed fence swallows to the end, and indentation is kept", () => {
  const { renderMarkdown } = load();
  assert.equal(renderMarkdown("```\nnever closed"), "<pre><code>never closed</code></pre>");
  assert.equal(renderMarkdown("  ```sh\n  echo hi\n  ```"), "<pre><code>  echo hi</code></pre>", "a pre keeps the code's own indentation");
});

test("block quotes render as one blockquote, escaped and joined", () => {
  const { renderMarkdown } = load();
  assert.equal(renderMarkdown("> line one\n> line two"), "<blockquote>line one line two</blockquote>");
  assert.equal(renderMarkdown("> <img>"), "<blockquote>&lt;img&gt;</blockquote>");
});

test("a table with no separator row still renders its body", () => {
  const { renderMarkdown } = load();
  assert.match(renderMarkdown("| a | b |\n| 1 | 2 |"), /<thead><tr><th>a<\/th><th>b<\/th><\/tr><\/thead><tbody><tr><td>1<\/td><td>2<\/td><\/tr><\/tbody>/);
});
