(function () {
  "use strict";

  const LEGACY_STORAGE_KEY = "personal-notebook-v1";
  const $ = (id) => document.getElementById(id);
  const elements = {
    newButton: $("newButton"), importButton: $("importButton"), exportButton: $("exportButton"),
    importFile: $("importFile"), searchInput: $("searchInput"), clearTagButton: $("clearTagButton"),
    tagFilters: $("tagFilters"), noteCount: $("noteCount"), noteList: $("noteList"),
    deleteButton: $("deleteButton"), currentBreadcrumb: $("currentBreadcrumb"),
    titleInput: $("titleInput"), updatedLabel: $("updatedLabel"), saveLabel: $("saveLabel"),
    tagInput: $("tagInput"), contentInput: $("contentInput"), previewContent: $("previewContent"),
    editTab: $("editTab"), previewTab: $("previewTab"), contentPanes: document.querySelector(".content-panes"),
    toast: $("toast"), syncLabel: $("syncLabel"), syncButton: $("syncButton"),
    lockButton: $("lockButton"), accessDialog: $("accessDialog"),
    setupView: $("setupView"), unlockView: $("unlockView"),
    tokenInput: $("tokenInput"), newPinInput: $("newPinInput"),
    confirmPinInput: $("confirmPinInput"), pinInput: $("pinInput"),
    setupButton: $("setupButton"), unlockButton: $("unlockButton"),
    setupError: $("setupError"), unlockError: $("unlockError"),
    resetAccessButton: $("resetAccessButton")
  };

  const transport = new window.NotebookSync({
    owner: "zeranhub", repo: "personal-notes-data", path: "data/notes.json"
  });
  let notes = [];
  let baseline = [];
  let sha = null;
  let activeId = null;
  let selectedTag = "";
  let toastTimer;
  let syncTimer;
  let retryTimer;
  let pollTimer;
  let draftQueue = Promise.resolve();
  let cloudQueue = Promise.resolve();
  let session = 0;
  let changeNumber = 0;
  let unlocked = false;
  let remoteReady = false;
  let draftFailed = false;
  let draftPending = 0;
  let cloudErrorMessage = null;

  function makeId() {
    return typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function makeBlankNote() {
    const now = new Date().toISOString();
    return { id: makeId(), title: "", content: "", tags: [], createdAt: now, updatedAt: now };
  }

  function normalizeNote(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const now = new Date().toISOString();
    return {
      id: typeof value.id === "string" && value.id.length < 200 ? value.id : makeId(),
      title: typeof value.title === "string" ? value.title.slice(0, 160) : "",
      content: typeof value.content === "string" ? value.content.slice(0, 300000) : "",
      tags: Array.isArray(value.tags) ? [...new Set(value.tags.filter(t => typeof t === "string").map(t => t.trim().slice(0, 40)).filter(Boolean))].slice(0, 20) : [],
      createdAt: !isNaN(Date.parse(value.createdAt)) ? value.createdAt : now,
      updatedAt: !isNaN(Date.parse(value.updatedAt)) ? value.updatedAt : now
    };
  }

  function copy(value) { return JSON.parse(JSON.stringify(value)); }
  function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
  function isCurrent(epoch) { return unlocked && epoch === session; }
  function isDirty() { return !same(notes, baseline); }

  function parseNotes(value) {
    const list = Array.isArray(value) ? value : value?.notes;
    if (!Array.isArray(list) || list.length > 10000) throw new Error("INVALID_NOTES");
    if (list.some(note => !note || typeof note.id !== "string" || !note.id || note.id.length >= 200)) {
      throw new Error("INVALID_NOTES");
    }
    const result = list.map(normalizeNote);
    if (result.some(note => !note) || new Set(result.map(note => note.id)).size !== result.length) {
      throw new Error("INVALID_NOTES");
    }
    return result;
  }

  function setStatus(kind, label) {
    elements.syncLabel.textContent = label;
    elements.saveLabel.textContent = label;
    const wrapper = elements.syncLabel.parentElement;
    wrapper.classList.toggle("is-synced", kind === "synced");
    wrapper.classList.toggle("is-error", kind === "error");
  }

  function safeError(error) {
    const messages = {
      NETWORK_ERROR: "无法连接 GitHub，请检查网络。加密草稿仍保存在这台设备。",
      RATE_LIMITED: "GitHub 请求次数暂时达到上限，稍后会重试。",
      UNAUTHORIZED: "GitHub 令牌已失效，请重新连接。",
      FORBIDDEN: "GitHub 拒绝访问，请检查令牌的 Contents 读写权限。",
      NOT_FOUND: "找不到私有笔记仓库或 data/notes.json 文件。",
      REPOSITORY_PUBLIC: "笔记仓库必须是私有仓库。",
      TOO_LARGE: "笔记文件超过 GitHub 的 1 MB 限制，请导出备份并精简内容。",
      STORAGE_UNAVAILABLE: "浏览器无法保存加密草稿，请立即导出备份。",
      DRAFT_CORRUPT: "本机加密草稿无法解密，请检查是否更换了 PIN。",
      INVALID_DATA: "GitHub 上的笔记文件格式有误。",
      INVALID_NOTES: "GitHub 上的笔记文件格式有误。",
      UNSUPPORTED: "此浏览器不支持安全加密，请换用新版浏览器。",
      UNLOCK_FAILED: "PIN 错误，或本地授权信息已损坏。",
      INVALID_PIN: "请输入恰好 6 位数字 PIN。",
      INVALID_TOKEN: "请输入 GitHub 访问令牌。"
    };
    return messages[error?.code || error?.message] || "操作失败，请稍后重试。";
  }

  function showToast(message) {
    elements.toast.textContent = message;
    elements.toast.classList.add("is-visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => elements.toast.classList.remove("is-visible"), 4300);
  }

  function currentNote() { return notes.find(note => note.id === activeId); }
  function noteTitle(note) { return note.title.trim() || "未命名笔记"; }
  function formatDate(value) {
    return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
  }

  function touch(note) {
    note.updatedAt = new Date().toISOString();
    elements.updatedLabel.textContent = `更新于 ${formatDate(note.updatedAt)}`;
    changed();
  }

  function renderFilters() {
    elements.tagFilters.replaceChildren();
    const tags = [...new Set(notes.flatMap(note => note.tags))].sort((a, b) => a.localeCompare(b, "zh-CN"));
    if (selectedTag && !tags.includes(selectedTag)) selectedTag = "";
    elements.clearTagButton.hidden = !selectedTag;
    if (!tags.length) {
      const empty = document.createElement("span");
      empty.className = "no-tags";
      empty.textContent = "还没有标签";
      elements.tagFilters.append(empty);
      return;
    }
    for (const tag of tags) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "tag-filter";
      button.textContent = tag;
      button.setAttribute("aria-pressed", String(selectedTag === tag));
      button.addEventListener("click", () => { selectedTag = selectedTag === tag ? "" : tag; renderSidebar(); });
      elements.tagFilters.append(button);
    }
  }

  function renderSidebar() {
    renderFilters();
    const query = elements.searchInput.value.trim().toLocaleLowerCase();
    const matching = notes.filter(note =>
      (!selectedTag || note.tags.includes(selectedTag)) &&
      (!query || `${note.title} ${note.content} ${note.tags.join(" ")}`.toLocaleLowerCase().includes(query))
    ).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    elements.noteCount.textContent = String(matching.length);
    elements.noteList.replaceChildren();
    if (!matching.length) {
      const empty = document.createElement("div");
      empty.className = "list-empty";
      empty.textContent = "没有找到笔记，试试其他关键词或标签。";
      elements.noteList.append(empty);
      return;
    }
    for (const note of matching) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = `note-item${note.id === activeId ? " is-active" : ""}`;
      item.setAttribute("aria-label", `打开笔记：${noteTitle(note)}`);
      const title = document.createElement("span");
      title.className = "note-item-title";
      title.textContent = noteTitle(note);
      const excerpt = document.createElement("span");
      excerpt.className = "note-item-excerpt";
      excerpt.textContent = note.content.replace(/[#*`>\[\]\n]/g, " ").trim() || "空白笔记";
      const bottom = document.createElement("span");
      bottom.className = "note-item-bottom";
      const date = document.createElement("span");
      date.textContent = formatDate(note.updatedAt);
      bottom.append(date);
      if (note.tags.length) {
        const tag = document.createElement("span");
        tag.className = "note-item-tag";
        tag.textContent = note.tags[0];
        bottom.append(tag);
      }
      item.append(title, excerpt, bottom);
      item.addEventListener("click", () => { activeId = note.id; renderSidebar(); renderEditor(); });
      elements.noteList.append(item);
    }
  }

  function escapeHtml(text) {
    return text.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  }

  function formatPlain(text) {
    return escapeHtml(text).replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
  }

  function renderInline(text) {
    const pattern = /`([^`\n]+)`|\[([^\]\n]+)\]\(([^\s)]+)\)/g;
    let result = "";
    let offset = 0;
    for (const match of text.matchAll(pattern)) {
      result += formatPlain(text.slice(offset, match.index));
      if (match[1] !== undefined) {
        result += `<code>${escapeHtml(match[1])}</code>`;
      } else {
        const href = match[3];
        let allowed = false;
        try { allowed = ["http:", "https:", "mailto:"].includes(new URL(href).protocol); } catch (_error) { /* invalid URL */ }
        result += allowed
          ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${formatPlain(match[2])}</a>`
          : formatPlain(match[2]);
      }
      offset = match.index + match[0].length;
    }
    return result + formatPlain(text.slice(offset));
  }

  function renderMarkdown(source) {
    if (!source.trim()) return '<p class="preview-empty">预览将在这里显示。</p>';
    const lines = source.replace(/\r\n?/g, "\n").split("\n");
    const html = [];
    let listType = "";
    let paragraph = [];
    let codeLines = [];
    let inCode = false;
    const flushParagraph = () => {
      if (paragraph.length) { html.push(`<p>${paragraph.map(renderInline).join("<br>")}</p>`); paragraph = []; }
    };
    const closeList = () => { if (listType) { html.push(`</${listType}>`); listType = ""; } };
    for (const line of lines) {
      if (/^\s*```/.test(line)) {
        flushParagraph(); closeList();
        if (inCode) { html.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`); codeLines = []; }
        inCode = !inCode;
        continue;
      }
      if (inCode) { codeLines.push(line); continue; }
      if (!line.trim()) { flushParagraph(); closeList(); continue; }
      const heading = line.match(/^(#{1,3})\s+(.+)$/);
      if (heading) { flushParagraph(); closeList(); html.push(`<h${heading[1].length}>${renderInline(heading[2])}</h${heading[1].length}>`); continue; }
      if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) { flushParagraph(); closeList(); html.push("<hr>"); continue; }
      const quote = line.match(/^>\s?(.*)$/);
      if (quote) { flushParagraph(); closeList(); html.push(`<blockquote>${renderInline(quote[1])}</blockquote>`); continue; }
      const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
      const ordered = line.match(/^\s*\d+\.\s+(.+)$/);
      if (unordered || ordered) {
        flushParagraph();
        const type = unordered ? "ul" : "ol";
        if (listType !== type) { closeList(); html.push(`<${type}>`); listType = type; }
        html.push(`<li>${renderInline((unordered || ordered)[1])}</li>`);
        continue;
      }
      closeList(); paragraph.push(line);
    }
    if (inCode) html.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
    flushParagraph(); closeList();
    return html.join("\n");
  }

  function updatePreview() { elements.previewContent.innerHTML = renderMarkdown(elements.contentInput.value); }

  function renderEditor() {
    const note = currentNote();
    if (!note) {
      elements.titleInput.value = "";
      elements.tagInput.value = "";
      elements.contentInput.value = "";
      elements.currentBreadcrumb.textContent = "未命名笔记";
      elements.updatedLabel.textContent = "";
      elements.previewContent.replaceChildren();
      return;
    }
    if (elements.titleInput.value !== note.title) elements.titleInput.value = note.title;
    if (elements.tagInput.value !== note.tags.join(", ")) elements.tagInput.value = note.tags.join(", ");
    if (elements.contentInput.value !== note.content) elements.contentInput.value = note.content;
    elements.currentBreadcrumb.textContent = noteTitle(note);
    elements.updatedLabel.textContent = `更新于 ${formatDate(note.updatedAt)}`;
    updatePreview();
  }

  function setView(view) {
    elements.contentPanes.dataset.view = view;
    elements.editTab.classList.toggle("is-active", view === "edit");
    elements.previewTab.classList.toggle("is-active", view === "preview");
    elements.editTab.setAttribute("aria-selected", String(view === "edit"));
    elements.previewTab.setAttribute("aria-selected", String(view === "preview"));
  }

  function mergeVersions(baseNotes, localNotes, remoteNotes) {
    const base = new Map(baseNotes.map(note => [note.id, note]));
    const local = new Map(localNotes.map(note => [note.id, note]));
    const remote = new Map(remoteNotes.map(note => [note.id, note]));
    const ids = new Set([...remote.keys(), ...local.keys(), ...base.keys()]);
    const merged = [];
    let conflictCount = 0;
    let replacementActiveId = null;
    for (const id of ids) {
      const old = base.get(id);
      const mine = local.get(id);
      const theirs = remote.get(id);
      const myChanged = !same(mine, old);
      const theirChanged = !same(theirs, old);
      if (!myChanged) {
        if (theirs) merged.push(copy(theirs));
      } else if (!theirChanged || same(mine, theirs)) {
        if (mine) merged.push(copy(mine));
      } else {
        if (theirs) merged.push(copy(theirs));
        if (mine) {
          const duplicate = copy(mine);
          duplicate.id = makeId();
          duplicate.title = `${noteTitle(mine).slice(0, 145)}（冲突副本）`.slice(0, 160);
          duplicate.updatedAt = new Date().toISOString();
          merged.push(duplicate);
          if (activeId === id) replacementActiveId = duplicate.id;
        }
        conflictCount++;
      }
    }
    return { merged, conflictCount, replacementActiveId };
  }

  function ensureActive() {
    if (!notes.some(note => note.id === activeId)) activeId = notes[0]?.id || null;
  }

  function renderAll() {
    ensureActive();
    renderSidebar();
    renderEditor();
  }

  function queueDraft() {
    const epoch = session;
    const number = changeNumber;
    const snapshot = {
      version: 2, notes: copy(notes), baseline: copy(baseline),
      sha, activeId
    };
    draftPending++;
    const task = draftQueue.catch(() => {}).then(async () => {
      if (!isCurrent(epoch)) return false;
      try {
        await transport.saveDraft(snapshot);
        if (isCurrent(epoch)) {
          draftFailed = false;
          if (number === changeNumber && isDirty()) {
            if (cloudErrorMessage) setStatus("error", cloudErrorMessage);
            else setStatus("pending", "已加密保存，等待同步");
          }
        }
        return true;
      } catch (_error) {
        if (isCurrent(epoch)) {
          draftFailed = true;
          setStatus("error", "本机草稿保存失败，请导出备份");
          showToast("浏览器无法保存加密草稿，请立即导出备份。");
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
        catch (_error) { showToast("无法清除旧的本机草稿，请检查浏览器存储设置。"); }
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
    if (code !== "NETWORK_ERROR" && code !== "RATE_LIMITED" && code !== "HTTP_ERROR") return;
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
    cloudErrorMessage = null;
    const incoming = parseNotes(result.notes);
    const outcome = mergeVersions(baseline, notes, incoming);
    baseline = copy(incoming);
    sha = result.sha;
    remoteReady = true;
    notes = outcome.merged;
    if (outcome.replacementActiveId) activeId = outcome.replacementActiveId;
    renderAll();
    if (outcome.conflictCount) {
      showToast(`发现 ${outcome.conflictCount} 处同步冲突：已保留冲突副本，请检查两条笔记。`);
    }
    if (isDirty()) {
      changeNumber++;
      queueDraft();
      setStatus("pending", "有未同步修改");
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
      const snapshot = copy(notes);
      const expectedSha = sha;
      setStatus("pending", "正在同步到 GitHub…");
      let newSha;
      try {
        newSha = await transport.save({ version: 1, notes: snapshot }, expectedSha);
      } catch (error) {
        if (error?.code === "CONFLICT") {
          await refreshRemote(epoch);
          if (!isCurrent(epoch) || !isDirty()) return;
          continue;
        }
        throw error;
      }
      if (!isCurrent(epoch)) return;
      cloudErrorMessage = null;
      baseline = snapshot;
      sha = newSha;
      if (isDirty()) {
        // The user continued typing during the upload. The new edit stays in
        // memory and in an encrypted draft, then follows the normal debounce.
        queueDraft();
        setStatus("pending", "新修改等待同步");
      } else {
        clearDraftIfClean();
        setStatus("synced", "已与 GitHub 同步");
      }
      return;
    }
    setStatus("pending", "发现其他设备的修改，稍后重试");
    scheduleSync();
  }

  function enqueueCloud(task) {
    const epoch = session;
    const job = cloudQueue.catch(() => {}).then(async () => {
      if (!isCurrent(epoch)) return;
      try {
        await task(epoch);
      } catch (error) {
        if (!isCurrent(epoch)) return;
        const message = safeError(error);
        cloudErrorMessage = message;
        setStatus("error", message);
        showToast(message);
        // A failed upload can have updated the draft's base SHA (for example,
        // after a conflict). Persist the current state before retrying.
        if (isDirty()) queueDraft();
        scheduleRetry(error?.code);
      }
    });
    cloudQueue = job;
    return job;
  }

  function requestSync(readRemote) {
    if (!unlocked) return;
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

  function setWorkspaceAccess(allow) {
    document.querySelector(".workspace").inert = !allow;
    for (const element of [elements.newButton, elements.deleteButton, elements.importButton,
      elements.exportButton, elements.syncButton, elements.lockButton,
      elements.searchInput, elements.titleInput, elements.tagInput, elements.contentInput]) {
      element.disabled = !allow;
    }
  }

  function showAccess(mode) {
    elements.setupView.hidden = mode !== "setup";
    elements.unlockView.hidden = mode !== "unlock";
    elements.setupError.hidden = true;
    elements.unlockError.hidden = true;
    if (!elements.accessDialog.open) elements.accessDialog.showModal();
    setTimeout(() => (mode === "setup" ? elements.tokenInput : elements.pinInput).focus(), 0);
  }

  async function lock() {
    if (!unlocked) return;
    // Stop editing first, then wait for every earlier draft write and one
    // final snapshot. Otherwise locking could skip the latest queued edit.
    setWorkspaceAccess(false);
    clearTimeout(syncTimer);
    setStatus("pending", "正在保存加密草稿…");
    if (!await queueDraft()) {
      setWorkspaceAccess(true);
      setStatus("error", "无法安全锁定，请先导出备份");
      showToast("加密草稿保存失败。请先导出备份，再关闭或锁定网页。");
      return;
    }
    session++;
    unlocked = false;
    remoteReady = false;
    clearTimeout(syncTimer);
    clearTimeout(retryTimer);
    clearTimeout(pollTimer);
    syncTimer = null;
    retryTimer = null;
    pollTimer = null;
    transport.lock();
    notes = [];
    baseline = [];
    sha = null;
    activeId = null;
    selectedTag = "";
    elements.searchInput.value = "";
    elements.tokenInput.value = "";
    elements.newPinInput.value = "";
    elements.confirmPinInput.value = "";
    elements.pinInput.value = "";
    elements.noteList.replaceChildren();
    elements.tagFilters.replaceChildren();
    elements.noteCount.textContent = "0";
    elements.toast.textContent = "";
    elements.toast.classList.remove("is-visible");
    renderEditor();
    setWorkspaceAccess(false);
    setStatus("pending", "笔记本已锁定");
    showAccess("unlock");
  }

  async function migrateLegacy(epoch) {
    let raw;
    try { raw = localStorage.getItem(LEGACY_STORAGE_KEY); }
    catch (_error) { return; }
    if (!raw || !isCurrent(epoch)) return;
    try {
      const legacy = parseNotes(JSON.parse(raw));
      const existing = new Map(notes.map(note => [note.id, note]));
      const additions = [];
      for (const source of legacy) {
        const note = copy(source);
        const prior = existing.get(note.id);
        if (prior && same(prior, note)) continue;
        if (prior) note.id = makeId();
        existing.set(note.id, note);
        additions.push(note);
      }
      if (additions.length) {
        notes = [...additions, ...notes];
        activeId = additions[0].id;
        changeNumber++;
        renderAll();
      }
      // Delete the old plaintext only after its notes are safely encrypted.
      if (!additions.length || await queueDraft()) {
        localStorage.removeItem(LEGACY_STORAGE_KEY);
        if (additions.length) showToast(`已将 ${additions.length} 条旧版笔记转为加密草稿。`);
      }
    } catch (_error) {
      showToast("检测到旧版笔记，但未能安全迁移；旧数据仍留在本机浏览器中。");
    }
  }

  async function enterNotebook() {
    session++;
    const epoch = session;
    unlocked = true;
    remoteReady = false;
    notes = [];
    baseline = [];
    sha = null;
    activeId = null;
    selectedTag = "";
    draftFailed = false;
    cloudErrorMessage = null;
    elements.searchInput.value = "";
    elements.accessDialog.close();
    setWorkspaceAccess(true);
    setStatus("pending", "正在读取加密草稿…");
    try {
      const draft = await transport.loadDraft();
      if (!isCurrent(epoch)) return;
      if (draft) {
        notes = parseNotes(draft.notes);
        baseline = Array.isArray(draft.baseline) ? parseNotes(draft.baseline) : [];
        sha = typeof draft.sha === "string" ? draft.sha : null;
        activeId = typeof draft.activeId === "string" ? draft.activeId : null;
      }
    } catch (_error) {
      if (isCurrent(epoch)) {
        draftFailed = true;
        showToast("本机加密草稿无法读取；将尝试从 GitHub 读取笔记。请勿重设 PIN。");
      }
    }
    if (!isCurrent(epoch)) return;
    renderAll();
    await migrateLegacy(epoch);
    if (isCurrent(epoch)) {
      requestSync(true);
      startPolling();
    }
  }

  elements.accessDialog.addEventListener("cancel", event => event.preventDefault());
  elements.setupView.addEventListener("submit", async event => {
    event.preventDefault();
    const pin = elements.newPinInput.value;
    if (pin !== elements.confirmPinInput.value) {
      elements.setupError.textContent = "两次输入的 PIN 不一致。";
      elements.setupError.hidden = false;
      return;
    }
    elements.setupButton.disabled = true;
    elements.setupError.hidden = true;
    try {
      await transport.setup(pin, elements.tokenInput.value);
      elements.tokenInput.value = "";
      elements.newPinInput.value = "";
      elements.confirmPinInput.value = "";
      await enterNotebook();
    } catch (error) {
      elements.setupError.textContent = safeError(error);
      elements.setupError.hidden = false;
    } finally {
      elements.setupButton.disabled = false;
    }
  });

  elements.unlockView.addEventListener("submit", async event => {
    event.preventDefault();
    elements.unlockButton.disabled = true;
    elements.unlockError.hidden = true;
    try {
      await transport.unlock(elements.pinInput.value);
      elements.pinInput.value = "";
      await enterNotebook();
    } catch (error) {
      elements.unlockError.textContent = safeError(error);
      elements.unlockError.hidden = false;
    } finally {
      elements.unlockButton.disabled = false;
    }
  });

  elements.resetAccessButton.addEventListener("click", async () => {
    if (!confirm("重新连接会永久删除这台设备上的加密授权和未同步草稿。确认笔记已在 GitHub 或其他设备保存后，再继续。确定重新连接吗？")) return;
    elements.resetAccessButton.disabled = true;
    try {
      await draftQueue.catch(() => {});
      transport.forget();
      showAccess("setup");
    } catch (_error) {
      elements.unlockError.textContent = "无法清除本机授权信息，请检查浏览器存储设置。";
      elements.unlockError.hidden = false;
    } finally {
      elements.resetAccessButton.disabled = false;
    }
  });

  elements.lockButton.addEventListener("click", lock);
  elements.syncButton.addEventListener("click", () => requestSync(true));
  elements.newButton.addEventListener("click", () => {
    if (!unlocked) return;
    const note = makeBlankNote();
    notes.unshift(note);
    activeId = note.id;
    selectedTag = "";
    elements.searchInput.value = "";
    changed();
    renderAll();
    setView("edit");
    elements.titleInput.focus();
  });

  elements.deleteButton.addEventListener("click", () => {
    if (!unlocked) return;
    const note = currentNote();
    if (!note || !confirm(`确定删除“${noteTitle(note)}”吗？此操作无法撤销。`)) return;
    notes = notes.filter(item => item.id !== activeId);
    ensureActive();
    changed();
    renderAll();
    showToast("笔记已删除。");
  });

  elements.titleInput.addEventListener("input", () => {
    if (!unlocked) return;
    const note = currentNote();
    if (!note) return;
    note.title = elements.titleInput.value;
    elements.currentBreadcrumb.textContent = noteTitle(note);
    touch(note);
    renderSidebar();
  });

  elements.tagInput.addEventListener("input", () => {
    if (!unlocked) return;
    const note = currentNote();
    if (!note) return;
    note.tags = [...new Set(elements.tagInput.value.split(/[,，]/).map(tag => tag.trim().slice(0, 40)).filter(Boolean))].slice(0, 20);
    touch(note);
    renderSidebar();
  });

  elements.contentInput.addEventListener("input", () => {
    if (!unlocked) return;
    const note = currentNote();
    if (!note) return;
    note.content = elements.contentInput.value;
    touch(note);
    renderSidebar();
    updatePreview();
  });

  elements.searchInput.addEventListener("input", () => { if (unlocked) renderSidebar(); });
  elements.clearTagButton.addEventListener("click", () => { if (unlocked) { selectedTag = ""; renderSidebar(); } });
  elements.editTab.addEventListener("click", () => setView("edit"));
  elements.previewTab.addEventListener("click", () => setView("preview"));

  elements.exportButton.addEventListener("click", () => {
    if (!unlocked) return;
    const payload = JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), notes }, null, 2);
    const blob = new Blob([payload], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `我的笔记备份-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast("备份已导出。请妥善保存文件。");
  });

  elements.importButton.addEventListener("click", () => { if (unlocked) elements.importFile.click(); });
  elements.importFile.addEventListener("change", async () => {
    const epoch = session;
    const file = elements.importFile.files[0];
    elements.importFile.value = "";
    if (!file || !isCurrent(epoch)) return;
    if (file.size > 5 * 1024 * 1024) { showToast("文件超过 5 MB，请选择较小的 JSON 备份。"); return; }
    try {
      const data = JSON.parse(await file.text());
      if (!isCurrent(epoch)) return;
      if (!data || data.version !== 1 || !Array.isArray(data.notes)) throw new Error("format");
      if (data.notes.length > 1000) throw new Error("too many notes");
      const imported = parseNotes(data);
      if (!imported.length) { showToast("备份文件中没有笔记。"); return; }
      const existingIds = new Set(notes.map(note => note.id));
      for (const note of imported) {
        while (existingIds.has(note.id)) note.id = makeId();
        existingIds.add(note.id);
      }
      notes = [...imported, ...notes];
      activeId = imported[0].id;
      selectedTag = "";
      elements.searchInput.value = "";
      changed();
      renderAll();
      showToast(`已导入 ${imported.length} 条笔记，原有笔记已保留。`);
    } catch (_error) {
      if (isCurrent(epoch)) showToast("导入失败：请使用本笔记本导出的 JSON 文件。");
    }
  });

  window.addEventListener("online", () => { if (unlocked) requestSync(true); });
  window.addEventListener("focus", () => { if (unlocked) requestSync(true); });
  document.addEventListener("visibilitychange", () => {
    if (unlocked && document.visibilityState === "visible") requestSync(true);
  });
  window.addEventListener("beforeunload", event => {
    if (unlocked && (draftPending > 0 || draftFailed)) {
      event.preventDefault();
      event.returnValue = "";
    }
  });

  setWorkspaceAccess(false);
  renderAll();
  setStatus("pending", "笔记本已锁定");
  try { showAccess(transport.isConfigured() ? "unlock" : "setup"); }
  catch (_error) { showAccess("setup"); }
})();
