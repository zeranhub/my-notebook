/* One-page notebook data model. Note bodies are Markdown text; image files
 * remain in the private repository and this document contains metadata only. */
(() => {
  "use strict";

  const DEFAULT_WIDTH = 794;
  const DEFAULT_HEIGHT = 1123;
  const MAX_PAGES = 100;
  const MAX_NOTES = 1000;
  const MAX_ASSETS = 3000;
  // Keep local drafts readable even when they exceed GitHub's smaller 1 MB
  // upload limit. The editor uses the same bound, so it cannot save a draft
  // that this model will reject on the next unlock.
  const MAX_CONTENT_LENGTH = 2_000_000;
  const MAX_COORDINATE = 100_000;
  const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/;
  const IMAGE_EXTENSIONS = Object.freeze({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" });

  function modelError(code, message) {
    const error = new Error(message);
    error.name = "OnePageModelError";
    error.code = code;
    return error;
  }

  function fail(code, message) { throw modelError(code, message); }
  function isRecord(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
  function validId(value) { return typeof value === "string" && ID_PATTERN.test(value); }
  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function timestamp() { return new Date().toISOString(); }

  function newId(prefix, used) {
    for (let attempt = 0; attempt < 16; attempt++) {
      const random = globalThis.crypto?.randomUUID?.().replace(/-/g, "")
        || `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
      const id = `${prefix}-${random}`;
      if (!used?.has(id)) return id;
    }
    fail("ID_COLLISION", "无法生成唯一标识。");
  }

  function dateOrNow(value, fallback) {
    if (typeof value === "string" && value.length <= 64) {
      const time = Date.parse(value);
      if (Number.isFinite(time)) return new Date(time).toISOString();
    }
    return fallback;
  }

  function pageDimension(value, label) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 200 || value > 5000) {
      fail("INVALID_PAGE_SIZE", `${label}须为 200 到 5000 之间的有限数字。`);
    }
    return value;
  }

  function position(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_COORDINATE
      ? value : null;
  }

  function size(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 1 && value <= MAX_COORDINATE
      ? value : null;
  }

  function contentScale(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0.25 && value <= 8
      ? value : 1;
  }

  function text(value, label, maxLength) {
    if (typeof value !== "string" || value.length > maxLength) {
      fail("INVALID_DATA", `${label}必须是长度不超过 ${maxLength} 的文字。`);
    }
    return value;
  }

  function legacyTags(value) {
    if (value === undefined || value === null) return undefined;
    if (!Array.isArray(value) || value.length > 20) fail("INVALID_DATA", "旧标签格式有误。");
    const tags = [];
    for (const tag of value) {
      if (typeof tag !== "string" || tag.length > 40) fail("INVALID_DATA", "旧标签格式有误。");
      const clean = tag.trim();
      if (clean && !tags.includes(clean)) tags.push(clean);
    }
    return tags.length ? tags : undefined;
  }

  function normalizeAssets(raw) {
    if (raw === undefined) return {};
    if (!isRecord(raw)) fail("INVALID_DATA", "图片目录格式有误。");
    const entries = Object.entries(raw);
    if (entries.length > MAX_ASSETS) fail("LIMIT_EXCEEDED", "图片数量超过上限。");
    const assets = {};
    for (const [id, item] of entries) {
      if (!validId(id) || ["constructor", "prototype", "__proto__"].includes(id) ||
          !isRecord(item) || item.id !== id) {
        fail("INVALID_ASSET", "图片标识有误。");
      }
      const extension = Object.hasOwn(IMAGE_EXTENSIONS, item.mime) ? IMAGE_EXTENSIONS[item.mime] : null;
      if (!extension || item.path !== `assets/${id}.${extension}`) {
        fail("INVALID_ASSET", "图片格式或私有仓库路径有误。");
      }
      if (![item.width, item.height].every(value => Number.isInteger(value) && value >= 1 && value <= 30_000)) {
        fail("INVALID_ASSET", "图片尺寸有误。");
      }
      assets[id] = { id, path: item.path, mime: item.mime, width: item.width, height: item.height,
        name: item.name === undefined ? id : text(item.name, "图片名称", 255) };
    }
    return assets;
  }

  function mergeAssets(...dictionaries) {
    const assets = {};
    for (const dictionary of dictionaries) {
      for (const [id, asset] of Object.entries(dictionary)) {
        if (Object.hasOwn(assets, id) && JSON.stringify(assets[id]) !== JSON.stringify(asset)) {
          fail("ASSET_CONFLICT", "同一图片标识对应了不同文件，请重新插入该图片。");
        }
        assets[id] = clone(asset);
      }
    }
    if (Object.keys(assets).length > MAX_ASSETS) fail("LIMIT_EXCEEDED", "合并后的图片数量超过上限。");
    return assets;
  }

  function normalizePage(raw, index) {
    if (!isRecord(raw) || !validId(raw.id)) fail("INVALID_DATA", `第 ${index + 1} 页的标识有误。`);
    const now = timestamp();
    const name = text(raw.name, "页面名称", 100).trim() || `第 ${index + 1} 页`;
    const page = {
      id: raw.id,
      name,
      width: pageDimension(raw.width, "页面宽度"),
      height: pageDimension(raw.height, "页面高度"),
      createdAt: dateOrNow(raw.createdAt, now),
      updatedAt: dateOrNow(raw.updatedAt, now)
    };
    if (validId(raw.conflictOf)) page.conflictOf = raw.conflictOf;
    return page;
  }

  function normalizeNewNote(raw, index, pageIds, fallbackPageId) {
    if (!isRecord(raw) || !validId(raw.id)) fail("INVALID_DATA", `第 ${index + 1} 条笔记的标识有误。`);
    const now = timestamp();
    const note = {
      id: raw.id,
      pageId: pageIds.has(raw.pageId) ? raw.pageId : fallbackPageId,
      content: text(raw.content, "笔记正文", MAX_CONTENT_LENGTH),
      contentScale: contentScale(raw.contentScale),
      x: position(raw.x),
      y: position(raw.y),
      w: size(raw.w),
      h: size(raw.h),
      manualSize: raw.manualSize === true,
      manualPosition: raw.manualPosition === true,
      createdAt: dateOrNow(raw.createdAt, now),
      updatedAt: dateOrNow(raw.updatedAt, now)
    };
    if (validId(raw.conflictOf)) note.conflictOf = raw.conflictOf;
    const tags = legacyTags(raw.legacyTags);
    if (tags) note.legacyTags = tags;
    return note;
  }

  function legacyContent(title, content) {
    // A former title field becomes one literal text line. The renderer, not
    // this model, is responsible for escaping it when displaying HTML.
    const cleanTitle = title.replace(/[\r\n\u0000-\u001f\u007f]+/g, " ").trim();
    if (!cleanTitle) return content;
    const firstLine = content.replace(/\r\n?/g, "\n").split("\n").find(line => line.trim())?.trim() || "";
    const headingText = firstLine.replace(/^#{1,6}\s+/, "").trim();
    if (firstLine === cleanTitle || headingText === cleanTitle) return content;
    return content ? `${cleanTitle}\n\n${content}` : cleanTitle;
  }

  function parseLegacy(rawNotes) {
    if (!Array.isArray(rawNotes) || rawNotes.length > MAX_NOTES) {
      fail("LIMIT_EXCEEDED", "旧笔记数量超过上限。" );
    }
    const page = {
      id: "page-1", name: "第 1 页", width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT,
      createdAt: timestamp(), updatedAt: timestamp()
    };
    const used = new Set();
    const notes = rawNotes.map((raw, index) => {
      if (!isRecord(raw)) fail("INVALID_DATA", `第 ${index + 1} 条旧笔记格式有误。`);
      const title = raw.title === undefined ? "" : text(raw.title, "旧笔记标题", 160);
      const body = raw.content === undefined ? "" : text(raw.content, "旧笔记正文", MAX_CONTENT_LENGTH);
      const content = legacyContent(title, body);
      if (content.length > MAX_CONTENT_LENGTH) fail("LIMIT_EXCEEDED", "标题迁移后的笔记超过长度上限。");
      let id = validId(raw.id) && !used.has(raw.id) ? raw.id : `legacy-note-${index + 1}`;
      while (used.has(id)) id = `${id}-copy`;
      used.add(id);
      const now = timestamp();
      const note = {
        id, pageId: page.id, content,
        contentScale: 1,
        x: null, y: null, w: null, h: null,
        manualSize: false, manualPosition: false,
        createdAt: dateOrNow(raw.createdAt, now),
        updatedAt: dateOrNow(raw.updatedAt, now)
      };
      const tags = legacyTags(raw.tags);
      if (tags) note.legacyTags = tags;
      return note;
    });
    return { version: 2, pages: [page], notes, assets: {}, activePageId: page.id, migrated: true };
  }

  function parse(raw) {
    let value = raw;
    if (typeof value === "string") {
      if (value.length > 20_000_000) fail("LIMIT_EXCEEDED", "笔记文件过大。");
      try { value = JSON.parse(value); }
      catch { fail("INVALID_DATA", "笔记文件不是有效的 JSON。"); }
    }
    if (Array.isArray(value)) return parseLegacy(value);
    if (!isRecord(value)) fail("INVALID_DATA", "笔记文件格式有误。");
    if (value.version === 1) return parseLegacy(value.notes);
    if (value.version !== 2 || !Array.isArray(value.pages) || !Array.isArray(value.notes)) {
      fail("INVALID_DATA", "笔记文件版本或结构有误。");
    }
    if (value.pages.length > MAX_PAGES || value.notes.length > MAX_NOTES) {
      fail("LIMIT_EXCEEDED", "页面或笔记数量超过上限。");
    }
    const pages = value.pages.length
      ? value.pages.map(normalizePage)
      : [{ id: "page-1", name: "第 1 页", width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT,
        createdAt: timestamp(), updatedAt: timestamp() }];
    const pageIds = new Set(pages.map(page => page.id));
    if (pageIds.size !== pages.length) fail("INVALID_DATA", "页面标识重复。");
    const notes = value.notes.map((note, index) => normalizeNewNote(note, index, pageIds, pages[0].id));
    if (new Set(notes.map(note => note.id)).size !== notes.length) fail("INVALID_DATA", "笔记标识重复。");
    const activePageId = pageIds.has(value.activePageId) ? value.activePageId : pages[0].id;
    return { version: 2, pages, notes, assets: normalizeAssets(value.assets), activePageId, migrated: false };
  }

  function createPage(index, width = DEFAULT_WIDTH, height = DEFAULT_HEIGHT) {
    if (!Number.isInteger(index) || index < 0 || index >= MAX_PAGES) {
      fail("INVALID_INDEX", "页面序号超出范围。");
    }
    if (isRecord(width)) {
      height = width.height;
      width = width.width;
    }
    const now = timestamp();
    return {
      id: newId("page"), name: `第 ${index + 1} 页`,
      width: pageDimension(width, "页面宽度"),
      height: pageDimension(height, "页面高度"),
      createdAt: now, updatedAt: now
    };
  }

  function createNote(pageId) {
    if (!validId(pageId)) fail("INVALID_PAGE_ID", "笔记所属页面标识有误。");
    const now = timestamp();
    return {
      id: newId("note"), pageId, content: "",
      contentScale: 1,
      x: null, y: null, w: null, h: null,
      manualSize: false, manualPosition: false,
      createdAt: now, updatedAt: now
    };
  }

  function signature(item, kind) {
    if (!item) return null;
    return kind === "page"
      ? JSON.stringify([item.name, item.width, item.height, item.conflictOf ?? null])
      : JSON.stringify([item.pageId, item.content, item.contentScale, item.x, item.y, item.w, item.h,
        item.manualSize, item.manualPosition, item.conflictOf ?? null, item.legacyTags ?? null]);
  }

  function mergeCollection(baseItems, localItems, remoteItems, kind) {
    const base = new Map(baseItems.map(item => [item.id, item]));
    const local = new Map(localItems.map(item => [item.id, item]));
    const remote = new Map(remoteItems.map(item => [item.id, item]));
    const allIds = new Set([...remote.keys(), ...local.keys(), ...base.keys()]);
    const used = new Set(allIds);
    const output = [];
    const replacements = {};
    let conflicts = 0;
    for (const id of allIds) {
      const old = base.get(id);
      const mine = local.get(id);
      const theirs = remote.get(id);
      const myChanged = signature(mine, kind) !== signature(old, kind);
      const theirChanged = signature(theirs, kind) !== signature(old, kind);
      if (!myChanged) {
        if (theirs) output.push(clone(theirs));
      } else if (!theirChanged || signature(mine, kind) === signature(theirs, kind)) {
        if (mine) output.push(clone(mine));
      } else {
        conflicts++;
        if (theirs) output.push(clone(theirs));
        if (mine) {
          const duplicate = clone(mine);
          duplicate.id = newId(kind, used);
          duplicate.conflictOf = id;
          duplicate.updatedAt = timestamp();
          used.add(duplicate.id);
          output.push(duplicate);
          replacements[id] = duplicate.id;
        }
      }
    }
    return { items: output, conflicts, replacements };
  }

  function merge(baseRaw, localRaw, remoteRaw) {
    const base = parse(baseRaw);
    const local = parse(localRaw);
    const remote = parse(remoteRaw);
    const pageResult = mergeCollection(base.pages, local.pages, remote.pages, "page");
    const noteResult = mergeCollection(base.notes, local.notes, remote.notes, "note");
    const pages = pageResult.items;
    const notes = noteResult.items;
    const pageIds = new Set(pages.map(page => page.id));
    const pageSources = new Map([...base.pages, ...local.pages, ...remote.pages].map(page => [page.id, page]));
    const localCopyIds = new Set(Object.values(noteResult.replacements));

    for (const note of notes) {
      const copyPageId = pageResult.replacements[note.pageId];
      if (copyPageId && (!pageIds.has(note.pageId) || localCopyIds.has(note.id))) {
        note.pageId = copyPageId;
      }
      if (!pageIds.has(note.pageId)) {
        const original = pageSources.get(note.pageId);
        if (original) {
          pages.push(clone(original));
          pageIds.add(original.id);
        } else {
          note.pageId = pages[0]?.id || "page-1";
        }
      }
    }

    if (!pages.length) {
      pages.push({ id: "page-1", name: "第 1 页", width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT,
        createdAt: timestamp(), updatedAt: timestamp() });
      pageIds.add("page-1");
    }
    if (pages.length > MAX_PAGES || notes.length > MAX_NOTES) {
      fail("LIMIT_EXCEEDED", "合并后的页面或笔记数量超过上限，请先手动整理。");
    }
    const requestedActive = pageResult.replacements[local.activePageId] || local.activePageId;
    const activePageId = pageIds.has(requestedActive) ? requestedActive
      : pageIds.has(remote.activePageId) ? remote.activePageId : pages[0].id;
    return {
      data: { version: 2, pages, notes, assets: mergeAssets(base.assets, local.assets, remote.assets), activePageId },
      conflicts: pageResult.conflicts + noteResult.conflicts,
      replacements: noteResult.replacements
    };
  }

  const api = Object.freeze({ parse, merge, createPage, createNote });
  if (typeof window !== "undefined") window.OnePageModel = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
