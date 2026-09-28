# Local Markdown dependencies

The browser uses these local files; no CDN is contacted when displaying a note.

- `marked.umd.js`: Marked 18.0.14, MIT. Source: https://github.com/markedjs/marked and https://www.npmjs.com/package/marked/v/18.0.14
- `purify.min.js`: DOMPurify 3.4.16, Apache-2.0 or MPL-2.0. Source: https://github.com/cure53/DOMPurify and https://www.npmjs.com/package/dompurify/v/3.4.16

Fetched from the official npm packages with `npm pack --ignore-scripts`. The upstream license files are preserved here. Marked's documentation requires sanitizing its output; `markdown.js` uses DOMPurify with a narrow HTML allow list, renders raw HTML as text, checks link protocols, and never fetches external Markdown images. Only imported private raster images can be displayed through the `onepage:` references.
