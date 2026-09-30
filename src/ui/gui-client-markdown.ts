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
  // Inline spans: code first (its text stays literal), then bold and italics on the rest. A
  // code span opens at a run of backticks and closes at a run of the SAME length — a run of a
  // different length inside a span is content, so the doubled-backtick form that quotes a
  // literal backtick ("\x60\x60 \x60 \x60\x60") parses as one span whose code flag survives
  // both runs — and a run left open at the end is prose, not a runaway span. An empty span
  // renders as its backticks.
  function mdInline(s) {
    // Tokenize into text and backtick runs.
    const src = String(s);
    const toks = [];
    let text = "";
    for (let i = 0; i < src.length; ) {
      if (src[i] === "\x60") {
        let n = 0;
        while (i < src.length && src[i] === "\x60") { n++; i++; }
        if (text) { toks.push(["t", text]); text = ""; }
        toks.push(["b", n]);
      } else text += src[i++];
    }
    if (text) toks.push(["t", text]);
    // Match the runs: a same-length run closes the span; anything else inside it is content.
    const segs = [];
    let open = 0, buf = "";
    for (const tok of toks) {
      if (tok[0] === "t") { if (open) buf += tok[1]; else segs.push(["t", tok[1]]); }
      else if (!open) { open = tok[1]; buf = ""; }
      else if (tok[1] === open) { segs.push(["c", buf]); buf = ""; open = 0; }
      else buf += "\x60".repeat(tok[1]);
    }
    if (open) segs.push(["t", "\x60".repeat(open) + buf]); // Never closed: literal prose.
    return segs.map((seg) => {
      if (seg[0] === "c") {
        const body = seg[1].length > 1 && seg[1].startsWith(" ") && seg[1].endsWith(" ")
          ? seg[1].slice(1, -1) : seg[1];
        return body ? "<code>" + esc(body) + "</code>" : "\x60\x60";
      }
      return esc(seg[1])
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/(^|[\s(])\*([^*\s][^*]*?)\*(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>")
        .replace(/(^|[\s(])_([^_\s][^_]*?)_(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>");
    }).join("");
  }
  function mdTable(rows) {
    // Cells split at pipes that sit outside inline-code spans: the digest's tables quote
    // shell commands, and a pipeline's pipe is cell content, not a delimiter. A span opens at
    // a run of backticks and closes at a run of the SAME length (mdInline's rule), so a quoted
    // pipeline ("grep a|b") stays one cell, two separately quoted cells ("a" and "b") still
    // split, and a doubled-backtick span quoting a literal backtick ("\x60\x60 \x60 \x60\x60")
    // is closed by its own final run rather than swallowing the rest of the row.
    const cells = (r) => {
      const trimmed = r.trim().replace(/^\|/, "").replace(/\|$/, "");
      const out = [];
      let cell = "";
      let open = 0; // The opening run's length; 0 means outside a code span.
      for (let i = 0; i < trimmed.length; ) {
        if (trimmed[i] === "\x60") {
          let n = 0;
          while (i < trimmed.length && trimmed[i] === "\x60") { n++; i++; }
          if (open === 0) open = n;
          else if (n === open) open = 0; // A same-length run closes the span.
          cell += "\x60".repeat(n);
        } else {
          if (trimmed[i] === "|" && open === 0) { out.push(cell.trim()); cell = ""; }
          else cell += trimmed[i];
          i++;
        }
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
