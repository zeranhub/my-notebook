/* Finite paper formats. Logical pixels use 96 dpi; millimetres remain exact
 * so rounded screen dimensions never turn an A4 export into another size. */
(() => {
  "use strict";
  const PIXELS_PER_MM = 96 / 25.4;
  const MIN_PIXELS = 200, MAX_PIXELS = 5000;
  const MIN_MM = MIN_PIXELS / PIXELS_PER_MM, MAX_MM = MAX_PIXELS / PIXELS_PER_MM;
  const SIZE_FIELDS = Object.freeze(["width", "height", "paperWidthMm", "paperHeightMm", "paperPreset"]);
  const presets = Object.freeze([
    { id: "a3", label: "A3", widthMm: 297, heightMm: 420, kind: "standard" },
    { id: "a4", label: "A4", widthMm: 210, heightMm: 297, kind: "standard" },
    { id: "a5", label: "A5", widthMm: 148, heightMm: 210, kind: "standard" },
    { id: "a6", label: "A6", widthMm: 105, heightMm: 148, kind: "standard" },
    { id: "b5", label: "B5", widthMm: 176, heightMm: 250, kind: "standard" },
    { id: "letter", label: "Letter", widthMm: 215.9, heightMm: 279.4, kind: "standard" },
    { id: "legal", label: "Legal", widthMm: 215.9, heightMm: 355.6, kind: "standard" },
    { id: "square", label: "1:1", widthMm: 210, heightMm: 210, kind: "ratio" },
    { id: "4:3", label: "4:3", widthMm: 210, heightMm: 280, kind: "ratio" },
    { id: "16:9", label: "16:9", widthMm: 210, heightMm: 210 * 16 / 9, kind: "ratio" },
    { id: "3:2", label: "3:2", widthMm: 210, heightMm: 315, kind: "ratio" },
    { id: "custom", label: "自定义", widthMm: 210, heightMm: 297, kind: "custom" }
  ].map(item => Object.freeze(item)));
  const colors = Object.freeze([
    { id: "white", label: "白色", value: "#ffffff" },
    { id: "natural", label: "纸张原色", value: "#f3ead3" },
    { id: "cream", label: "米色", value: "#faf4e8" },
    { id: "gray", label: "浅灰", value: "#f1f2f3" },
    { id: "green", label: "浅绿", value: "#edf4ed" },
    { id: "blue", label: "浅蓝", value: "#edf3fa" }
  ].map(item => Object.freeze(item)));
  const byId = new Map(presets.map(item => [item.id, item]));

  function invalid(code, message) {
    const error = new Error(message);
    error.name = "OnePagePaperError"; error.code = code;
    throw error;
  }
  function color(value = "#ffffff") {
    if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)) {
      invalid("INVALID_PAPER_COLOR", "纸张底色须为有效的六位颜色值，例如 #f3ead3。");
    }
    return value.toLowerCase();
  }
  function dimension(value, label) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < MIN_PIXELS || value > MAX_PIXELS) {
      invalid("INVALID_PAGE_SIZE", `${label}须为 200 到 5000 之间的有限数字。`);
    }
    return value;
  }
  function millimetres(value) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < MIN_MM || value > MAX_MM) {
      invalid("INVALID_PAGE_SIZE", "纸张宽高须为约 52.92 到 1322.92 毫米之间的有限数字。");
    }
    return value;
  }
  function matches(preset, widthMm, heightMm) {
    const small = Math.min(widthMm, heightMm), large = Math.max(widthMm, heightMm);
    return Math.abs(small - preset.widthMm) < 0.00001 && Math.abs(large - preset.heightMm) < 0.00001;
  }

  function normalize(page = {}) {
    const width = dimension(page.width === undefined ? 794 : page.width, "页面宽度");
    const height = dimension(page.height === undefined ? 1123 : page.height, "页面高度");
    const hasWidthMm = page.paperWidthMm !== undefined, hasHeightMm = page.paperHeightMm !== undefined;
    if (hasWidthMm !== hasHeightMm) invalid("INVALID_PAGE_SIZE", "纸张毫米宽高必须一起保存。");
    let paperWidthMm, paperHeightMm;
    if (hasWidthMm) {
      paperWidthMm = millimetres(page.paperWidthMm);
      paperHeightMm = millimetres(page.paperHeightMm);
      if (Math.abs(paperWidthMm * PIXELS_PER_MM - width) > 0.500001 ||
          Math.abs(paperHeightMm * PIXELS_PER_MM - height) > 0.500001) {
        invalid("INVALID_PAGE_SIZE", "纸张毫米宽高与画布尺寸不一致。");
      }
    } else if (width === 794 && height === 1123 || width === 1123 && height === 794) {
      paperWidthMm = width < height ? 210 : 297;
      paperHeightMm = width < height ? 297 : 210;
    } else {
      // An older custom canvas remains exactly its original size.
      paperWidthMm = width / PIXELS_PER_MM;
      paperHeightMm = height / PIXELS_PER_MM;
    }
    const requested = byId.get(page.paperPreset);
    const inferred = requested && requested.kind !== "custom" && matches(requested, paperWidthMm, paperHeightMm)
      ? requested : presets.find(item => item.kind !== "custom" && matches(item, paperWidthMm, paperHeightMm));
    const paperPreset = page.paperPreset === "custom" ? "custom" : inferred?.id || "custom";
    return { width, height, paperWidthMm, paperHeightMm, paperPreset, paperColor: color(page.paperColor) };
  }

  function resolve(page = {}) {
    const settings = normalize(page);
    return { ...settings, orientation: settings.width > settings.height ? "landscape" : "portrait" };
  }

  function createSettings({ preset = "a4", orientation = "portrait", widthMm, heightMm,
    color: selectedColor = "#ffffff" } = {}) {
    const format = byId.get(preset);
    if (!format) invalid("INVALID_PAPER_PRESET", "请选择有效的纸张类型。");
    if (!["portrait", "landscape"].includes(orientation)) {
      invalid("INVALID_PAPER_ORIENTATION", "请选择横版或竖版。");
    }
    let first = format.kind === "custom" ? millimetres(widthMm) : format.widthMm;
    let second = format.kind === "custom" ? millimetres(heightMm) : format.heightMm;
    const small = Math.min(first, second), large = Math.max(first, second);
    first = orientation === "landscape" ? large : small;
    second = orientation === "landscape" ? small : large;
    return normalize({ width: Math.round(first * PIXELS_PER_MM), height: Math.round(second * PIXELS_PER_MM),
      paperWidthMm: first, paperHeightMm: second, paperPreset: preset, paperColor: selectedColor });
  }

  const api = Object.freeze({ presets, colors, resolve, normalize, createSettings,
    sizeFields: SIZE_FIELDS, minMm: MIN_MM, maxMm: MAX_MM, pixelsPerMm: PIXELS_PER_MM });
  if (typeof window !== "undefined") window.OnePagePaper = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
