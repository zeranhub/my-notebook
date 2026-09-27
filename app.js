(() => {
  "use strict";

  const PAPER_WIDTH = 794;
  const PAPER_HEIGHT = 1123;
  const LEGACY_STORAGE_KEY = "personal-notebook-v1";
  const $ = id => document.getElementById(id);
  const ui = {
    pageTabs: $("pageTabs"), addPageButton: $("addPageButton"), renamePageButton: $("renamePageButton"),
    newNoteButton: $("newNoteButton"), canvasViewport: $("canvasViewport"), canvas: $("canvas"),
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
  const empty = () => ({ version: 2, pages: [], notes: [], activePageId: null });
  const clone = value => JSON.parse(JSON.stringify(value));
  const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  // Parsing an old file can assign fresh migration timestamps. A page becomes
  // dirty only when its user-visible data or geometry changes.
  const signature = value => JSON.stringify({
    pages: value.pages.map(p => [p.id, p.name, p.width, p.height, p.conflictOf || null]),
    notes: value.notes.map(n => [n.id, n.pageId, n.content, n.x, n.y, n.w, n.h,
      n.manualSize, n.manualPosition, n.conflictOf || null, n.legacyTags || null])
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

  function canonical(parsed) {
    return {
      version: 2,
      pages: clone(parsed.pages),
      notes: clone(parsed.notes),
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
      INVALID_TOKEN: "请输入 GitHub 访问令牌。"
    };
    return messages[error?.code] || "操作失败，请稍后重试。";
  }

  function toast(message) {
    ui.toast.textContent = message;
    ui.toast.classList.add("is-visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ui.toast.classList.remove("is-visible"), 4600);
  }

  // Measure the very same card style used on the paper. Text is assigned through
  // textContent, so pasted HTML and Markdown remain ordinary, literal text.
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

  function measureHeight(width, text) {
    measurement.style.width = `${Math.ceil(width)}px`;
    measurement.style.height = "auto";
    measurementContent.textContent = text || " ";
    const height = Math.ceil(Math.max(measurement.scrollHeight, measurement.getBoundingClientRect().height));
    measurementContent.textContent = "";
    return height;
  }

  function desiredSize(note, page) {
    const bounds = { w: page.width, h: page.height };
    if (note.manualSize && Number.isFinite(note.w) && Number.isFinite(note.h)) {
      const w = Math.max(240, Math.min(page.width - 32, Math.ceil(note.w)));
      const h = Math.max(88, Math.ceil(note.h), measureHeight(w, note.content) + 2);
      return h <= page.height - 32 ? { w, h } : null;
    }
    return Layout.makeRectSize(note.content, measureHeight, bounds, {
      minWidth: 240, minHeight: 88, maxWidth: page.width - 32,
      preferredWidth: Number.isFinite(note.w) ? note.w : undefined
    });
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
      const size = desiredSize(note, page);
      if (!size) { overflow.push(note); continue; }
      const preferred = note.manualPosition && Number.isFinite(note.x) && Number.isFinite(note.y)
        ? { x: note.x, y: note.y } : null;
      const position = Layout.findPlacement(placed, size, { w: page.width, h: page.height }, preferred);
      if (!position) { overflow.push(note); continue; }
      const rect = { id: note.id, x: position.x, y: position.y, w: size.w, h: size.h };
      placed.push(rect);
    }
    const usable = Math.max(1, (page.width - 32) * (page.height - 32));
    const percent = Math.min(100, Math.round(100 * placed.reduce((sum, r) => sum + r.w * r.h, 0) / usable));
    return { placed, overflow, percent };
  }

  function updatePaperScale() {
    const page = currentPage();
    if (!page || !unlocked) return;
    const roomWidth = Math.max(220, ui.viewMode.clientWidth - 32);
    const roomHeight = Math.max(360, window.innerHeight - ui.viewMode.getBoundingClientRect().top - 45);
    currentScale = Math.max(0.2, Math.min(1, roomWidth / page.width, roomHeight / page.height));
    ui.canvasViewport.style.setProperty("--page-scale", String(currentScale));
    ui.canvasViewport.style.setProperty("--scaled-page-width", `${Math.round(page.width * currentScale)}px`);
    ui.canvasViewport.style.setProperty("--scaled-page-height", `${Math.round(page.height * currentScale)}px`);
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
    content.textContent = note.content;
    card.append(content);
    if (!overflow) {
      const resize = document.createElement("button");
      resize.type = "button";
      resize.className = "resize-handle";
      resize.setAttribute("aria-label", "调整笔记框大小");
      resize.title = "调整大小";
      resize.addEventListener("pointerdown", event => beginMove(event, note, card, "resize"));
      resize.addEventListener("click", event => event.stopPropagation());
      card.append(resize);
    }
    card.addEventListener("click", () => {
      if (Date.now() >= suppressClickUntil) enterEdit(note.id);
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
    renderTabs();
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
    if (mode === "view") renderView();
    else { renderTabs(); renderEdit(); }
  }

  function selectPage(id) {
    if (!unlocked || !pageById(id)) return;
    viewPageId = id;
    mode = "view";
    editingId = null;
    render();
  }

  function enterEdit(id, isNew = false) {
    if (!unlocked) return;
    const note = byId(id);
    if (!note) return;
    returnScroll = { x: window.scrollX, y: window.scrollY };
    viewPageId = note.pageId;
    editingId = id;
    editingWasNew = isNew;
    mode = "edit";
    render();
    ui.editorContent.focus();
    ui.editorContent.setSelectionRange(ui.editorContent.value.length, ui.editorContent.value.length);
  }

  function leaveEdit() {
    if (!unlocked) return;
    clearTimeout(layoutTimer);
    const note = byId(editingId);
    if (note && editingWasNew && note.content.length === 0) {
      state.notes = state.notes.filter(item => item.id !== note.id);
      changed();
    }
    if (note) viewPageId = note.pageId;
    editingId = null;
    editingWasNew = false;
    mode = "view";
    render();
    requestAnimationFrame(() => window.scrollTo(returnScroll.x, returnScroll.y));
  }

  function beginMove(event, note, card, kind) {
    if (!unlocked || mode !== "view" || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const page = currentPage();
    if (!page || note.pageId !== page.id) return;
    const placed = lastLayout.placed.find(rect => rect.id === note.id);
    if (!placed) return;
    const start = { x: placed.x, y: placed.y, w: placed.w, h: placed.h };
    const origin = { x: event.clientX, y: event.clientY };
    const existing = lastLayout.placed.filter(rect => rect.id !== note.id);
    let candidate = { ...start };
    let moved = false;
    const onMove = move => {
      if (move.pointerId !== event.pointerId) return;
      const dx = (move.clientX - origin.x) / currentScale;
      const dy = (move.clientY - origin.y) / currentScale;
      if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
      const snap = value => Math.round(value / 4) * 4;
      const next = kind === "drag"
        ? { ...start, x: snap(start.x + dx), y: snap(start.y + dy) }
        : { ...start, w: snap(Math.max(240, start.w + dx)), h: snap(Math.max(88, start.h + dy)) };
      if (kind === "resize" && next.h < measureHeight(next.w, note.content) + 2) {
        card.classList.add("is-invalid");
        return;
      }
      if (!Layout.isValidRect(next, existing, { w: page.width, h: page.height })) {
        card.classList.add("is-invalid");
        return;
      }
      card.classList.remove("is-invalid");
      candidate = next;
      card.style.left = `${next.x}px`;
      card.style.top = `${next.y}px`;
      card.style.width = `${next.w}px`;
      card.style.height = `${next.h}px`;
    };
    const onUp = up => {
      if (up.pointerId !== event.pointerId) return;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      card.classList.remove("is-invalid");
      if (moved) suppressClickUntil = Date.now() + 350;
      if (!equal(candidate, start)) {
        note.x = candidate.x; note.y = candidate.y;
        note.w = candidate.w; note.h = candidate.h;
        if (kind === "drag") note.manualPosition = true;
        else { note.manualPosition = true; note.manualSize = true; }
        note.updatedAt = now();
        changed();
      }
      renderView();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
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

  function changed() {
    if (!unlocked) return;
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
    ensurePage();
    setDocumentReady(true);
    render();
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
      ui.backButton, ui.editorContent, ui.moveToNewPageButton, ui.deleteButton]) {
      item.disabled = !allow;
    }
  }

  function setDocumentReady(ready) {
    for (const item of [ui.addPageButton, ui.renamePageButton, ui.newNoteButton,
      ui.importButton, ui.exportButton]) item.disabled = !ready;
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
    remoteReady = false;
    setDocumentReady(false);
    for (const timer of [syncTimer, retryTimer, pollTimer, layoutTimer]) clearTimeout(timer);
    syncTimer = retryTimer = pollTimer = layoutTimer = null;
    transport.lock();
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
      note.manualSize = oldNote.manualSize;
      note.manualPosition = oldNote.manualPosition;
      note.createdAt = oldNote.createdAt;
      note.updatedAt = oldNote.updatedAt;
      if (oldNote.legacyTags) note.legacyTags = [...oldNote.legacyTags];
      // Invalid or colliding saved positions are repacked by layoutPage.
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
    remoteReady = false;
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
  ui.syncButton.addEventListener("click", () => requestSync(true));
  ui.pageTabs.setAttribute("role", "tablist");
  ui.addPageButton.addEventListener("click", () => {
    if (!unlocked || (!remoteReady && !state.pages.length)) return;
    if (state.pages.length >= 100) { toast("最多可建立 100 张一页纸。" ); return; }
    const page = Model.createPage(state.pages.length, PAPER_WIDTH, PAPER_HEIGHT);
    state.pages.push(page);
    viewPageId = page.id;
    state.activePageId = page.id;
    mode = "view";
    changed();
    render();
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
  ui.backButton.addEventListener("click", leaveEdit);
  ui.editorContent.addEventListener("input", () => {
    if (!unlocked || mode !== "edit") return;
    const note = byId(editingId);
    if (!note) return;
    note.content = ui.editorContent.value;
    note.updatedAt = now();
    changed();
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
    if (!note || !confirm("确定删除这篇笔记吗？删除后无法撤销。")) return;
    state.notes = state.notes.filter(item => item.id !== note.id);
    editingId = null;
    editingWasNew = false;
    mode = "view";
    changed();
    render();
    requestAnimationFrame(() => window.scrollTo(returnScroll.x, returnScroll.y));
    toast("笔记已删除。" );
  });

  ui.exportButton.addEventListener("click", () => {
    if (!unlocked) return;
    const payload = JSON.stringify({ ...state, exportedAt: now() }, null, 2);
    const url = URL.createObjectURL(new Blob([payload], { type: "application/json;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `一页纸备份-${now().slice(0, 10)}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast("备份已导出，请妥善保存文件。" );
  });
  ui.importButton.addEventListener("click", () => { if (unlocked) ui.importFile.click(); });
  ui.importFile.addEventListener("change", async () => {
    const epoch = session;
    const file = ui.importFile.files[0];
    ui.importFile.value = "";
    if (!file || !isCurrent(epoch) || (!remoteReady && !state.pages.length)) return;
    if (file.size > 5 * 1024 * 1024) { toast("文件超过 5 MB，请选择较小的备份。" ); return; }
    try {
      const raw = JSON.parse(await file.text());
      if (!isCurrent(epoch)) return;
      const parsed = parseData(raw);
      const count = appendImported(parsed.data);
      changed();
      render();
      toast(`已导入 ${count} 篇笔记，原有内容仍保留。`);
    } catch (error) {
      if (isCurrent(epoch)) toast(error?.message === "LIMIT_EXCEEDED"
        ? "导入后会超过页面或笔记数量上限。" : "导入失败：请选择本笔记本的 JSON 备份。" );
    }
  });

  window.addEventListener("online", () => { if (unlocked) requestSync(true); });
  window.addEventListener("focus", () => { if (unlocked) requestSync(true); });
  document.addEventListener("visibilitychange", () => {
    if (unlocked && document.visibilityState === "visible") requestSync(true);
  });
  window.addEventListener("resize", () => { if (unlocked && mode === "view") updatePaperScale(); });
  window.addEventListener("beforeunload", event => {
    if (unlocked && (draftPending > 0 || draftFailed)) {
      event.preventDefault();
      event.returnValue = "";
    }
  });

  setAccess(false);
  setStatus("pending", "一页纸已锁定");
  try { showAccess(transport.isConfigured() ? "unlock" : "setup"); }
  catch { showAccess("setup"); }
})();
