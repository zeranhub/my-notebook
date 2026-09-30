/* Literal search over the unlocked notebook. Results never rewrite note bodies. */
(() => {
  "use strict";

  const MAX_TERMS = 32;
  const MAX_QUERY_LENGTH = 2000;
  const MAX_MATCHES = 500;

  function terms(query) {
    if (typeof query !== "string") return [];
    if (query.length > MAX_QUERY_LENGTH) throw new RangeError("搜索内容不能超过 2000 个字符。");
    const unique = [];
    const seen = new Set();
    for (const term of query.trim().split(/\s+/u)) {
      if (!term) continue;
      const key = term.toLocaleLowerCase("en-US");
      if (!seen.has(key)) { seen.add(key); unique.push(term); }
    }
    if (unique.length > MAX_TERMS) throw new RangeError("一次搜索不能超过 32 个关键词。");
    return unique;
  }

  function pattern(term, global = false) {
    return new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), global ? "giu" : "iu");
  }

  function queryPatterns(query) {
    const words = Array.isArray(query) ? query : terms(query);
    return words.filter(word => typeof word === "string" && word).map(word => pattern(word));
  }

  function matches(text, patterns) {
    return patterns.map(regex => regex.test(text));
  }

  function matchLimit(value, fallback = MAX_MATCHES) {
    return Number.isFinite(value) ? Math.max(0, Math.min(MAX_MATCHES, Math.floor(value))) : fallback;
  }

  function findMatches(text, query, { limit = MAX_MATCHES } = {}) {
    if (typeof text !== "string" || !text) return [];
    const words = Array.isArray(query) ? query : terms(query);
    const bound = matchLimit(limit);
    if (!bound) return [];
    const found = [];
    for (const word of words) {
      if (typeof word !== "string" || !word) continue;
      const regex = pattern(word, true);
      let count = 0;
      let match;
      while (count < bound && (match = regex.exec(text))) {
        found.push({ start: match.index, end: match.index + match[0].length });
        count++;
        // Advance one code point, allowing overlapping words such as "ana"
        // in "banana" without ever splitting a surrogate pair.
        const codePoint = text.codePointAt(match.index);
        regex.lastIndex = match.index + (codePoint > 0xffff ? 2 : 1);
      }
    }
    found.sort((a, b) => a.start - b.start || b.end - a.end);
    const merged = [];
    for (const range of found) {
      const previous = merged[merged.length - 1];
      if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
      else merged.push({ ...range });
    }
    return merged.slice(0, bound);
  }

  function excerpt(body, ranges, length = 160) {
    if (!body) return { snippet: "", snippetStart: 0, snippetEnd: 0, snippetBefore: false, snippetAfter: false };
    const first = ranges[0]?.start ?? 0;
    // Match positions are UTF-16 offsets, while the excerpt budget counts
    // visible Unicode code points so an emoji is kept intact. Walk only the
    // excerpt itself, keeping even a large note cheap to display in results.
    let snippetStart = first;
    for (let count = 0; count < 40 && snippetStart > 0; count++) {
      snippetStart--;
      const code = body.charCodeAt(snippetStart);
      if (code >= 0xdc00 && code <= 0xdfff && snippetStart > 0) snippetStart--;
    }
    let snippetEnd = snippetStart;
    for (let count = 0; count < length && snippetEnd < body.length; count++) {
      snippetEnd += body.codePointAt(snippetEnd) > 0xffff ? 2 : 1;
    }
    const snippet = body.slice(snippetStart, snippetEnd);
    return { snippet, snippetStart, snippetEnd, snippetBefore: snippetStart > 0, snippetAfter: snippetEnd < body.length };
  }

  function search(state, query, { limit = 100 } = {}) {
    const words = terms(query);
    const results = [];
    let total = 0;
    const bound = Number.isFinite(limit) ? Math.max(0, Math.min(1000, Math.floor(limit))) : 100;
    if (!words.length) return { results, total, truncated: false, terms: words };
    const patterns = queryPatterns(words);
    const pages = Array.isArray(state?.pages) ? state.pages : [];
    const notes = Array.isArray(state?.notes) ? state.notes : [];
    const pageMap = new Map();
    const pageHits = new Map();
    for (const page of pages) {
      if (!page || typeof page.id !== "string") continue;
      const pageName = typeof page.name === "string" ? page.name : "";
      const hits = matches(pageName, patterns);
      pageMap.set(page.id, { pageId: page.id, pageName });
      pageHits.set(page.id, hits);
      if (!hits.every(Boolean)) continue;
      total++;
      if (results.length < bound) results.push({
        kind: "page", noteId: null, pageId: page.id, pageName,
        body: "", bodyMatches: [], pageMatches: findMatches(pageName, words),
        ...excerpt("", [])
      });
    }
    for (const note of notes) {
      if (!note || typeof note.id !== "string" || typeof note.content !== "string") continue;
      const page = pageMap.get(note.pageId);
      if (!page) continue;
      const bodyHits = matches(note.content, patterns);
      const titleHits = pageHits.get(note.pageId);
      // A page-name-only hit appears once as a page result. A note result
      // must match at least one word in its own full Markdown body.
      if (!bodyHits.some(Boolean) || !bodyHits.every((hit, index) => hit || titleHits[index])) continue;
      total++;
      if (results.length >= bound) continue;
      const bodyMatches = findMatches(note.content, words);
      results.push({
        kind: "note", noteId: note.id, ...page, body: note.content,
        bodyMatches, pageMatches: findMatches(page.pageName, words),
        ...excerpt(note.content, bodyMatches)
      });
    }
    return { results, total, truncated: total > results.length, terms: words };
  }

  function highlight(element, text, query) {
    if (!element?.ownerDocument || typeof element.replaceChildren !== "function") {
      throw new TypeError("高亮需要一个有效的页面元素。");
    }
    const value = typeof text === "string" ? text : String(text ?? "");
    const ranges = findMatches(value, query);
    const doc = element.ownerDocument;
    const fragment = doc.createDocumentFragment();
    let previous = 0;
    for (const range of ranges) {
      if (range.start > previous) fragment.appendChild(doc.createTextNode(value.slice(previous, range.start)));
      const mark = doc.createElement("mark");
      mark.textContent = value.slice(range.start, range.end);
      fragment.appendChild(mark);
      previous = range.end;
    }
    if (previous < value.length) fragment.appendChild(doc.createTextNode(value.slice(previous)));
    element.replaceChildren(fragment);
    return ranges.length;
  }

  window.OnePageSearch = Object.freeze({ search, highlight, findMatches, terms });
})();
