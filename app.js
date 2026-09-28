(() => {
  "use strict";

  const PAPER_WIDTH = 794;
  const PAPER_HEIGHT = 1123;
  const LEGACY_STORAGE_KEY = "personal-notebook-v1";
  const $ = id => document.getElementById(id);
  const ui = {
    pageTabs: $("pageTabs"), addPageButton: $("addPageButton"), renamePageButton: $("renamePageButton"),
    newNoteButton: $("newNoteButton"), canvasViewport: $("canvasViewport"), canvas: $("canvas"),
    paperViewport: $("paperViewport"), touchNoteHandles: $("touchNoteHandles"),
    touchWidthHandle: $("touchWidthHandle"), touchScaleHandle: $("touchScaleHandle"),
    undoButton: $("undoButton"), redoButton: $("redoButton"), editorUndoButton: $("editorUndoButton"), editorRedoButton: $("editorRedoButton"),
    addImageButton: $("addImageButton"), insertImageButton: $("insertImageButton"), imageFile: $("imageFile"), zoomSelect: $("zoomSelect"),
    overflowBadge: $("overflowBadge"), overflowArea: $("overflowArea"), viewCapacityLabel: $("viewCapacityLabel"),
    viewMode: $("viewMode"), editMode: $("editMode"), backButton: $("backButton"),
    editorContent: $("editorContent"), editorStatus: $("editorStatus"),
    capacityLabel: $("capacityLabel"), editorOverflow: $("editorOverflow"),
    moveToNewPageButton: $("moveToNewPageButton"), deleteButton: $("deleteButton"),
    syncLabel: $("syncLabel"), syncButton: $("syncButton"), lockButton: $("lockButton"),
    importButton: $("importButton"), exportButton: $("exportButton"), importFile: $("importFile"),
    accessDialog: $("accessDialog"), setupView: $("setupView"), unlockView: $("unlockView"),
    tokenInput: $("tokenInput"), newPinInput: $("newPinInput"), confirmPinInput: $("confirmPinInput"),
    pinInput: $("pinInput"), setupButton: $("setupButton"), unlockButton: $("unlockButton"),
    setupError: $("setupError"), unlockError: $("unlockError"), resetAccessButton: $("resetAccessButton"),
    toast: $("toast")
  };
  const transport = new window.NotebookSync({
    owner: "zeranhub", repo: "personal-notes-data", path: "data/notes.json"
  });
  const Layout = window.OnePageLayout;
  const Model = window.OnePageModel;
  const empty = () => ({ version: 2, pages: [], notes: [], assets: {}, activePageId: null });
  const clone = value => JSON.parse(JSON.stringify(value));
  const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  // Parsing an old file can assign fresh migration timestamps. A page becomes
  // dirty only when its user-visible data or geometry changes.
  const signature = value => JSON.stringify({
    assets: value.assets || {},
    pages: value.pages.map(p => [p.id, p.name, p.width, p.height, p.conflictOf || null]),
    notes: value.notes.map(n => [n.id, n.pageId, n.content, n.x, n.y, n.w, n.h,
      n.manualSize, n.manualPosition, n.contentScale ?? 1, n.layer ?? 0, n.conflictOf || null, n.legacyTags || null])
  });
  const now = () => new Date().toISOString();
  const byId = id => state.notes.find(note => note.id === id);
  const pageById = id => state.pages.find(page => page.id === id);

  let state = empty();
  let baseline = empty();
  let sha = null;
  let viewPageId = null;
  let editingId = null;
  let mode = "view";
  let editingWasNew = false;
  let migrationPending = false;
  let unlocked = false;
  let remoteReady = false;
  let draftFailed = false;
  let draftPending = 0;
  let session = 0;
  let changeNumber = 0;
  let currentScale = 1;
  let returnScroll = { x: 0, y: 0 };
  let toastTimer = null;
  let syncTimer = null;
  let retryTimer = null;
  let pollTimer = null;
  let layoutTimer = null;
  let draftQueue = Promise.resolve();
  let cloudQueue = Promise.resolve();
  let lastLayout = { placed: [], overflow: [], percent: 0 };
  let suppressClickUntil = 0;
  let imageTarget = null;
  let pendingImageTarget = null;
  let imageBusy = false;
  let zoom = "fit";
  // A Windows computer can report touch hardware while its active pointer is a mouse.
  const touchDevice = matchMedia("(pointer: coarse)").matches;
  document.body.classList.toggle("is-touch-device", touchDevice);
  let selectedNoteId = null;
  let activeMoveCleanup = null;
  let paperGesture = null;
  let deferredView = false;
  let longPressTimer = null;
  let navigationId = crypto.randomUUID();
  let navigationBackPending = false;
  const journal = new window.OnePageHistory();
  let historyBefore = null;
  let historySelectionBefore = null;
  let applyingHistory = false;
  const paperPointers = new Map();
  const pageViews = new Map();
  const assetUrls = new Map();
  const assetLoads = new Map();
  const measurementCache = new Map();

  function canonical(parsed) {
    return {
      version: 2,
      pages: clone(parsed.pages),
      notes: clone(parsed.notes),
      assets: clone(parsed.assets || {}),
      activePageId: parsed.activePageId || parsed.pages[0]?.id || null
    };
  }

  function parseData(raw) {
    const parsed = Model.parse(raw);
    return { data: canonical(parsed), migrated: Boolean(parsed.migrated) };
  }

  function isCurrent(epoch) { return unlocked && epoch === session; }
  function isDirty() { return migrationPending || signature(state) !== signature(baseline); }
  function currentPage() { return pageById(viewPageId) || state.pages[0] || null; }

  function ensurePage() {
    if (!state.pages.length) {
      const page = Model.createPage(0, PAPER_WIDTH, PAPER_HEIGHT);
      state.pages.push(page);
      state.activePageId = page.id;
      migrationPending = true;
    }
    if (!pageById(viewPageId)) viewPageId = state.activePageId && pageById(state.activePageId)
      ? state.activePageId : state.pages[0].id;
  }

  function setStatus(kind, label) {
    ui.syncLabel.textContent = label;
    ui.editorStatus.textContent = label;
    const parent = ui.syncLabel.parentElement;
    parent.classList.toggle("is-synced", kind === "synced");
    parent.classList.toggle("is-error", kind === "error");
  }

  function errorText(error) {
    const messages = {
      NETWORK_ERROR: "连接 GitHub 失败；加密草稿仍保存在这台设备。",
      RATE_LIMITED: "GitHub 请求较多，稍后自动重试。",
      UNAUTHORIZED: "访问令牌已失效，请锁定后重新连接。",
      FORBIDDEN: "GitHub 拒绝写入，请检查令牌的 Contents 权限是否为 Read and write。",
      NOT_FOUND: "找不到私有仓库或笔记文件，请检查令牌的仓库访问范围。",
      REPOSITORY_PUBLIC: "笔记数据仓库必须保持私有。",
      TOO_LARGE: "笔记文件超过约 1 MB，无法继续同步；请导出备份并精简正文。",
      STORAGE_UNAVAILABLE: "本机加密草稿保存失败，请立即导出备份。",
      DRAFT_CORRUPT: "本机草稿无法解密，请勿重置 PIN。",
      INVALID_DATA: "GitHub 上的笔记数据格式有误。",
      UNSUPPORTED: "此浏览器不支持所需加密功能。",
      UNLOCK_FAILED: "PIN 错误，或本机授权信息已损坏。",
      INVALID_PIN: "请输入恰好 6 位数字 PIN。",
      INVALID_TOKEN: "请输入 GitHub 访问令牌。",
      ASSET_CONFLICT: "图片文件与当前备份不一致，请重新选择图片。",
      ASSET_EXISTS: "图片路径已存在不同文件，请重新选择图片。",
      INVALID_ASSET: "图片信息有误，请重新选择图片。"
    };
    return messages[error?.code] || "操作失败，请稍后重试。";
  }

  function toast(message) {
    ui.toast.textContent = message;
    ui.toast.classList.add("is-visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ui.toast.classList.remove("is-visible"), 4600);
  }

  function renderBody(element, source) {
    window.OnePageMarkdown.render(element, source, {
      assets: state.assets || {},
      getAssetUrl: id => assetUrls.get(id) || null
    });
  }

  function clearAssetUrls() {
    for (const url of assetUrls.values()) URL.revokeObjectURL(url);
    assetUrls.clear();
    assetLoads.clear();
    window.OnePageMarkdown.clearCache();
    measurementCache.clear();
  }

  function uploadPrivateAsset(asset, bytes) {
    const epoch = session;
    const task = cloudQueue.catch(() => {}).then(() => {
      if (!isCurrent(epoch)) throw new Error("页面已锁定，请重新插入图片。");
      return transport.uploadAsset(asset, bytes);
    });
    cloudQueue = task.catch(() => {});
    return task;
  }

  async function prepareImage(file) {
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
      throw new Error("请选择 PNG、JPG 或 WebP 图片。");
    }
    if (file.size > 20 * 1024 * 1024) throw new Error("图片超过 20 MB，请选择较小的图片。");
    const bitmap = await createImageBitmap(file);
    try {
      if (bitmap.width * bitmap.height > 40_000_000) throw new Error("图片分辨率过大，请先缩小图片。");
      const ratio = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
      let width = Math.max(1, Math.round(bitmap.width * ratio));
      let height = Math.max(1, Math.round(bitmap.height * ratio));
      if (ratio === 1 && file.size <= 900000) {
        return { bytes: new Uint8Array(await file.arrayBuffer()), mime: file.type, width, height };
      }
      const canvas = document.createElement("canvas");
      for (let attempt = 0; attempt < 6; attempt++) {
        canvas.width = width; canvas.height = height;
        canvas.getContext("2d").drawImage(bitmap, 0, 0, width, height);
        const blob = await new Promise(resolve => canvas.toBlob(resolve,
          attempt === 0 && file.type === "image/png" ? "image/png" : "image/webp", 0.9));
        if (blob && blob.size <= 900000) return {
          bytes: new Uint8Array(await blob.arrayBuffer()), mime: blob.type, width, height
        };
        width = Math.max(1, Math.round(width * 0.8));
        height = Math.max(1, Math.round(height * 0.8));
      }
      throw new Error("图片暂时无法保存，请尝试较小的图片。");
    } finally { bitmap.close(); }
  }

  function chooseImage(independent) {
    if (!unlocked || imageBusy || (!remoteReady && !state.pages.length)) return;
    const note = independent ? null : byId(editingId);
    if (!independent && !note) return;
    imageTarget = {
      independent, pageId: currentPage()?.id, noteId: note?.id,
      start: ui.editorContent.selectionStart, end: ui.editorContent.selectionEnd,
      content: note?.content
    };
    ui.imageFile.click();
  }

  async function insertImage(file, target) {
    if (!unlocked || imageBusy || !target) return;
    if (Object.keys(state.assets || {}).length >= 3000 || (target.independent && state.notes.length >= 1000)) {
      toast("已达到图片或笔记数量上限，请先导出备份。" );
      return;
    }
    const epoch = session;
    imageBusy = true;
    pendingImageTarget = target;
    ui.addImageButton.disabled = ui.insertImageButton.disabled = true;
    setStatus("pending", "正在保存图片…");
    try {
      const prepared = await prepareImage(file);
      if (!isCurrent(epoch)) return;
      const id = `img-${crypto.randomUUID().replace(/-/g, "")}`;
      const extension = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" }[prepared.mime];
      const asset = { id, path: `assets/${id}.${extension}`, mime: prepared.mime,
        width: prepared.width, height: prepared.height, name: file.name.slice(0, 100) };
      // Pictures are separate private files, so they do not consume the text file's size limit.
      await uploadPrivateAsset(asset, prepared.bytes);
      if (!isCurrent(epoch)) return;
      const alt = file.name.replace(/[\[\]\\\r\n]/g, " ").slice(0, 80) || "图片";
      const markup = `![${alt}](onepage:${id})`;
      let note;
      if (target.independent) {
        if (state.notes.length >= 1000) throw new Error("笔记数量达到上限，图片尚未插入。");
        const page = pageById(target.pageId) || currentPage();
        if (!page) throw new Error("当前纸张不存在，请重试。");
        note = Model.createNote(page.id);
        note.content = markup;
        if (Number.isFinite(target.x) && Number.isFinite(target.y)) {
          note.x = target.x; note.y = target.y; note.manualPosition = true;
        }
        state.notes.push(note);
      } else {
        note = byId(target.noteId);
        if (!note) throw new Error("原笔记已删除，图片尚未插入。");
        const changedWhileUploading = note.content !== target.content;
        const currentEditor = mode === "edit" && editingId === note.id;
        const wantedStart = changedWhileUploading
          ? (currentEditor ? ui.editorContent.selectionStart : note.content.length) : target.start;
        const wantedEnd = changedWhileUploading ? wantedStart : target.end;
        const start = Math.min(wantedStart, note.content.length);
        const end = Math.max(start, Math.min(wantedEnd, note.content.length));
        const insertion = `\n\n${markup}\n\n`;
        if (note.content.length - (end - start) + insertion.length > 2_000_000) {
          throw new Error("这篇笔记已达到长度上限，请将图片插入独立框。");
        }
        note.content = note.content.slice(0, start) + insertion + note.content.slice(end);
        note.updatedAt = now();
      }
      state.assets[id] = asset;
      assetUrls.set(id, URL.createObjectURL(new Blob([prepared.bytes], { type: prepared.mime })));
      changed();
      render();
      if (!target.independent && mode === "edit" && editingId === note.id) ui.editorContent.focus();
      toast("图片已插入，随笔记同步到私有仓库。" );
    } catch (error) {
      if (isCurrent(epoch)) {
        setStatus("error", "图片未插入");
        toast(error.code ? errorText(error) : error.message || "图片保存失败，请重试。" );
      }
    } finally {
      if (isCurrent(epoch)) {
        imageBusy = false;
        pendingImageTarget = null;
        ui.addImageButton.disabled = ui.insertImageButton.disabled = false;
      }
    }
  }

  function ensurePageImages(pageId) {
    const ids = new Set();
    for (const note of state.notes.filter(item => item.pageId === pageId)) {
      for (const match of note.content.matchAll(/\(onepage:([A-Za-z0-9_-]+)\)/g)) ids.add(match[1]);
    }
    const epoch = session;
    for (const id of ids) {
      const asset = state.assets?.[id];
      if (!asset || assetUrls.has(id) || assetLoads.has(id)) continue;
      const task = transport.loadAsset(asset).then(bytes => {
        if (!isCurrent(epoch)) return;
        assetUrls.set(id, URL.createObjectURL(new Blob([bytes], { type: asset.mime })));
        if (mode === "view" && currentPage()?.id === pageId) renderView();
      }).catch(error => {
        if (isCurrent(epoch)) toast(`图片暂时未加载：${errorText(error)}`);
      });
      // Keep a failed read in this session's map to avoid an automatic retry loop.
      assetLoads.set(id, task);
    }
  }

  // The measuring card uses exactly the same sanitized Markdown as the paper.
  const measurement = document.createElement("article");
  measurement.className = "note-card measurement-card";
  const measurementContent = document.createElement("div");
  measurementContent.className = "note-card-content";
  measurement.append(measurementContent);
  measurement.style.position = "absolute";
  measurement.style.left = "-100000px";
  measurement.style.top = "0";
  measurement.style.visibility = "hidden";
  measurement.style.pointerEvents = "none";
  measurement.style.height = "auto";
  measurement.style.maxHeight = "none";
  document.body.append(measurement);

  function noteScale(note) {
    return Number.isFinite(note.contentScale) ? Math.max(0.25, Math.min(8, note.contentScale)) : 1;
  }

  function measureBaseSize(width, text) {
    // Chromium lays out on a 1/64 px grid. Measure the width that actually
    // fits the requested frame; the resulting ink/frame bounds round outward.
    const outward = value => Math.ceil((value - 1e-8) * 64) / 64;
    const roundedWidth = Math.max(8, Math.floor((width + 1e-8) * 64) / 64);
    measurementContent.style.width = "";
    measurementContent.style.height = "auto";
    measurementContent.style.transform = "none";
    measurementContent.classList.remove("is-image-only");
    const css = getComputedStyle(measurementContent);
    const cacheKey = `${roundedWidth}:${css.font}:${css.lineHeight}:${css.padding}`;
    let sizes = measurementCache.get(text);
    if (sizes?.has(cacheKey)) return sizes.get(cacheKey);
    measurement.style.width = `${roundedWidth}px`;
    measurement.style.height = "auto";
    renderBody(measurementContent, text || " ");
    let tightWidth = roundedWidth;
    const metrics = () => {
      const box = measurement.getBoundingClientRect();
      const contentBox = measurementContent.getBoundingClientRect();
      const style = getComputedStyle(measurementContent);
      const paddingLeft = parseFloat(style.paddingLeft) || 0;
      const paddingRight = parseFloat(style.paddingRight) || 0;
      const paddingBottom = parseFloat(style.paddingBottom) || 0;
      let right = contentBox.left + paddingLeft;
      let bottom = contentBox.top;
      let textRects = 0;
      const walker = document.createTreeWalker(measurementContent, NodeFilter.SHOW_TEXT);
      const range = document.createRange();
      while (walker.nextNode()) {
        // A loading label is UI, not image content. Its glyphs must not change
        // the immutable image ratio or the dimensions after the image loads.
        if (walker.currentNode.parentElement?.closest(".md-image")) continue;
        range.selectNodeContents(walker.currentNode);
        for (const rect of range.getClientRects()) {
          if (rect.height <= 0 || rect.width <= 0) continue;
          right = Math.max(right, rect.right);
          bottom = Math.max(bottom, rect.bottom);
          textRects++;
        }
      }
      const blocks = measurementContent.querySelectorAll("pre,table,.md-image,blockquote,hr");
      for (const block of [...blocks, ...measurementContent.querySelectorAll("input,code")]) {
        const rect = block.getBoundingClientRect();
        right = Math.max(right, rect.right);
        bottom = Math.max(bottom, rect.bottom);
      }
      const borderWidth = box.width - contentBox.width;
      // Filled blocks reserve their own width. Prose gets only a tiny glyph
      // allowance after the CSS padding, rather than unused paragraph width.
      const rightGuard = textRects && !blocks.length ? 0.125 : 0;
      return {
        width: Math.max(8, outward(right - contentBox.left + paddingRight + borderWidth + rightGuard)),
        height: outward(Math.max(box.height,
          bottom - contentBox.top + paddingBottom + (box.height - contentBox.height)) + (textRects ? 0.125 : 0))
      };
    };
    // Remeasure after every width change. This also grows an impossibly narrow
    // request enough to contain one Chinese glyph or an unbreakable emoji.
    let mayShrink = true;
    for (let attempt = 0; attempt < 32; attempt++) {
      const nextWidth = metrics().width;
      if (Math.abs(tightWidth - nextWidth) < 1 / 64) break;
      // Once a glyph needs more room, never shrink back to the earlier wrap
      // in this pass. That shrink/grow cycle can otherwise leave a cached
      // narrow width with the height of a different line arrangement.
      if (nextWidth > tightWidth) mayShrink = false;
      else if (!mayShrink) break;
      tightWidth = nextWidth;
      measurement.style.width = `${tightWidth}px`;
    }
    // Height is read only at the final width and includes actual font Range
    // bounds, which may protrude below the CSS line box on the final line.
    let finalMetrics = metrics();
    if (finalMetrics.width > tightWidth) {
      tightWidth = finalMetrics.width;
      measurement.style.width = `${tightWidth}px`;
      finalMetrics = metrics();
    }
    const size = { w: measurement.getBoundingClientRect().width, h: finalMetrics.height };
    measurementContent.replaceChildren();
    if (!sizes) {
      if (measurementCache.size >= 64) measurementCache.delete(measurementCache.keys().next().value);
      sizes = new Map();
      measurementCache.set(text, sizes);
    }
    if (sizes.size >= 160) sizes.delete(sizes.keys().next().value);
    // Do not alias the resulting width: that width has its own render and may
    // have a different line break after another size/scale round trip.
    sizes.set(cacheKey, size);
    return size;
  }

  function contentSize(width, text, scale = 1) {
    const outward = value => Math.ceil((value - 1e-8) * 64) / 64;
    let baseWidth = 2 + Math.max(6, (width - 2) / scale);
    let size;
    // The displayed frame is also quantized by layout. Resolve that width
    // through the base measurement before saving it, so reading the saved
    // width back does not cross a wrap threshold at a fractional scale.
    for (let attempt = 0; attempt < 12; attempt++) {
      const base = measureBaseSize(baseWidth, text);
      const next = { w: outward(2 + (base.w - 2) * scale), h: outward(2 + (base.h - 2) * scale),
        contentWidth: base.w - 2, contentHeight: base.h - 2, contentScale: scale };
      if (size && next.w === size.w && next.h === size.h) return next;
      size = next;
      baseWidth = 2 + Math.max(6, (next.w - 2) / scale);
    }
    return size;
  }

  function styleCardContent(content, size) {
    content.style.width = `${size.contentWidth}px`;
    content.style.height = `${size.contentHeight}px`;
    content.style.minHeight = "0";
    content.style.boxSizing = "border-box";
    content.style.transformOrigin = "top left";
    content.style.transform = `scale(${size.contentScale})`;
  }

  function fitAlternative(note, page, placed, preferred) {
    const maxWidth = page.width - Layout.MARGIN * 2;
    const maxHeight = page.height - Layout.MARGIN * 2;
    const widths = new Set([112, maxWidth]);
    for (let width = 120; width < maxWidth; width += 24) widths.add(width);
    for (let columns = 2; columns <= 6; columns++) {
      widths.add(Math.floor((maxWidth - (columns - 1) * Layout.GAP) / columns));
    }
    let best = null;
    const scale = noteScale(note);
    for (const w of widths) {
      const size = contentSize(w, note.content, scale);
      if (size.h > maxHeight) continue;
      const position = Layout.findPlacement(placed, size, page, preferred);
      if (!position) continue;
      const score = size.w * size.h * (1 + 0.1 * Math.abs(Math.log(size.w / size.h / 1.25)));
      if (!best || score < best.score) best = { size, position, score };
    }
    return best;
  }

  function desiredSize(note, page) {
    const bounds = { w: page.width, h: page.height };
    const margin = Layout.MARGIN;
    const scale = noteScale(note);
    const maxWidth = page.width - margin * 2;
    const maxHeight = page.height - margin * 2;
    if (note.manualSize && Number.isFinite(note.w)) {
      const size = contentSize(Math.max(2 + 6 * scale, Math.min(maxWidth, note.w)), note.content, scale);
      return size.h <= maxHeight ? size : null;
    }
    const picture = /^\s*!\[[^\]]*\]\(onepage:([A-Za-z0-9_-]+)\)\s*$/.exec(note.content);
    if (picture && state.assets[picture[1]]) {
      const size = contentSize(Math.min(2 + 178 * scale, maxWidth), note.content, scale);
      return size.h <= maxHeight ? size : null;
    }
    const preferred = Layout.makeRectSize(note.content, (width, text) => contentSize(width, text, scale).h, bounds, {
      minWidth: Math.min(maxWidth, 2 + 110 * scale), minHeight: 1, maxWidth,
      extraHeight: 0,
      preferredWidth: Number.isFinite(note.w) ? note.w : undefined
    });
    return preferred ? contentSize(preferred.w, note.content, scale) : null;
  }

  function layoutPage(pageId) {
    const page = pageById(pageId);
    if (!page) return { placed: [], overflow: [], percent: 0, changed: false };
    const pageNotes = state.notes.filter(note => note.pageId === pageId);
    const ordered = [...pageNotes].sort((a, b) =>
      Number(Boolean(b.manualPosition)) - Number(Boolean(a.manualPosition)) ||
      Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id)
    );
    const placed = [];
    const overflow = [];
    for (const note of ordered) {
      let size = desiredSize(note, page);
      if (!size) { overflow.push(note); continue; }
      const preferred = note.manualPosition && Number.isFinite(note.x) && Number.isFinite(note.y)
        ? { x: note.x, y: note.y } : null;
      let position = Layout.findPlacement(placed, size, { w: page.width, h: page.height }, preferred,
        { allowOverlap: Boolean(preferred) });
      if (!position && !note.manualSize) {
        const alternative = fitAlternative(note, page, placed, preferred);
        if (alternative) { size = alternative.size; position = alternative.position; }
      }
      if (!position) { overflow.push(note); continue; }
      const rect = { id: note.id, x: position.x, y: position.y, ...size };
      placed.push(rect);
    }
    const usable = Math.max(1, (page.width - Layout.MARGIN * 2) * (page.height - Layout.MARGIN * 2));
    const percent = Math.min(100, Math.round(100 * Layout.coveredArea(placed) / usable));
    return { placed, overflow, percent };
  }

  function updateMobileViewport() {
    const viewport = window.visualViewport;
    const height = viewport?.height || window.innerHeight;
    const offset = viewport?.offsetTop || 0;
    document.documentElement.style.setProperty("--mobile-viewport-height",
      `${Math.max(120, height + offset - ui.paperViewport.getBoundingClientRect().top - 24)}px`);
    document.documentElement.style.setProperty("--mobile-editor-height",
      `${Math.max(120, height + offset - ui.editMode.getBoundingClientRect().top - 8)}px`);
  }

  function fitScale() {
    const page = currentPage();
    if (!page) return 1;
    const style = getComputedStyle(ui.paperViewport);
    const width = Math.max(100, ui.paperViewport.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight));
    const height = touchDevice
      ? Math.max(100, ui.paperViewport.clientHeight - 18)
      : Math.max(360, window.innerHeight - ui.paperViewport.getBoundingClientRect().top - 45);
    return Math.max(0.08, Math.min(1, width / page.width, height / page.height));
  }

  function paperAnchor(clientX, clientY) {
    const box = ui.canvas.getBoundingClientRect();
    return { clientX, clientY, x: (clientX - box.left) / currentScale, y: (clientY - box.top) / currentScale };
  }

  function viewportAnchor() {
    const box = ui.paperViewport.getBoundingClientRect();
    return paperAnchor(box.left + ui.paperViewport.clientWidth / 2,
      box.top + Math.min(ui.paperViewport.clientHeight, window.innerHeight - box.top) / 2);
  }

  function keepAnchor(anchor) {
    if (!anchor) return;
    const box = ui.canvas.getBoundingClientRect();
    ui.paperViewport.scrollLeft += box.left + anchor.x * currentScale - anchor.clientX;
    ui.paperViewport.scrollTop += box.top + anchor.y * currentScale - anchor.clientY;
  }

  function savePageView() {
    if (viewPageId && mode === "view") pageViews.set(viewPageId, {
      zoom, left: ui.paperViewport.scrollLeft, top: ui.paperViewport.scrollTop
    });
  }

  function restorePageView(id) {
    const view = pageViews.get(id);
    zoom = view?.zoom || "fit";
    updatePaperScale();
    ui.paperViewport.scrollLeft = view?.left || 0;
    ui.paperViewport.scrollTop = view?.top || 0;
    positionTouchTools();
  }

  function updatePaperScale(anchor = null) {
    const page = currentPage();
    if (!page || !unlocked) return;
    updateMobileViewport();
    currentScale = zoom === "fit" ? fitScale() : Math.max(Math.min(0.2, fitScale()), Math.min(4, Number(zoom)));
    ui.viewMode.classList.toggle("is-zoomed", zoom !== "fit");
    ui.canvasViewport.style.setProperty("--page-scale", String(currentScale));
    ui.canvasViewport.style.setProperty("--scaled-page-width", `${Math.round(page.width * currentScale)}px`);
    ui.canvasViewport.style.setProperty("--scaled-page-height", `${Math.round(page.height * currentScale)}px`);
    let custom = ui.zoomSelect.querySelector('option[value="custom"]');
    if (!custom) {
      custom = document.createElement("option");
      custom.value = "custom";
      ui.zoomSelect.append(custom);
    }
    const standard = [...ui.zoomSelect.options].some(option => option.value !== "custom" && option.value === zoom);
    custom.hidden = standard;
    custom.textContent = `${Math.round(currentScale * 100)}%`;
    ui.zoomSelect.value = standard ? zoom : "custom";
    keepAnchor(anchor);
    positionTouchTools();
  }

  function selectNote(id) {
    selectedNoteId = touchDevice ? id : null;
    updateTouchSelection();
  }

  function updateTouchSelection() {
    const note = byId(selectedNoteId);
    if (!note || note.pageId !== viewPageId || mode !== "view" || !unlocked) selectedNoteId = null;
    for (const card of ui.viewMode.querySelectorAll(".note-card")) {
      card.classList.toggle("is-selected", card.dataset.noteId === selectedNoteId);
      card.setAttribute("aria-pressed", String(card.dataset.noteId === selectedNoteId));
    }
    ui.touchNoteHandles.hidden = !touchDevice || !selectedNoteId;
    const onPaper = lastLayout.placed.some(rect => rect.id === selectedNoteId);
    ui.touchWidthHandle.disabled = ui.touchScaleHandle.disabled = !onPaper;
    positionTouchTools();
  }

  function positionTouchTools() {
    if (ui.touchNoteHandles.hidden) return;
    const card = [...ui.canvas.querySelectorAll(".note-card")].find(item => item.dataset.noteId === selectedNoteId);
    if (!card) { ui.touchNoteHandles.hidden = true; return; }
    const box = card.getBoundingClientRect();
    const viewport = ui.paperViewport.getBoundingClientRect();
    const widthY = box.top + box.height / 2;
    // A screen-sized control must not cover the body of a dense note. Its old
    // edge-centred 44px hit area could swallow an entire note at fit zoom.
    const radius = 22, gap = 2;
    const left = radius + 1, right = window.innerWidth - radius - 1;
    const minY = Math.max(0, viewport.top) + radius + 1;
    const maxY = Math.min(window.innerHeight, viewport.bottom) - radius - 1;
    let x = box.right + radius + gap;
    let widthTop = widthY;
    let scaleTop = Math.max(box.bottom + radius + gap, widthY + 48);
    let scaleX = x;
    let besideBody = true;
    if (x > right) {
      x = box.left - radius - gap;
      scaleX = x;
      if (x < left) {
        besideBody = false;
        // A note can span the visible screen when zoomed. Put the controls
        // outside its top or bottom instead of covering its text.
        const above = box.top - radius - gap;
        const below = box.bottom + radius + gap;
        widthTop = scaleTop = above >= minY && above <= maxY ? above : below;
        x = right;
        scaleX = Math.max(left, x - 48);
      }
    }
    if (besideBody) {
      // Horizontal separation already protects every body point. Keep both
      // full touch targets visible for a tiny note at the top or bottom edge.
      widthTop = Math.max(minY, Math.min(maxY - 48, widthTop));
      scaleTop = Math.max(widthTop + 48, Math.min(maxY, scaleTop));
    }
    for (const [button, buttonX, y] of [[ui.touchWidthHandle, x, widthTop], [ui.touchScaleHandle, scaleX, scaleTop]]) {
      button.hidden = box.right < viewport.left || box.left > viewport.right ||
        box.bottom < viewport.top || box.top > viewport.bottom ||
        y < minY || y > maxY;
      button.style.left = `${buttonX}px`;
      button.style.top = `${y}px`;
    }
  }

  function tapNote(id) {
    if (selectedNoteId === id) enterEdit(id);
    else selectNote(id);
  }

  function beginPaperGesture(event) {
    if (!touchDevice || event.pointerType !== "touch" || !unlocked || mode !== "view" || activeMoveCleanup) return;
    paperPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (paperPointers.size === 1) {
      paperGesture = { target: event.target, down: event, startX: event.clientX, startY: event.clientY,
        left: ui.paperViewport.scrollLeft, top: ui.paperViewport.scrollTop, moved: false, pinched: false };
      const card = event.target.closest(".note-card");
      if (card) longPressTimer = setTimeout(() => {
        longPressTimer = null;
        if (!paperGesture || paperGesture.moved || paperGesture.pinched || paperPointers.size !== 1) return;
        const note = byId(card.dataset.noteId);
        if (!note) return;
        selectNote(note.id);
        paperPointers.clear();
        paperGesture = null;
        beginMove(event, note, card, "drag");
      }, 420);
    } else if (paperPointers.size === 2) {
      clearTimeout(longPressTimer); longPressTimer = null;
      const [a, b] = [...paperPointers.values()];
      paperGesture.pinched = true;
      paperGesture.scale = currentScale;
      paperGesture.distance = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
      paperGesture.anchor = paperAnchor((a.x + b.x) / 2, (a.y + b.y) / 2);
      suppressClickUntil = Date.now() + 500;
    }
    ui.paperViewport.setPointerCapture(event.pointerId);
  }

  function movePaperGesture(event) {
    if (!paperPointers.has(event.pointerId) || !paperGesture) return;
    event.preventDefault();
    paperPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (paperPointers.size === 2) {
      const [a, b] = [...paperPointers.values()];
      zoom = String(Math.max(fitScale(), Math.min(4,
        paperGesture.scale * Math.hypot(a.x - b.x, a.y - b.y) / paperGesture.distance)));
      updatePaperScale({ ...paperGesture.anchor, clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2 });
    } else if (paperPointers.size === 1) {
      const dx = event.clientX - paperGesture.startX;
      const dy = event.clientY - paperGesture.startY;
      if (Math.hypot(dx, dy) > 6) {
        paperGesture.moved = true;
        clearTimeout(longPressTimer); longPressTimer = null;
      }
      if (paperGesture.moved || paperGesture.pinched) {
        ui.paperViewport.scrollLeft = paperGesture.left - dx;
        ui.paperViewport.scrollTop = paperGesture.top - dy;
      }
    }
    positionTouchTools();
  }

  function endPaperGesture(event) {
    if (!paperPointers.has(event.pointerId) || !paperGesture) return;
    const gesture = paperGesture;
    clearTimeout(longPressTimer); longPressTimer = null;
    paperPointers.delete(event.pointerId);
    if (ui.paperViewport.hasPointerCapture(event.pointerId)) ui.paperViewport.releasePointerCapture(event.pointerId);
    if (paperPointers.size) {
      const [remaining] = paperPointers.values();
      gesture.startX = remaining.x; gesture.startY = remaining.y;
      gesture.left = ui.paperViewport.scrollLeft; gesture.top = ui.paperViewport.scrollTop;
      return;
    }
    paperGesture = null;
    savePageView();
    suppressClickUntil = Date.now() + 500;
    if (event.type !== "pointercancel" && !gesture.moved && !gesture.pinched) {
      const card = gesture.target.closest(".note-card");
      if (card) tapNote(card.dataset.noteId);
      else selectNote(null);
    }
    if (deferredView) { deferredView = false; if (mode === "view") renderView(); }
  }

  function createCard(note, rect, overflow = false) {
    const card = document.createElement("article");
    card.className = `note-card${overflow ? " is-overflow" : ""}${note.conflictOf ? " is-conflict" : ""}`;
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    card.setAttribute("aria-label", overflow ? "编辑纸张外的笔记" : "编辑笔记");
    card.dataset.noteId = note.id;
    if (!overflow) {
      card.style.left = `${rect.x}px`;
      card.style.top = `${rect.y}px`;
      card.style.width = `${rect.w}px`;
      card.style.height = `${rect.h}px`;
      const handle = document.createElement("button");
      handle.type = "button";
      handle.className = "drag-handle";
      handle.setAttribute("aria-label", "拖动笔记位置");
      handle.title = "拖动位置";
      handle.addEventListener("pointerdown", event => beginMove(event, note, card, "drag"));
      handle.addEventListener("click", event => event.stopPropagation());
      card.append(handle);
    }
    if (note.conflictOf) {
      const badge = document.createElement("span");
      badge.className = "conflict-badge";
      badge.textContent = "冲突副本";
      card.append(badge);
    }
    const content = document.createElement("div");
    content.className = "note-card-content";
    renderBody(content, note.content);
    // Image placeholders contain labels too; only actual prose or other
    // visible Markdown blocks make a card part of the upper text layer.
    let imageOnly = Boolean(content.querySelector(".md-image")) &&
      !content.querySelector("hr,input,table,pre,blockquote");
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
    while (imageOnly && walker.nextNode()) {
      if (walker.currentNode.textContent.trim() && !walker.currentNode.parentElement?.closest(".md-image")) imageOnly = false;
    }
    card.dataset.noteKind = imageOnly ? "image" : "text";
    if (rect) styleCardContent(content, rect);
    else {
      const size = contentSize(Math.min(782, ui.overflowArea.clientWidth || Math.max(80, window.innerWidth - 34)), note.content, noteScale(note));
      styleCardContent(content, size);
      card.style.setProperty("--overflow-note-width", `${size.w}px`);
      card.style.setProperty("--overflow-note-height", `${size.h}px`);
    }
    const frame = document.createElement("div");
    frame.className = "note-content-frame";
    frame.append(content);
    card.append(frame);
    if (!overflow) {
      const width = document.createElement("button");
      width.type = "button";
      width.className = "width-handle";
      width.setAttribute("aria-label", "调整横向宽度并重新换行");
      width.title = "调整宽度，字号不变";
      width.addEventListener("pointerdown", event => beginMove(event, note, card, "width"));
      width.addEventListener("click", event => event.stopPropagation());
      card.append(width);
      const resize = document.createElement("button");
      resize.type = "button";
      resize.className = "resize-handle";
      resize.setAttribute("aria-label", "缩放正文和图片，内容框自动贴合");
      resize.title = "等比缩放内容";
      resize.addEventListener("pointerdown", event => beginMove(event, note, card, "resize"));
      resize.addEventListener("click", event => event.stopPropagation());
      card.append(resize);
    }
    card.addEventListener("click", () => {
      if (Date.now() < suppressClickUntil) return;
      if (touchDevice) tapNote(note.id);
      else enterEdit(note.id);
    });
    card.addEventListener("keydown", event => {
      if (event.target !== card) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        enterEdit(note.id);
      }
    });
    return card;
  }

  function noteLayer(note) {
    return Number.isSafeInteger(note?.layer) && note.layer >= 0 ? note.layer : 0;
  }

  function updateCardLayers(frontId = null) {
    const cards = [...ui.canvas.children];
    const index = new Map(cards.map((card, position) => [card, position]));
    const notes = new Map(state.notes.map(note => [note.id, note]));
    cards.sort((a, b) => {
      const aText = a.dataset.noteKind !== "image", bText = b.dataset.noteKind !== "image";
      if (aText !== bText) return Number(aText) - Number(bText);
      const aFront = a.dataset.noteId === frontId, bFront = b.dataset.noteId === frontId;
      return Number(aFront) - Number(bFront) ||
        noteLayer(notes.get(a.dataset.noteId)) - noteLayer(notes.get(b.dataset.noteId)) || index.get(a) - index.get(b);
    });
    cards.forEach((card, position) => { card.style.zIndex = String(position + 1); });
  }

  function raiseNoteLayer(note) {
    const peers = state.notes.filter(item => item.pageId === note.pageId);
    let maximum = Math.max(0, ...peers.map(noteLayer));
    // Stored order values never become CSS z-index values. Rebase only if a
    // very old/imported counter has reached JavaScript's exact integer limit.
    if (maximum >= Number.MAX_SAFE_INTEGER - 1) {
      peers.sort((a, b) => noteLayer(a) - noteLayer(b));
      peers.forEach((item, position) => { item.layer = position + 1; item.updatedAt = now(); });
      maximum = peers.length;
    }
    note.layer = maximum + 1;
  }

  function renderTabs() {
    ui.pageTabs.replaceChildren();
    for (const page of state.pages) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `page-tab${page.id === viewPageId ? " is-active" : ""}`;
      button.setAttribute("role", "tab");
      button.setAttribute("aria-selected", String(page.id === viewPageId));
      button.textContent = page.name;
      button.addEventListener("click", () => selectPage(page.id));
      ui.pageTabs.append(button);
    }
  }

  function renderView() {
    if (!unlocked) return;
    if (paperGesture || activeMoveCleanup) { deferredView = true; return; }
    ensurePage();
    const page = currentPage();
    const result = layoutPage(page.id);
    lastLayout = result;
    ui.canvas.replaceChildren();
    ui.overflowArea.replaceChildren();
    const placedById = new Map(result.placed.map(rect => [rect.id, rect]));
    for (const note of state.notes.filter(item => item.pageId === page.id)) {
      const rect = placedById.get(note.id);
      if (rect) ui.canvas.append(createCard(note, rect));
    }
    updateCardLayers();
    if (result.overflow.length) {
      const heading = document.createElement("p");
      heading.className = "overflow-heading";
      heading.textContent = `${result.overflow.length} 篇笔记超出这张纸的容量，正文仍完整保留在纸张外。`;
      ui.overflowArea.append(heading);
      for (const note of result.overflow) ui.overflowArea.append(createCard(note, null, true));
    }
    ui.overflowArea.hidden = result.overflow.length === 0;
    ui.overflowBadge.hidden = result.overflow.length === 0;
    ui.overflowBadge.textContent = result.overflow.length
      ? `${result.overflow.length} 篇笔记越过纸张边界 ↓` : "";
    ui.canvasViewport.classList.toggle("is-overflowing", result.overflow.length > 0);
    if (ui.viewCapacityLabel) {
      ui.viewCapacityLabel.textContent = result.overflow.length
        ? `${result.overflow.length} 篇越界 · 纸张已满`
        : `已用约 ${result.percent}% · 固定 A4 空间`;
    }
    updatePaperScale();
    updateTouchSelection();
    renderTabs();
    ensurePageImages(page.id);
  }

  function renderEdit() {
    if (!unlocked || mode !== "edit") return;
    const note = byId(editingId);
    if (!note) { leaveEdit(); return; }
    if (ui.editorContent.value !== note.content) ui.editorContent.value = note.content;
    const layout = layoutPage(note.pageId);
    const overflow = layout.overflow.some(item => item.id === note.id);
    ui.editorOverflow.hidden = !overflow;
    ui.capacityLabel.textContent = overflow
      ? "这篇笔记已经放不进当前纸张"
      : `当前纸张已用约 ${layout.percent}%`;
    ui.moveToNewPageButton.disabled = state.pages.length >= 100;
  }

  function render() {
    if (!unlocked) return;
    ensurePage();
    ui.viewMode.hidden = mode !== "view";
    ui.editMode.hidden = mode !== "edit";
    document.body.classList.toggle("is-editing", mode === "edit");
    updateMobileViewport();
    if (mode === "view") renderView();
    else { renderTabs(); renderEdit(); }
    updateHistoryButtons();
  }

  function selectPage(id) {
    if (!unlocked || !pageById(id)) return;
    savePageView();
    selectedNoteId = null;
    viewPageId = id;
    mode = "view";
    editingId = null;
    render();
    restorePageView(id);
    replaceNavigationState();
  }

  function replaceNavigationState() {
    window.history.replaceState({ onePage: { session: navigationId, mode, noteId: editingId, pageId: viewPageId } }, "", location.href);
  }

  function enterEdit(id, isNew = false, fromNavigation = false) {
    if (!unlocked) return;
    const note = byId(id);
    if (!note) return;
    returnScroll = { x: window.scrollX, y: window.scrollY };
    savePageView();
    viewPageId = note.pageId;
    editingId = id;
    editingWasNew = isNew;
    selectedNoteId = touchDevice ? id : null;
    mode = "edit";
    ui.touchNoteHandles.hidden = true;
    if (!fromNavigation) window.history.pushState({ onePage: {
      session: navigationId, mode: "edit", noteId: id, pageId: note.pageId
    } }, "", location.href);
    render();
    ui.editorContent.focus({ preventScroll: touchDevice });
    ui.editorContent.setSelectionRange(ui.editorContent.value.length, ui.editorContent.value.length);
  }

  function leaveEdit(fromNavigation = false) {
    if (!unlocked) return;
    if (!fromNavigation && mode === "edit" && window.history.state?.onePage?.session === navigationId &&
        window.history.state.onePage.mode === "edit") {
      if (!navigationBackPending) { navigationBackPending = true; window.history.back(); }
      return;
    }
    navigationBackPending = false;
    clearTimeout(layoutTimer);
    const note = byId(editingId);
    if (note && editingWasNew && note.content.length === 0) {
      state.notes = state.notes.filter(item => item.id !== note.id);
      changed();
    }
    if (note) viewPageId = note.pageId;
    editingId = null;
    editingWasNew = false;
    ui.editorContent.blur();
    mode = "view";
    render();
    restorePageView(viewPageId);
    replaceNavigationState();
    requestAnimationFrame(() => window.scrollTo(returnScroll.x, returnScroll.y));
  }

  function beginMove(event, note, card, kind, firstMove = null) {
    if (!unlocked || mode !== "view" || event.button !== 0 || activeMoveCleanup || paperGesture) return;
    event.preventDefault();
    event.stopPropagation();
    const page = currentPage();
    if (!page || note.pageId !== page.id) return;
    const placed = lastLayout.placed.find(rect => rect.id === note.id);
    if (!placed) return;
    const start = { x: placed.x, y: placed.y, w: placed.w, h: placed.h };
    const origin = { x: event.clientX, y: event.clientY };
    const moveScale = currentScale;
    const initialScale = noteScale(note);
    let candidateScale = initialScale;
    let candidateSize = { ...placed };
    const content = card.querySelector(".note-card-content");
    let candidate = { ...start };
    let moved = false;
    card.classList.add("is-moving");
    updateCardLayers(note.id);
    const margin = Layout.MARGIN;
    const edge = (value, min, max) => {
      const bounded = Math.max(min, Math.min(max, value));
      if (bounded - min <= 8) return min;
      if (max - bounded <= 8) return max;
      return Math.round(bounded * 2) / 2;
    };
    const onMove = move => {
      if (move.pointerId !== event.pointerId) return;
      if (!unlocked) return;
      move.preventDefault();
      const dx = (move.clientX - origin.x) / moveScale;
      const dy = (move.clientY - origin.y) / moveScale;
      if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
      let next;
      if (kind === "drag") next = {
        ...start,
        x: edge(start.x + dx, margin, page.width - margin - start.w),
        y: edge(start.y + dy, margin, page.height - margin - start.h)
      };
      else if (kind === "width") {
        const targetWidth = Math.max(2 + 6 * initialScale,
          Math.min(page.width - margin - start.x, start.w + dx));
        const resized = value => contentSize(value, note.content, initialScale);
        let size = resized(targetWidth);
        if (!Layout.isWithinBounds({ ...start, w: size.w, h: size.h }, page)) {
          let valid = start.w, invalid = targetWidth;
          for (let attempt = 0; attempt < 12; attempt++) {
            const middle = (valid + invalid) / 2;
            const measured = resized(middle);
            if (Layout.isWithinBounds({ ...start, w: measured.w, h: measured.h }, page)) {
              valid = middle; size = measured;
            } else invalid = middle;
          }
          if (valid === start.w) return;
        }
        next = { ...start, w: size.w, h: size.h };
        candidateSize = size;
      }
      else {
        const innerWidth = start.w - 2, innerHeight = start.h - 2;
        const factor = 1 + (dx * innerWidth + dy * innerHeight) / (innerWidth ** 2 + innerHeight ** 2);
        const maximum = Math.min(8 / initialScale,
          (page.width - margin - start.x - 2) / innerWidth,
          (page.height - margin - start.y - 2) / innerHeight);
        let bounded = Math.max(0.25 / initialScale, Math.min(maximum, factor));
        const scaledRect = value => ({ ...start, w: 2 + innerWidth * value, h: 2 + innerHeight * value });
        next = scaledRect(bounded);
        if (!Layout.isWithinBounds(next, page)) {
          // Keep the largest valid enlargement within the finite paper.
          let low = 1, high = bounded;
          for (let attempt = 0; attempt < 18; attempt++) {
            const middle = (low + high) / 2;
            if (Layout.isWithinBounds(scaledRect(middle), page)) low = middle;
            else high = middle;
          }
          bounded = low;
          next = scaledRect(bounded);
        }
        candidateScale = Math.max(0.25, Math.min(8, initialScale * bounded));
      }
      if (!Layout.isWithinBounds(next, page)) return;
      candidate = next;
      card.style.left = `${next.x}px`;
      card.style.top = `${next.y}px`;
      card.style.width = `${next.w}px`;
      card.style.height = `${next.h}px`;
      if (kind === "resize") content.style.transform = `scale(${candidateScale})`;
      else if (kind === "width") styleCardContent(content, candidateSize);
      positionTouchTools();
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      activeMoveCleanup = null;
      if (event.target.hasPointerCapture?.(event.pointerId)) event.target.releasePointerCapture(event.pointerId);
      card.classList.remove("is-moving");
    };
    const onUp = up => {
      if (up.pointerId !== event.pointerId) return;
      cleanup();
      if (!unlocked) return;
      if (moved || event.pointerType === "touch") suppressClickUntil = Date.now() + 500;
      // A background sync can replace the document while the pointer is held.
      const currentNote = byId(note.id);
      if (up.type !== "pointercancel" && currentNote?.pageId === page.id) {
        currentNote.x = candidate.x; currentNote.y = candidate.y;
        currentNote.w = candidate.w; currentNote.h = candidate.h;
        raiseNoteLayer(currentNote);
        if (kind === "drag") currentNote.manualPosition = true;
        else {
          currentNote.manualPosition = true; currentNote.manualSize = true;
          currentNote.contentScale = candidateScale;
        }
        currentNote.updatedAt = now();
        changed();
      }
      renderView();
      deferredView = false;
    };
    activeMoveCleanup = cleanup;
    event.target.setPointerCapture?.(event.pointerId);
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    if (firstMove) onMove(firstMove);
  }

  function queueDraft() {
    const epoch = session;
    const number = changeNumber;
    const snapshot = {
      version: 3, data: clone(state), baseline: clone(baseline), sha,
      viewPageId, editingId, mode, migrationPending
    };
    draftPending++;
    const task = draftQueue.catch(() => {}).then(async () => {
      if (!isCurrent(epoch)) return false;
      try {
        await transport.saveDraft(snapshot);
        if (isCurrent(epoch)) {
          draftFailed = false;
          if (number === changeNumber && isDirty()) setStatus("pending", "草稿已加密，等待同步");
        }
        return true;
      } catch {
        if (isCurrent(epoch)) {
          draftFailed = true;
          setStatus("error", "加密草稿保存失败，请导出备份");
          toast("浏览器未能保存加密草稿，请立即导出备份。" );
        }
        return false;
      }
    }).finally(() => { draftPending--; });
    draftQueue = task.then(() => {});
    return task;
  }

  function clearDraftIfClean() {
    const epoch = session;
    draftQueue = draftQueue.catch(() => {}).then(() => {
      if (isCurrent(epoch) && !isDirty() && !draftFailed) {
        try { transport.clearDraft(); }
        catch { toast("无法清除旧草稿，请检查浏览器存储设置。" ); }
      }
    });
  }

  function scheduleSync(delay = 2500) {
    clearTimeout(syncTimer);
    if (unlocked) syncTimer = setTimeout(() => requestSync(false), delay);
  }

  function historySnapshot() {
    return { ...state, pages: state.pages.map(page => ({ ...page })),
      notes: state.notes.map(note => ({ ...note })), assets: { ...state.assets } };
  }

  function historySelection() {
    return { pageId: viewPageId, noteId: mode === "edit" ? editingId : selectedNoteId, mode,
      start: mode === "edit" ? ui.editorContent.selectionStart : null,
      end: mode === "edit" ? ui.editorContent.selectionEnd : null };
  }

  function rememberHistoryState() {
    historyBefore = historySnapshot();
    historySelectionBefore = historySelection();
  }

  function updateHistoryButtons() {
    for (const button of [ui.undoButton, ui.editorUndoButton]) button.disabled = !unlocked || !journal.canUndo();
    for (const button of [ui.redoButton, ui.editorRedoButton]) button.disabled = !unlocked || !journal.canRedo();
  }

  function applyHistory(direction) {
    if (!unlocked || activeMoveCleanup || paperGesture || imageBusy) return;
    clearTimeout(layoutTimer);
    const result = journal[direction](state);
    if (!result.applied) {
      updateHistoryButtons();
      if (result.conflicts) toast("这一步已被其他设备更新，已保留当前内容。");
      return;
    }
    const previousNotes = new Map(state.notes.map(note => [note.id, note]));
    state = parseData(result.data).data;
    for (const note of state.notes) if (!equal(previousNotes.get(note.id), note)) note.updatedAt = now();
    const selection = result.selection || {};
    if (mode === "edit" && !byId(editingId)) {
      editingId = null; editingWasNew = false; mode = "view"; ui.editorContent.blur();
    }
    if (mode === "edit") {
      viewPageId = byId(editingId).pageId;
      selectedNoteId = touchDevice ? editingId : null;
    } else {
      if (pageById(selection.pageId)) viewPageId = selection.pageId;
      selectedNoteId = touchDevice ? byId(selection.noteId)?.id || null : null;
    }
    applyingHistory = true;
    changed();
    applyingHistory = false;
    render();
    if (mode === "edit") {
      const start = Math.min(ui.editorContent.value.length, selection.start ?? ui.editorContent.value.length);
      const end = Math.min(ui.editorContent.value.length, selection.end ?? start);
      ui.editorContent.setSelectionRange(start, end);
    }
    rememberHistoryState();
    if (mode === "view" && window.history.state?.onePage?.mode === "edit") window.history.back();
    else replaceNavigationState();
    if (result.conflicts) toast("已撤销可恢复的部分；其他设备的新修改已保留。");
  }

  function changed(group = null) {
    if (!unlocked) return;
    if (!applyingHistory && historyBefore) journal.capture(historyBefore, state, {
      group, selectionBefore: historySelectionBefore, selectionAfter: historySelection()
    });
    rememberHistoryState();
    updateHistoryButtons();
    measurementCache.clear();
    changeNumber++;
    setStatus("pending", "正在保存加密草稿…");
    queueDraft();
    scheduleSync();
  }

  function scheduleRetry(code) {
    if (!unlocked || retryTimer) return;
    if (!["NETWORK_ERROR", "RATE_LIMITED", "HTTP_ERROR"].includes(code)) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      requestSync(true);
    }, code === "RATE_LIMITED" ? 60000 : 15000);
  }

  async function refreshRemote(epoch) {
    if (!isCurrent(epoch)) return;
    setStatus("pending", "正在读取私有笔记…");
    const result = await transport.load();
    if (!isCurrent(epoch)) return;
    const incoming = parseData(result.notes);
    const merged = Model.merge(baseline, state, incoming.data);
    baseline = clone(incoming.data);
    state = canonical(merged.data);
    sha = result.sha;
    remoteReady = true;
    migrationPending = migrationPending || incoming.migrated;
    if (editingId && merged.replacements?.[editingId]) editingId = merged.replacements[editingId];
    if (pendingImageTarget?.noteId && merged.replacements?.[pendingImageTarget.noteId]) {
      pendingImageTarget.noteId = merged.replacements[pendingImageTarget.noteId];
    }
    ensurePage();
    setDocumentReady(true);
    render();
    rememberHistoryState();
    if (merged.conflicts) toast(`${merged.conflicts} 处同时修改已保留为独立笔记，请检查冲突标记。`);
    if (isDirty()) {
      changeNumber++;
      queueDraft();
      setStatus("pending", "有修改等待同步");
    } else {
      clearDraftIfClean();
      setStatus("synced", "已与 GitHub 同步");
    }
  }

  async function pushChanges(epoch) {
    if (!isCurrent(epoch)) return;
    if (!remoteReady) await refreshRemote(epoch);
    if (!isCurrent(epoch) || !isDirty()) return;
    for (let attempt = 0; attempt < 4; attempt++) {
      const snapshot = clone(state);
      const expectedSha = sha;
      setStatus("pending", "正在同步到 GitHub…");
      let nextSha;
      try {
        nextSha = await transport.save(snapshot, expectedSha);
      } catch (error) {
        if (error?.code === "CONFLICT") {
          await refreshRemote(epoch);
          if (!isCurrent(epoch) || !isDirty()) return;
          continue;
        }
        throw error;
      }
      if (!isCurrent(epoch)) return;
      baseline = snapshot;
      sha = nextSha;
      migrationPending = false;
      if (isDirty()) {
        queueDraft();
        setStatus("pending", "新修改等待同步");
        scheduleSync();
      } else {
        clearDraftIfClean();
        setStatus("synced", "已与 GitHub 同步");
      }
      return;
    }
    setStatus("pending", "其他设备正在更新，稍后重试");
    scheduleSync(4500);
  }

  function enqueueCloud(task) {
    const epoch = session;
    const job = cloudQueue.catch(() => {}).then(async () => {
      if (!isCurrent(epoch)) return;
      try { await task(epoch); }
      catch (error) {
        if (!isCurrent(epoch)) return;
        const message = errorText(error);
        setStatus("error", message);
        toast(message);
        if (isDirty()) queueDraft();
        scheduleRetry(error?.code);
      }
    });
    cloudQueue = job;
    return job;
  }

  function requestSync(readRemote) {
    if (!unlocked) return Promise.resolve();
    clearTimeout(retryTimer);
    retryTimer = null;
    return enqueueCloud(async epoch => {
      if (readRemote) await refreshRemote(epoch);
      await pushChanges(epoch);
    });
  }

  function startPolling() {
    clearTimeout(pollTimer);
    const epoch = session;
    const poll = async () => {
      if (!isCurrent(epoch)) return;
      if (document.visibilityState === "visible") await requestSync(true);
      if (isCurrent(epoch)) pollTimer = setTimeout(poll, 60000);
    };
    pollTimer = setTimeout(poll, 60000);
  }

  function setAccess(allow) {
    document.querySelector(".main-content").inert = !allow;
    for (const item of [ui.addPageButton, ui.renamePageButton, ui.newNoteButton,
      ui.syncButton, ui.lockButton, ui.importButton, ui.exportButton,
      ui.backButton, ui.editorContent, ui.moveToNewPageButton, ui.deleteButton,
      ui.addImageButton, ui.insertImageButton, ui.zoomSelect]) {
      item.disabled = !allow;
    }
    updateHistoryButtons();
  }

  function setDocumentReady(ready) {
    for (const item of [ui.addPageButton, ui.renamePageButton, ui.newNoteButton,
      ui.importButton, ui.exportButton, ui.addImageButton]) item.disabled = !ready;
  }

  function showAccess(which) {
    ui.setupView.hidden = which !== "setup";
    ui.unlockView.hidden = which !== "unlock";
    ui.setupError.hidden = true;
    ui.unlockError.hidden = true;
    if (!ui.accessDialog.open) ui.accessDialog.showModal();
    setTimeout(() => (which === "setup" ? ui.tokenInput : ui.pinInput).focus(), 0);
  }

  async function lock() {
    if (!unlocked) return;
    setAccess(false);
    clearTimeout(syncTimer);
    setStatus("pending", "正在保存加密草稿…");
    if (!await queueDraft()) {
      setAccess(true);
      setDocumentReady(remoteReady || state.pages.length > 0);
      setStatus("error", "无法安全锁定，请先导出备份");
      toast("加密草稿保存失败，请先导出备份。" );
      return;
    }
    session++;
    unlocked = false;
    journal.reset(); historyBefore = historySelectionBefore = null;
    clearTimeout(longPressTimer); longPressTimer = null;
    activeMoveCleanup?.();
    paperPointers.clear();
    paperGesture = null;
    deferredView = false;
    selectedNoteId = null;
    pageViews.clear();
    zoom = "fit";
    ui.touchNoteHandles.hidden = true;
    document.body.classList.remove("is-editing");
    imageBusy = false;
    imageTarget = null;
    pendingImageTarget = null;
    remoteReady = false;
    setDocumentReady(false);
    for (const timer of [syncTimer, retryTimer, pollTimer, layoutTimer]) clearTimeout(timer);
    syncTimer = retryTimer = pollTimer = layoutTimer = null;
    transport.lock();
    clearAssetUrls();
    state = empty(); baseline = empty(); sha = null;
    viewPageId = editingId = null;
    lastLayout = { placed: [], overflow: [], percent: 0 };
    editingWasNew = false;
    mode = "view";
    ui.editorContent.value = "";
    measurementContent.textContent = "";
    ui.canvas.replaceChildren();
    ui.overflowArea.replaceChildren();
    ui.overflowArea.hidden = true;
    ui.overflowBadge.hidden = true;
    ui.pageTabs.replaceChildren();
    for (const input of [ui.tokenInput, ui.newPinInput, ui.confirmPinInput, ui.pinInput]) input.value = "";
    ui.toast.textContent = "";
    ui.toast.classList.remove("is-visible");
    setStatus("pending", "一页纸已锁定");
    showAccess("unlock");
  }

  function legacyCopyId(id, content) {
    let left = 2166136261;
    let right = 2246822519;
    const value = `${id}\u0000${content}`;
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      left = Math.imul(left ^ code, 16777619);
      right = Math.imul(right ^ code, 1597334677);
    }
    return `legacy-${(left >>> 0).toString(16).padStart(8, "0")}${(right >>> 0).toString(16).padStart(8, "0")}`;
  }

  function appendImported(source, preserveLegacyIds = false) {
    const useExistingPage = preserveLegacyIds && state.pages.length > 0;
    if (state.pages.length + (useExistingPage ? 0 : source.pages.length) > 100 ||
        state.notes.length + source.notes.length > 1000) {
      throw new Error("LIMIT_EXCEEDED");
    }
    const pageMap = new Map();
    validateImportedAssets(source.assets || {});
    state.assets = { ...(state.assets || {}), ...(source.assets || {}) };
    for (const oldPage of source.pages) {
      if (useExistingPage) pageMap.set(oldPage.id, state.pages[0].id);
      else {
        const page = Model.createPage(state.pages.length, PAPER_WIDTH, PAPER_HEIGHT);
        page.name = oldPage.name;
        state.pages.push(page);
        pageMap.set(oldPage.id, page.id);
      }
    }
    let added = 0;
    const usedIds = new Set(state.notes.map(note => note.id));
    for (const oldNote of source.notes) {
      const pageId = pageMap.get(oldNote.pageId) || state.pages.at(-1)?.id;
      if (!pageId) continue;
      const note = Model.createNote(pageId);
      if (preserveLegacyIds) {
        const id = !usedIds.has(oldNote.id) ? oldNote.id : legacyCopyId(oldNote.id, oldNote.content);
        if (!usedIds.has(id)) note.id = id;
      }
      usedIds.add(note.id);
      note.content = oldNote.content;
      note.x = oldNote.x; note.y = oldNote.y;
      note.w = oldNote.w; note.h = oldNote.h;
      note.contentScale = oldNote.contentScale;
      note.layer = oldNote.layer ?? 0;
      note.manualSize = oldNote.manualSize;
      note.manualPosition = oldNote.manualPosition;
      note.createdAt = oldNote.createdAt;
      note.updatedAt = oldNote.updatedAt;
      if (oldNote.legacyTags) note.legacyTags = [...oldNote.legacyTags];
      // Saved overlaps are retained; positions are still constrained to A4.
      state.notes.push(note);
      added++;
    }
    if (source.pages.length) viewPageId = pageMap.get(source.pages[0].id);
    return added;
  }

  async function migrateLegacy(epoch) {
    let raw;
    try { raw = localStorage.getItem(LEGACY_STORAGE_KEY); }
    catch { return; }
    if (!raw || !isCurrent(epoch)) return;
    try {
      const old = parseData(raw).data;
      // A legacy browser may also have uploaded these same notes already.
      // Compare exact bodies before adding a second copy.
      const known = new Map(state.notes.map(note => [note.id, note.content]));
      const missing = old.notes.filter(note =>
        known.get(note.id) !== note.content &&
        known.get(legacyCopyId(note.id, note.content)) !== note.content);
      if (missing.length) {
        const source = { ...old, notes: missing };
        const added = appendImported(source, true);
        changed();
        render();
        if (!await queueDraft()) return;
        toast(`已将 ${added} 篇旧笔记转为加密草稿。`);
      }
      if (isCurrent(epoch)) localStorage.removeItem(LEGACY_STORAGE_KEY);
    } catch {
      if (isCurrent(epoch)) toast("检测到旧版笔记，但尚未完成安全迁移；旧数据仍在本机。" );
    }
  }

  async function enterNotebook() {
    session++;
    const epoch = session;
    unlocked = true;
    journal.reset(); historyBefore = historySelectionBefore = null;
    navigationId = crypto.randomUUID(); navigationBackPending = false;
    remoteReady = false;
    clearAssetUrls();
    setDocumentReady(false);
    draftFailed = false;
    state = empty(); baseline = empty(); sha = null;
    viewPageId = editingId = null;
    mode = "view";
    migrationPending = false;
    ui.accessDialog.close();
    setAccess(true);
    setDocumentReady(false);
    setStatus("pending", "正在读取加密草稿…");
    try {
      const draft = await transport.loadDraft();
      if (!isCurrent(epoch)) return;
      if (draft) {
        const current = parseData(draft.data ?? draft.notes);
        const previous = draft.baseline != null ? parseData(draft.baseline) : { data: empty(), migrated: false };
        state = current.data;
        baseline = previous.data;
        sha = typeof draft.sha === "string" ? draft.sha : null;
        viewPageId = typeof draft.viewPageId === "string" ? draft.viewPageId : state.activePageId;
        migrationPending = Boolean(draft.migrationPending || current.migrated);
      }
    } catch {
      if (isCurrent(epoch)) {
        draftFailed = true;
        toast("本机加密草稿无法读取；将从 GitHub 读取笔记。请勿重设 PIN。" );
      }
    }
    if (!isCurrent(epoch)) return;
    // When no local draft exists, wait for GitHub before making a new page.
    if (state.pages.length) render();
    setDocumentReady(state.pages.length > 0);
    await requestSync(true);
    if (!isCurrent(epoch)) return;
    if (remoteReady) {
      await migrateLegacy(epoch);
      if (isDirty()) requestSync(false);
    }
    startPolling();
    rememberHistoryState();
    replaceNavigationState();
    updateHistoryButtons();
  }

  ui.accessDialog.addEventListener("cancel", event => event.preventDefault());
  ui.setupView.addEventListener("submit", async event => {
    event.preventDefault();
    const pin = ui.newPinInput.value;
    if (pin !== ui.confirmPinInput.value) {
      ui.setupError.textContent = "两次输入的 PIN 不一致。";
      ui.setupError.hidden = false;
      return;
    }
    ui.setupButton.disabled = true;
    ui.setupError.hidden = true;
    try {
      await transport.setup(pin, ui.tokenInput.value);
      ui.tokenInput.value = ui.newPinInput.value = ui.confirmPinInput.value = "";
      await enterNotebook();
    } catch (error) {
      ui.setupError.textContent = errorText(error);
      ui.setupError.hidden = false;
    } finally { ui.setupButton.disabled = false; }
  });

  ui.unlockView.addEventListener("submit", async event => {
    event.preventDefault();
    ui.unlockButton.disabled = true;
    ui.unlockError.hidden = true;
    try {
      await transport.unlock(ui.pinInput.value);
      ui.pinInput.value = "";
      await enterNotebook();
    } catch (error) {
      ui.unlockError.textContent = errorText(error);
      ui.unlockError.hidden = false;
    } finally { ui.unlockButton.disabled = false; }
  });

  ui.resetAccessButton.addEventListener("click", async () => {
    if (!confirm("重新连接会删除这台设备上的加密授权和未同步草稿。请先确认笔记已同步到 GitHub，或已导出备份。确定继续吗？")) return;
    ui.resetAccessButton.disabled = true;
    try {
      await draftQueue.catch(() => {});
      transport.forget();
      showAccess("setup");
    } catch {
      ui.unlockError.textContent = "无法清除本机授权信息，请检查浏览器存储设置。";
      ui.unlockError.hidden = false;
    } finally { ui.resetAccessButton.disabled = false; }
  });

  ui.lockButton.addEventListener("click", lock);
  ui.syncButton.addEventListener("click", () => {
    for (const id of assetLoads.keys()) if (!assetUrls.has(id)) assetLoads.delete(id);
    if (mode === "view") ensurePageImages(currentPage()?.id);
    requestSync(true);
  });
  ui.zoomSelect.addEventListener("change", () => {
    if (ui.zoomSelect.value === "custom") return;
    const anchor = viewportAnchor();
    zoom = ui.zoomSelect.value;
    if (unlocked && mode === "view") { updatePaperScale(anchor); savePageView(); }
  });
  ui.paperViewport.addEventListener("pointerdown", beginPaperGesture);
  ui.paperViewport.addEventListener("pointermove", movePaperGesture, { passive: false });
  ui.paperViewport.addEventListener("pointerup", endPaperGesture);
  ui.paperViewport.addEventListener("pointercancel", endPaperGesture);
  ui.paperViewport.addEventListener("contextmenu", event => { if (touchDevice && unlocked) event.preventDefault(); });
  for (const [button, kind] of [[ui.touchWidthHandle, "width"], [ui.touchScaleHandle, "resize"]]) {
    button.addEventListener("pointerdown", event => {
      const note = byId(selectedNoteId);
      const card = [...ui.canvas.children].find(item => item.dataset.noteId === selectedNoteId);
      if (note && card) beginMove(event, note, card, kind);
    });
    button.addEventListener("click", event => event.preventDefault());
  }
  for (const button of [ui.undoButton, ui.editorUndoButton]) button.addEventListener("click", () => applyHistory("undo"));
  for (const button of [ui.redoButton, ui.editorRedoButton]) button.addEventListener("click", () => applyHistory("redo"));
  ui.addImageButton.addEventListener("click", () => chooseImage(true));
  ui.insertImageButton.addEventListener("click", () => chooseImage(false));
  ui.imageFile.addEventListener("change", () => {
    const file = ui.imageFile.files[0];
    ui.imageFile.value = "";
    if (file) insertImage(file, imageTarget);
    imageTarget = null;
  });
  ui.editorContent.addEventListener("paste", event => {
    const file = [...(event.clipboardData?.files || [])].find(item => item.type.startsWith("image/"));
    if (!file || !unlocked || imageBusy) return;
    event.preventDefault();
    insertImage(file, { independent: false, noteId: editingId,
      start: ui.editorContent.selectionStart, end: ui.editorContent.selectionEnd,
      content: byId(editingId)?.content });
  });
  ui.canvas.addEventListener("dragover", event => {
    if (unlocked && [...(event.dataTransfer?.items || [])].some(item => item.kind === "file")) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    }
  });
  ui.canvas.addEventListener("drop", event => {
    const file = [...(event.dataTransfer?.files || [])].find(item => item.type.startsWith("image/"));
    if (!file || !unlocked || imageBusy) return;
    event.preventDefault();
    const box = ui.canvas.getBoundingClientRect();
    insertImage(file, { independent: true, pageId: currentPage()?.id,
      x: Math.max(Layout.MARGIN, (event.clientX - box.left) / currentScale),
      y: Math.max(Layout.MARGIN, (event.clientY - box.top) / currentScale) });
  });
  ui.pageTabs.setAttribute("role", "tablist");
  ui.addPageButton.addEventListener("click", () => {
    if (!unlocked || (!remoteReady && !state.pages.length)) return;
    if (state.pages.length >= 100) { toast("最多可建立 100 张一页纸。" ); return; }
    const page = Model.createPage(state.pages.length, PAPER_WIDTH, PAPER_HEIGHT);
    savePageView();
    selectedNoteId = null;
    state.pages.push(page);
    viewPageId = page.id;
    state.activePageId = page.id;
    mode = "view";
    changed();
    render();
    restorePageView(page.id);
    replaceNavigationState();
  });
  ui.renamePageButton.addEventListener("click", () => {
    if (!unlocked) return;
    const page = currentPage();
    if (!page) return;
    const next = prompt("这张一页纸的名称", page.name);
    if (next === null || !next.trim()) return;
    const name = next.trim().slice(0, 100);
    if (name === page.name) return;
    page.name = name;
    page.updatedAt = now();
    changed();
    renderTabs();
  });
  ui.newNoteButton.addEventListener("click", () => {
    if (!unlocked || (!remoteReady && !state.pages.length)) return;
    if (state.notes.length >= 1000) { toast("最多可保存 1000 篇笔记。" ); return; }
    ensurePage();
    const note = Model.createNote(currentPage().id);
    state.notes.push(note);
    changed();
    enterEdit(note.id, true);
  });
  ui.backButton.addEventListener("click", () => leaveEdit());
  ui.editorContent.addEventListener("input", () => {
    if (!unlocked || mode !== "edit") return;
    const note = byId(editingId);
    if (!note) return;
    note.content = ui.editorContent.value;
    note.updatedAt = now();
    changed(`typing:${note.id}`);
    clearTimeout(layoutTimer);
    layoutTimer = setTimeout(renderEdit, 180);
  });
  ui.moveToNewPageButton.addEventListener("click", () => {
    if (!unlocked || mode !== "edit") return;
    const note = byId(editingId);
    if (!note || state.pages.length >= 100) return;
    const page = Model.createPage(state.pages.length, PAPER_WIDTH, PAPER_HEIGHT);
    state.pages.push(page);
    note.pageId = page.id;
    note.x = note.y = note.w = note.h = null;
    note.manualSize = note.manualPosition = false;
    note.updatedAt = now();
    viewPageId = page.id;
    state.activePageId = page.id;
    changed();
    render();
    toast("已移到新的一页纸。" );
  });
  ui.deleteButton.addEventListener("click", () => {
    if (!unlocked || mode !== "edit") return;
    const note = byId(editingId);
    if (!note) return;
    state.notes = state.notes.filter(item => item.id !== note.id);
    editingId = null;
    editingWasNew = false;
    selectedNoteId = null;
    ui.editorContent.blur();
    mode = "view";
    changed();
    render();
    restorePageView(viewPageId);
    if (window.history.state?.onePage?.mode === "edit") window.history.back();
    else replaceNavigationState();
    requestAnimationFrame(() => window.scrollTo(returnScroll.x, returnScroll.y));
    toast("笔记已删除，可撤销。" );
  });

  function bytesToBase64(bytes) {
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  }

  function backupBytes(value) {
    if (typeof value !== "string" || value.length > 1_400_000) throw new Error("INVALID_BACKUP_IMAGE");
    const binary = atob(value);
    return Uint8Array.from(binary, character => character.charCodeAt(0));
  }

  function validateImportedAssets(assets) {
    if (new Set([...Object.keys(state.assets || {}), ...Object.keys(assets)]).size > 3000) {
      throw new Error("LIMIT_EXCEEDED");
    }
    for (const [id, asset] of Object.entries(assets)) {
      if (state.assets?.[id] && !equal(state.assets[id], asset)) {
        const error = new Error("备份中的图片信息与现有图片不一致，请使用原始备份。");
        error.code = "ASSET_CONFLICT";
        throw error;
      }
    }
  }

  ui.exportButton.addEventListener("click", async () => {
    if (!unlocked) return;
    const epoch = session;
    const snapshot = clone(state);
    ui.exportButton.disabled = true;
    try {
      const assetFiles = {};
      for (const asset of Object.values(snapshot.assets || {})) {
        const bytes = await transport.loadAsset(asset);
        if (!isCurrent(epoch)) return;
        assetFiles[asset.id] = bytesToBase64(bytes);
      }
      const payload = JSON.stringify({ ...snapshot, assetFiles, exportedAt: now() }, null, 2);
      const url = URL.createObjectURL(new Blob([payload], { type: "application/json;charset=utf-8" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `一页纸备份-${now().slice(0, 10)}.json`;
      document.body.append(link);
      link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast("正文和图片已一起导出，请妥善保存。" );
    } catch (error) {
      if (isCurrent(epoch)) toast(`备份未完成：${errorText(error)}`);
    } finally { if (isCurrent(epoch)) ui.exportButton.disabled = false; }
  });
  ui.importButton.addEventListener("click", () => { if (unlocked) ui.importFile.click(); });
  ui.importFile.addEventListener("change", async () => {
    const epoch = session;
    const file = ui.importFile.files[0];
    ui.importFile.value = "";
    if (!file || !isCurrent(epoch) || (!remoteReady && !state.pages.length)) return;
    if (file.size > 50 * 1024 * 1024) { toast("文件超过 50 MB，请选择较小的备份。" ); return; }
    if (imageBusy) { toast("图片正在保存，请稍后导入。" ); return; }
    imageBusy = true;
    ui.importButton.disabled = true;
    try {
      const raw = JSON.parse(await file.text());
      if (!isCurrent(epoch)) return;
      const parsed = parseData(raw);
      validateImportedAssets(parsed.data.assets || {});
      if (state.pages.length + parsed.data.pages.length > 100 || state.notes.length + parsed.data.notes.length > 1000) {
        throw new Error("LIMIT_EXCEEDED");
      }
      for (const asset of Object.values(parsed.data.assets || {})) {
        if (raw.assetFiles?.[asset.id]) await uploadPrivateAsset(asset, backupBytes(raw.assetFiles[asset.id]));
        else await transport.loadAsset(asset);
        if (!isCurrent(epoch)) return;
      }
      const count = appendImported(parsed.data);
      changed();
      render();
      toast(`已导入 ${count} 篇笔记，原有内容仍保留。`);
    } catch (error) {
      if (isCurrent(epoch)) toast(error?.message === "LIMIT_EXCEEDED"
        ? "导入后会超过页面或笔记数量上限。" : "导入失败：备份格式或图片文件不完整，原有笔记已保留。" );
    } finally {
      if (isCurrent(epoch)) {
        imageBusy = false;
        ui.importButton.disabled = false;
      }
    }
  });

  window.addEventListener("online", () => { if (unlocked) requestSync(true); });
  window.addEventListener("focus", () => { if (unlocked) requestSync(true); });
  document.addEventListener("visibilitychange", () => {
    if (unlocked && document.visibilityState === "visible") requestSync(true);
  });
  window.addEventListener("popstate", event => {
    navigationBackPending = false;
    if (!unlocked) return;
    const destination = event.state?.onePage;
    if (destination?.session === navigationId && destination.mode === "edit" && byId(destination.noteId)) {
      if (mode === "view") enterEdit(destination.noteId, false, true);
    } else {
      if (mode === "edit") leaveEdit(true);
      if (destination?.session === navigationId && pageById(destination.pageId) && destination.pageId !== viewPageId) {
        selectPage(destination.pageId);
      }
      replaceNavigationState();
    }
  });
  document.addEventListener("keydown", event => {
    if (!unlocked || ui.accessDialog.open || !(event.ctrlKey || event.metaKey) || event.altKey) return;
    if (event.key.toLowerCase() === "z" || (event.ctrlKey && event.key.toLowerCase() === "y")) {
      event.preventDefault();
      applyHistory(event.shiftKey || event.key.toLowerCase() === "y" ? "redo" : "undo");
    }
  });
  function resizeViewport() {
    updateMobileViewport();
    if (unlocked && mode === "view" && !paperGesture && !activeMoveCleanup) {
      updatePaperScale(viewportAnchor());
    }
  }
  window.addEventListener("resize", resizeViewport);
  window.visualViewport?.addEventListener("resize", resizeViewport);
  window.visualViewport?.addEventListener("scroll", updateMobileViewport);
  window.addEventListener("beforeunload", event => {
    if (unlocked && (draftPending > 0 || draftFailed || imageBusy)) {
      event.preventDefault();
      event.returnValue = "";
    }
  });

  setAccess(false);
  setStatus("pending", "一页纸已锁定");
  try { showAccess(transport.isConfigured() ? "unlock" : "setup"); }
  catch { showAccess("setup"); }
})();
