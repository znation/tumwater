/** A small, safe Markdown renderer for the dashboard, browser-side: the failure digest and the
 * backlog entries (PLANS/BUGS/QUESTIONS.md bodies) are Markdown the loops write, and reading
 * them as rendered headings, lists, and tables beats a pre-formatted text blob. It covers what
 * those files use — ATX headings, paragraphs, bullet and numbered lists (continuation lines
 * folded in), pipe tables with right-aligned columns, fenced code, block quotes, and inline
 * code/bold/italics — and nothing more. Every piece of source text passes through the page's
 * esc() before any tag is added, and links render as plain text, so model-written content can
 * never inject markup or a script URL. Spliced into gui-client.ts's script; it reaches esc
 * through that concatenation. */
export const GUI_CLIENT_MARKDOWN_JS = String.raw`  // markdown:start
  // Inline spans: code first (its text stays literal), then bold and italics on the rest. An
  // unmatched trailing backtick is kept as text rather than opening a runaway code span.
  function mdInline(s) {
    const parts = String(s).split("\x60");
    if (parts.length % 2 === 0) {
      const tail = parts.pop();
      parts[parts.length - 1] += "\x60" + tail;
    }
    return parts.map((part, i) => {
      // An empty span is a run of backticks in prose ("\x60\x60\x60python"), not code.
      if (i % 2 === 1) return part ? "<code>" + esc(part) + "</code>" : "\x60\x60";
      return esc(part)
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/(^|[\s(])\*([^*\s][^*]*?)\*(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>")
        .replace(/(^|[\s(])_([^_\s][^_]*?)_(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>");
    }).join("");
  }
  function mdTable(rows) {
    // Cells split at pipes that sit outside inline-code spans: the digest's tables quote
    // shell commands, and a pipeline's pipe is cell content, not a delimiter. Each run of
    // backticks toggles code state — one run opens a span, the next closes it, and a doubled
    // backtick is one run — so a quoted pipeline ("grep a|b") stays one cell while two
    // separately quoted cells ("a" and "b") still split.
    const cells = (r) => {
      const trimmed = r.trim().replace(/^\|/, "").replace(/\|$/, "");
      const out = [];
      let cell = "";
      let code = false;
      for (let i = 0; i < trimmed.length; i++) {
        const ch = trimmed[i];
        if (ch === "\x60") { code = !code; cell += ch; }
        else if (ch === "|" && !code) { out.push(cell.trim()); cell = ""; }
        else cell += ch;
      }
      out.push(cell.trim());
      return out;
    };
    const head = cells(rows[0]);
    let body = rows.slice(1);
    let align = [];
    if (body.length && /^[\s|:-]+$/.test(body[0]) && body[0].includes("-")) {
      align = cells(body[0]).map((c) => (/-:$/.test(c) ? "r" : ""));
      body = body.slice(1);
    }
    const cell = (tag, c, i) => "<" + tag + (align[i] ? " class='r'" : "") + ">" + mdInline(c) + "</" + tag + ">";
    return "<div class='table-wrap'><table><thead><tr>" + head.map((c, i) => cell("th", c, i)).join("") +
      "</tr></thead><tbody>" + body.map((r) => "<tr>" + cells(r).map((c, i) => cell("td", c, i)).join("") + "</tr>").join("") +
      "</tbody></table></div>";
  }
  function mdList(lines, i, marker, tag) {
    let html = "<" + tag + ">";
    while (i < lines.length && marker.test(lines[i])) {
      let item = lines[i].replace(marker, "");
      i++;
      // Indented continuation lines belong to the item above them.
      while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !marker.test(lines[i])) {
        item += " " + lines[i].trim();
        i++;
      }
      html += "<li>" + mdInline(item) + "</li>";
    }
    return { html: html + "</" + tag + ">", i };
  }
  // breaks: render single newlines inside a paragraph as line breaks — for generated text written
  // one fact per line (the failure digest), not for hand-wrapped prose.
  function renderMarkdown(src, breaks) {
    const lines = String(src || "").replace(/\r\n?/g, "\n").split("\n");
    const bullet = /^\s*[-*+]\s+/;
    const numbered = /^\s*\d+[.)]\s+/;
    const special = /^(#{1,6}\s|\s*[-*+]\s+|\s*\d+[.)]\s+|\s*\||\s*\x60\x60\x60|\s*>)/;
    let html = "";
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      const h = /^(#{1,6})\s+(.*)$/.exec(line);
      if (h) {
        const level = Math.min(6, h[1].length + 1); // the view's own title is the h1
        html += "<h" + level + ">" + mdInline(h[2]) + "</h" + level + ">";
        i++;
        continue;
      }
      if (/^\s*\x60\x60\x60/.test(line)) {
        const code = [];
        i++;
        while (i < lines.length && !/^\s*\x60\x60\x60/.test(lines[i])) { code.push(lines[i]); i++; }
        i++;
        html += "<pre><code>" + esc(code.join("\n")) + "</code></pre>";
        continue;
      }
      if (/^\s*\|/.test(line)) {
        const rows = [];
        while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(lines[i]); i++; }
        html += mdTable(rows);
        continue;
      }
      if (bullet.test(line) || numbered.test(line)) {
        const list = bullet.test(line) ? mdList(lines, i, bullet, "ul") : mdList(lines, i, numbered, "ol");
        html += list.html;
        i = list.i;
        continue;
      }
      if (/^\s*>/.test(line)) {
        const quote = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) { quote.push(lines[i].replace(/^\s*>\s?/, "")); i++; }
        html += "<blockquote>" + mdInline(quote.join(" ")) + "</blockquote>";
        continue;
      }
      const para = [];
      while (i < lines.length && lines[i].trim() && !special.test(lines[i])) { para.push(lines[i].trim()); i++; }
      html += "<p>" + para.map(mdInline).join(breaks ? "<br>" : " ") + "</p>";
    }
    return html;
  }
  // markdown:end`;
