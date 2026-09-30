(() => {
  "use strict";

  // The paper is copied at its logical size, independently of the viewing zoom.
  // SVG foreignObject asks the browser to paint the same HTML/CSS and system
  // fonts used by the notebook. Images are embedded before rendering, so the
  // export stays local and also works with already loaded private image blobs.
  const UI_ONLY = ".drag-handle,.width-handle,.resize-handle,.touch-edge-handle,.conflict-badge,[data-export-ignore]";
  const PAGE_WIDTH = 794, PAGE_HEIGHT = 1123;
  const DEFAULT_SCALE = 3;
  const MAX_PIXELS = 20000000;

  function assertCurrent(isCurrent) {
    if (typeof isCurrent === "function" && !isCurrent()) throw new DOMException("导出已取消。", "AbortError");
  }

  function dimensions(page) {
    const paper = window.OnePagePaper?.resolve(page);
    const width = Number(paper?.width ?? page?.width) || PAGE_WIDTH, height = Number(paper?.height ?? page?.height) || PAGE_HEIGHT;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1 || width > 5000 || height > 5000) {
      throw new Error("纸张尺寸无效，无法导出。");
    }
    const legacyA4 = width === PAGE_WIDTH && height === PAGE_HEIGHT;
    const legacyLandscapeA4 = width === PAGE_HEIGHT && height === PAGE_WIDTH;
    const paperWidthMm = Number(paper?.paperWidthMm ?? page?.paperWidthMm) || (legacyA4 ? 210 : legacyLandscapeA4 ? 297 : width * 25.4 / 96);
    const paperHeightMm = Number(paper?.paperHeightMm ?? page?.paperHeightMm) || (legacyA4 ? 297 : legacyLandscapeA4 ? 210 : height * 25.4 / 96);
    if (!Number.isFinite(paperWidthMm) || !Number.isFinite(paperHeightMm) || paperWidthMm <= 0 || paperHeightMm <= 0) {
      throw new Error("纸张尺寸无效，无法导出。");
    }
    const candidateColor = paper?.paperColor ?? page?.paperColor;
    const paperColor = /^#[0-9a-f]{6}$/i.test(candidateColor) ? candidateColor : "#ffffff";
    return { width, height, paperWidthMm, paperHeightMm, paperColor };
  }

  function resolution(width, height, scale) {
    scale = Number(scale);
    if (!Number.isFinite(scale) || scale < 1 || scale > 4) throw new Error("导出分辨率无效，请选择 1 至 4 倍分辨率。");
    // Large papers keep their full content. Lower the raster resolution rather
    // than allocating an unbounded canvas or rejecting a valid paper format.
    const safeScale = Math.min(scale, Math.sqrt(MAX_PIXELS / (width * height)));
    return { outputWidth: Math.max(1, Math.floor(width * safeScale)), outputHeight: Math.max(1, Math.floor(height * safeScale)) };
  }

  function imageData(image) {
    if (!image.complete || !image.naturalWidth || !image.naturalHeight) {
      throw new Error("纸张上的图片尚未加载完成，请稍后再导出。");
    }
    const buffer = document.createElement("canvas");
    buffer.width = image.naturalWidth;
    buffer.height = image.naturalHeight;
    try {
      buffer.getContext("2d").drawImage(image, 0, 0);
      return buffer.toDataURL("image/png");
    } catch {
      throw new Error("图片暂时无法导出，请重新加载该图片后重试。");
    } finally {
      buffer.width = buffer.height = 0;
    }
  }

  function clonePaintedNode(source) {
    if (source.nodeType === Node.TEXT_NODE) return document.createTextNode(source.nodeValue || "");
    if (source.nodeType !== Node.ELEMENT_NODE || source.matches(UI_ONLY)) return null;
    const computed = getComputedStyle(source);
    if (computed.display === "none" || computed.visibility === "hidden") return null;
    const copy = source.cloneNode(false);
    for (const attribute of [...copy.attributes]) {
      if (/^on/i.test(attribute.name) || ["id", "tabindex", "srcset", "loading", "draggable"].includes(attribute.name)) copy.removeAttribute(attribute.name);
    }
    // Computed styles contain physical *and* logical aliases. Keep physical
    // values: serializing a later logical border alias would otherwise restore
    // a selection border after we explicitly made borderColor transparent.
    for (const property of computed) {
      if (/^(?:(?:min|max)-)?(?:block|inline)-|^(?:border|inset|margin|padding|overflow|overscroll-behavior|scroll-(?:padding|margin))-(?:block|inline)(?:-|$)/.test(property)) continue;
      copy.style.setProperty(property, computed.getPropertyValue(property));
    }
    copy.style.setProperty("animation", "none");
    copy.style.setProperty("transition", "none");
    copy.style.setProperty("caret-color", "transparent");
    if (source.matches(".note-card")) {
      copy.style.borderColor = "transparent";
      copy.style.outline = "none";
      copy.style.boxShadow = "none";
    }
    if (source.tagName === "IMG") {
      copy.setAttribute("src", imageData(source));
      copy.removeAttribute("crossorigin");
    }
    if (source.tagName === "INPUT" && source.type === "checkbox") {
      copy.toggleAttribute("checked", source.checked);
    }
    for (const child of source.childNodes) {
      const cloned = clonePaintedNode(child);
      if (cloned) copy.append(cloned);
    }
    return copy;
  }

  function loadSvg(source) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      const timer = setTimeout(() => { image.src = ""; reject(new Error("纸张导出超时，请缩小图片后再试。")); }, 20000);
      image.onload = () => { clearTimeout(timer); resolve(image); };
      image.onerror = () => { clearTimeout(timer); reject(new Error("此浏览器暂时无法生成纸张图片，请使用新版 Chrome 或 Edge。")); };
      // A data URL gives the SVG no external dependencies and keeps its canvas
      // readable. A blob SVG with foreignObject can taint a Chromium canvas.
      image.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(source);
    });
  }

  async function render({ canvas, page, scale = DEFAULT_SCALE, isCurrent } = {}) {
    assertCurrent(isCurrent);
    if (!(canvas instanceof Element) || !canvas.isConnected) throw new Error("请先打开要导出的纸张。");
    const { width, height, paperColor } = dimensions(page);
    const { outputWidth, outputHeight } = resolution(width, height, scale);
    if (document.fonts?.ready) await document.fonts.ready;
    assertCurrent(isCurrent);
    for (const slot of canvas.querySelectorAll("[data-onepage-asset]")) {
      const image = slot.querySelector("img");
      if (!image?.complete || !image.naturalWidth) throw new Error("纸张上的图片尚未加载完成，请稍后再导出。");
    }
    const copy = clonePaintedNode(canvas);
    Object.assign(copy.style, { position: "relative", inset: "auto", left: "auto", top: "auto", width: `${width}px`, height: `${height}px`,
      margin: "0", transform: "none", transformOrigin: "top left", overflow: "hidden", background: paperColor, border: "0", outline: "none" });
    copy.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
    const markup = new XMLSerializer().serializeToString(copy);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${outputWidth}" height="${outputHeight}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none"><foreignObject x="0" y="0" width="${width}" height="${height}">${markup}</foreignObject></svg>`;
    const image = await loadSvg(svg);
    assertCurrent(isCurrent);
    const output = document.createElement("canvas");
    output.width = outputWidth;
    output.height = outputHeight;
    const context = output.getContext("2d", { alpha: false });
    if (!context) throw new Error("此浏览器无法创建导出图片。");
    context.fillStyle = paperColor;
    context.fillRect(0, 0, output.width, output.height);
    context.drawImage(image, 0, 0, output.width, output.height);
    return output;
  }

  function canvasBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("无法生成导出文件，请重试。")), type, quality));
  }

  function pdfFromJpeg(bytes, width, height, paper) {
    // ISO 32000-1:2008, sections 7.5 (file structure), 8.9 (image XObjects),
    // and 14.11.2 (page boundaries). One PDF point is 1/72 inch; the MediaBox
    // comes from the chosen paper's physical dimensions. The JPEG fills that
    // page, so landscape and custom papers keep their actual aspect ratio.
    const encoder = new TextEncoder();
    const chunks = [], offsets = [0];
    let length = 0;
    const append = value => { const chunk = typeof value === "string" ? encoder.encode(value) : value; chunks.push(chunk); length += chunk.length; };
    const object = (id, body) => { offsets[id] = length; append(`${id} 0 obj\n${body}\nendobj\n`); };
    const pageWidth = paper.paperWidthMm * 72 / 25.4, pageHeight = paper.paperHeightMm * 72 / 25.4;
    append("%PDF-1.4\n");
    append(new Uint8Array([37, 226, 227, 207, 211, 10]));
    object(1, "<< /Type /Catalog /Pages 2 0 R >>");
    object(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
    object(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth.toFixed(6)} ${pageHeight.toFixed(6)}] /Resources << /XObject << /Paper 4 0 R >> >> /Contents 5 0 R >>`);
    offsets[4] = length;
    append(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${bytes.length} >>\nstream\n`);
    append(bytes);
    append("\nendstream\nendobj\n");
    const commands = `q\n${pageWidth.toFixed(6)} 0 0 ${pageHeight.toFixed(6)} 0 0 cm\n/Paper Do\nQ\n`;
    object(5, `<< /Length ${encoder.encode(commands).length} >>\nstream\n${commands}endstream`);
    const crossReference = length;
    append("xref\n0 6\n0000000000 65535 f \n");
    for (let id = 1; id <= 5; id++) append(`${String(offsets[id]).padStart(10, "0")} 00000 n \n`);
    append(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${crossReference}\n%%EOF\n`);
    return new Blob(chunks, { type: "application/pdf" });
  }

  async function toBlob(options = {}) {
    assertCurrent(options.isCurrent);
    const format = String(options.format || "png").toLowerCase();
    if (!["png", "pdf"].includes(format)) throw new Error("请选择 PNG 或 PDF 格式。");
    const paper = dimensions(options.page);
    const output = await render({ ...options, page: paper });
    try {
      assertCurrent(options.isCurrent);
      if (format === "png") {
        const png = await canvasBlob(output, "image/png");
        assertCurrent(options.isCurrent);
        return png;
      }
      const jpeg = await canvasBlob(output, "image/jpeg", .98);
      assertCurrent(options.isCurrent);
      const bytes = new Uint8Array(await jpeg.arrayBuffer());
      assertCurrent(options.isCurrent);
      return pdfFromJpeg(bytes, output.width, output.height, paper);
    } finally {
      output.width = output.height = 0;
    }
  }

  function filename(value, format) {
    return `${String(value || "一页纸").replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_").trim().slice(0, 100) || "一页纸"}.${format}`;
  }

  async function download(options = {}) {
    assertCurrent(options.isCurrent);
    const format = String(options.format || "png").toLowerCase();
    const blob = await toBlob({ ...options, format });
    assertCurrent(options.isCurrent);
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename(options.filename || options.page?.name, format);
    let downloaded = false;
    try {
      document.body.append(link);
      assertCurrent(options.isCurrent);
      link.click();
      downloaded = true;
    } finally {
      link.remove();
      if (downloaded) setTimeout(() => URL.revokeObjectURL(url), 60000);
      else URL.revokeObjectURL(url);
    }
    return { filename: link.download, format, size: blob.size };
  }

  window.OnePageExport = Object.freeze({ render, toBlob, download });
})();
