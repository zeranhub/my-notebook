/* Temporary tools for a finite paper. Document access stays in app.js closures. */
(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const node = (tag, text = "", className = "") => {
    const element = document.createElement(tag);
    element.textContent = text;
    if (className) element.className = className;
    return element;
  };
  const clone = value => JSON.parse(JSON.stringify(value));
  const date = value => {
    if (!value) return "时间未知";
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? "时间未知" : parsed.toLocaleString("zh-CN", { hour12: false });
  };
  function download(payload, filename) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" }));
    const link = node("a"); link.href = url; link.download = filename;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  function base64(bytes) {
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  }
  function referencedAssets(snapshot) {
    const ids = new Set();
    for (const note of snapshot.notes || []) {
      if (window.marked?.lexer && window.marked?.walkTokens) {
        window.marked.walkTokens(window.marked.lexer(note.content || ""), token => {
          const match = token.type === "image" && /^onepage:([A-Za-z0-9._-]{1,128})$/.exec(token.href || "");
          if (match) ids.add(match[1]);
        });
      } else {
        for (const match of (note.content || "").matchAll(/\(\s*<?onepage:([A-Za-z0-9._-]{1,128})(?=[>\s)])/g)) ids.add(match[1]);
      }
    }
    return { assets: Object.fromEntries([...ids].filter(id => Object.hasOwn(snapshot.assets || {}, id)).map(id => [id, snapshot.assets[id]])),
      missing: [...ids].filter(id => !Object.hasOwn(snapshot.assets || {}, id)) };
  }
  function attach(ctx) {
    const dialog = $("toolsDialog"), title = $("toolsTitle"), body = $("toolsBody");
    const menu = $("moreMenu"), more = $("moreButton");
    let generation = 0;
    function hideMenu() { menu.hidden = true; more.setAttribute("aria-expanded", "false"); }
    function close() {
      generation++; hideMenu();
      if (dialog.open) dialog.close();
      body.replaceChildren(); title.textContent = "";
    }
    function open(text) {
      hideMenu(); generation++;
      title.textContent = text; body.replaceChildren();
      if (!dialog.open) dialog.showModal();
      const epoch = ctx.session(), ticket = generation;
      return () => ctx.current(epoch) && ticket === generation && dialog.open;
    }
    function message(text, error = false) {
      const paragraph = node("p", text, `tool-status${error ? " is-error" : ""}`);
      paragraph.setAttribute("role", "status"); body.append(paragraph); return paragraph;
    }
    function actions() { const row = node("div", "", "tool-actions"); body.append(row); return row; }
    function button(row, text, action, primary = false, actionId = "") {
      const item = node("button", text, `button ${primary ? "button-primary" : "button-quiet"}`);
      item.type = "button"; if (actionId) item.dataset.action = actionId;
      item.addEventListener("click", action); row.append(item); return item;
    }
    function field(labelText, element) {
      const label = node("label", labelText, "tool-intro");
      element.className = "tool-field"; label.append(element); body.append(label); return element;
    }
    function search() {
      if (!ctx.unlocked()) return;
      const current = open("搜索所有纸张");
      const input = field("搜索正文或纸张名称", node("input"));
      input.type = "search"; input.id = "globalSearchInput"; input.placeholder = "输入关键词，例如：会议 下周";
      input.maxLength = 2000;
      const status = message("输入关键词，搜索完整正文。"), list = node("div", "", "tool-results");
      body.append(list);
      function update() {
        if (!current()) return;
        list.replaceChildren();
        let found;
        try { found = window.OnePageSearch.search(ctx.state(), input.value); }
        catch (error) { status.classList.add("is-error"); status.textContent = error.message || "请缩短搜索词后重试。"; return; }
        status.classList.remove("is-error");
        status.textContent = input.value.trim() ? (found.total ? `找到 ${found.total} 项${found.truncated ? "，先显示前 100 项" : ""}` : "没有找到匹配内容。") : "输入关键词，搜索完整正文。";
        for (const result of found.results) {
          const item = node("button", "", "tool-result"); item.type = "button";
          item.dataset.noteId = result.noteId || ""; item.dataset.pageId = result.pageId;
          const heading = node("strong"); window.OnePageSearch.highlight(heading, result.pageName, input.value);
          item.append(heading);
          const preview = node("p"); window.OnePageSearch.highlight(preview, result.kind === "page" ? "打开这张纸" : result.snippet, input.value); item.append(preview);
          item.addEventListener("click", () => {
            if (!current()) return;
            close();
            if (result.noteId) ctx.focusNote(result.noteId);
            else ctx.selectPage(result.pageId);
          });
          list.append(item);
        }
      }
      input.addEventListener("input", update); input.focus(); update();
    }
    function move(noteId = ctx.selected()) {
      const note = ctx.note(noteId);
      if (!ctx.unlocked() || !note) { ctx.toast("先选中一篇笔记，再选择移动。"); return; }
      const current = open("移动笔记");
      message("选择另一张有限的纸张。若目标放不下，仍会显示越界提示。文字字号和图片比例保持当前设置。");
      const select = field("移到已有纸张", node("select")); select.id = "moveTargetPage";
      for (const page of ctx.state().pages.filter(item => item.id !== note.pageId)) {
        const option = node("option", page.name); option.value = page.id; select.append(option);
      }
      const row = actions();
      const existing = button(row, "移到所选纸张", () => { if (current() && select.value) { ctx.moveNote(noteId, select.value); close(); } }, true, "move-existing");
      existing.disabled = !select.options.length;
      button(row, "移到新纸张", () => { if (current()) { ctx.moveNote(noteId, null); close(); } }, false, "move-new").disabled = ctx.state().pages.length >= 100;
    }
    function backup() {
      if (!ctx.unlocked()) return;
      const current = open("备份笔记");
      message("备份文件未加密，包含可直接读取的私人正文。请保存在可信设备上。完整备份包含图片；文字应急备份保留正文和排版，图片需另行补取。");
      const status = message("完整备份优先使用本机已加载的图片，可在断网时导出。"), row = actions();
      let busy = false;
      async function save(textOnly) {
        if (!current() || busy) return;
        busy = true;
        for (const item of row.querySelectorAll("button")) item.disabled = true;
        status.classList.remove("is-error"); status.textContent = "正在准备备份…";
        try {
          const snapshot = clone(ctx.state());
          const references = referencedAssets(snapshot);
          snapshot.assets = references.assets;
          const files = {};
          if (!textOnly && references.missing.length) throw new Error("正文引用的图片缺少信息，请先下载文字应急备份。");
          if (!textOnly) for (const asset of Object.values(snapshot.assets || {})) {
            files[asset.id] = base64(await ctx.assetBytes(asset));
            if (!current()) return;
          }
          if (!current()) return;
          download({ ...snapshot, assetFiles: files, backupKind: textOnly ? "text-only" : "complete", exportedAt: new Date().toISOString() }, `一页纸-${textOnly ? "文字应急" : "完整"}-未加密备份-${new Date().toISOString().slice(0, 10)}.json`);
          status.textContent = textOnly ? "文字应急备份已下载，图片未包含在文件中。" : "完整备份已下载，正文和图片均包含在文件中。";
          ctx.toast(status.textContent);
        } catch (error) {
          if (current()) { status.classList.add("is-error"); status.textContent = textOnly ? `文字应急备份未完成：${error.message || "请重试。"}` : `完整备份未完成：${error.message || "有图片尚未缓存在本机，可联网重试，或先下载文字应急备份。"}`; }
        } finally { busy = false; if (current()) for (const item of row.querySelectorAll("button")) item.disabled = false; }
      }
      button(row, "下载完整备份", () => save(false), true, "backup-complete");
      button(row, "下载文字应急备份", () => save(true), false, "backup-text");
    }
    function paperExport() {
      if (!ctx.unlocked()) return;
      const current = open("导出当前 A4");
      message("按纸张实际排版导出，只包含 A4 边界内的内容。越界笔记可先移动到另一张纸。导出文件包含私人内容，请妥善保存。");
      const status = message("文字、图片和重叠层次按当前纸面保留。"), row = actions();
      let busy = false;
      async function save(format) {
        if (!current() || busy) return;
        busy = true;
        for (const item of row.querySelectorAll("button")) item.disabled = true;
        status.classList.remove("is-error"); status.textContent = "正在加载图片并生成文件…";
        try {
          const page = ctx.page();
          if (!page) throw new Error("当前纸张已不存在，请关闭弹窗后重新选择纸张。");
          await ctx.ensureImages(page.id);
          if (!current()) return;
          await window.OnePageExport.download({ canvas: ctx.canvas, page, format, filename: page.name, isCurrent: current });
          if (current()) { status.textContent = `${format.toUpperCase()} 已下载。`; ctx.toast(status.textContent); }
        } catch (error) { if (current()) { status.classList.add("is-error"); status.textContent = error.message || "导出失败，请确认图片已加载后重试。"; } }
        finally { busy = false; if (current()) for (const item of row.querySelectorAll("button")) item.disabled = false; }
      }
      button(row, "下载 A4 PDF", () => save("pdf"), true, "export-pdf");
      button(row, "下载 PNG 图片", () => save("png"), false, "export-png");
    }
    async function importFile(file) {
      if (!ctx.unlocked()) return;
      const current = open("导入备份");
      const status = message("正在检查备份…");
      if (!file || typeof file.text !== "function") { status.classList.add("is-error"); status.textContent = "请选择有效的 JSON 备份文件。"; return; }
      if (file.size > 50 * 1024 * 1024) { status.classList.add("is-error"); status.textContent = "文件超过 50 MB，请选择较小的备份。"; return; }
      try {
        const text = await file.text();
        if (!current()) return;
        const raw = JSON.parse(text);
        const data = ctx.parse(raw).data;
        ctx.validateAssets(data.assets);
        const known = new Set(ctx.state().notes.map(note => note.content)), imported = new Set();
        let existingDuplicates = 0, fileDuplicates = 0;
        for (const note of data.notes) {
          if (known.has(note.content)) existingDuplicates++;
          else if (imported.has(note.content)) fileDuplicates++;
          imported.add(note.content);
        }
        const duplicates = existingDuplicates + fileDuplicates;
        status.textContent = `${file.name}\n${data.pages.length} 张纸，${data.notes.length} 篇笔记；其中 ${duplicates} 篇正文重复（${existingDuplicates} 篇与现有笔记相同，${fileDuplicates} 篇在文件内重复）。仅导入新内容将追加 ${data.notes.length - duplicates} 篇。${raw.backupKind === "text-only" ? "\n这是文字应急备份，图片可能需要联网补取。" : ""}`;
        const row = actions();
        let busy = false;
        async function apply(dedupe) {
          if (!current() || busy) return;
          busy = true;
          for (const item of row.querySelectorAll("button")) item.disabled = true;
          try {
            const count = await ctx.importBackup(raw, data, dedupe, current);
            if (!current()) return;
            close(); ctx.toast(count ? `已导入 ${count} 篇笔记，原有内容仍保留。` : "没有新内容，已跳过相同正文。");
          } catch (error) { if (current()) { status.classList.add("is-error"); status.textContent = error.message || "导入失败，原有笔记已保留。"; } }
          finally { busy = false; if (current()) for (const item of row.querySelectorAll("button")) item.disabled = false; }
        }
        button(row, "仅导入新内容", () => apply(true), true, "import-new");
        button(row, "全部追加为副本", () => apply(false), false, "import-copies");
      } catch (error) { if (current()) { status.classList.add("is-error"); status.textContent = `${error instanceof SyntaxError ? "备份不是有效的 JSON 文件。" : ctx.error(error)} 原有笔记已保留。`; } }
    }
    async function versions() {
      if (!ctx.unlocked()) return;
      const current = open("历史版本");
      message("选择版本查看完整正文，再将需要的纸张恢复为新纸张。当前内容会保留；本机记录包含离线快照，云端记录包含以前成功同步的版本。");
      const status = message("正在读取历史…"), list = node("div", "", "tool-results"); body.append(list);
      let remotePage = 1;
      let previewTicket = 0;
      async function preview(load, label) {
        if (!current()) return;
        const ticket = ++previewTicket;
        status.textContent = "正在读取版本正文…";
        try {
          const raw = await load();
          if (!current() || ticket !== previewTicket) return;
          const source = ctx.parse(raw).data;
          const active = open("预览历史版本");
          message(label);
          const select = field("选择要恢复的纸张", node("select")); select.id = "versionPageSelect";
          for (const page of source.pages) { const option = node("option", page.name); option.value = page.id; select.append(option); }
          const content = node("div", "", "version-preview"); body.append(content);
          const update = () => {
            content.replaceChildren();
            for (const note of source.notes.filter(item => item.pageId === select.value)) content.append(node("p", note.content || "（空笔记）"));
            if (!content.children.length) content.append(node("p", "这张纸没有笔记。"));
          };
          select.addEventListener("change", update); update();
          const row = actions(), feedback = message("恢复会保留原排版，并可继续撤销。图片从同一私有仓库读取。");
          button(row, "恢复此页为新纸张", async event => {
            const clickedButton = event.currentTarget;
            if (!active() || clickedButton.disabled) return;
            clickedButton.disabled = true;
            try { await ctx.restoreVersion(source, select.value, active); if (active()) { close(); ctx.toast("历史纸张已恢复为新纸张，当前内容已保留。" ); } }
            catch (error) { if (active()) { feedback.classList.add("is-error"); feedback.textContent = ctx.error(error); clickedButton.disabled = false; } }
          }, true, "version-restore");
          button(row, "返回版本列表", versions);
        } catch (error) { if (current() && ticket === previewTicket) { status.classList.add("is-error"); status.textContent = ctx.error(error); } }
      }
      function entry(label, load, kind) {
        const item = node("button", label, "tool-result"); item.type = "button"; item.dataset.versionKind = kind;
        item.addEventListener("click", () => preview(load, label)); list.append(item);
      }
      try {
        const local = await ctx.transport.loadVersionSnapshots();
        if (!current()) return;
        for (const version of local) entry(`本机 · ${date(version.createdAt)} · ${version.label || "保存快照"}`, async () => version.notes, "local");
      } catch { if (current()) status.textContent = "本机历史暂不可读；继续尝试云端历史。"; }
      if (!current()) return;
      const row = actions();
      const moreHistory = button(row, "读取更多云端版本", loadRemote, false, "versions-more");
      async function loadRemote() {
        if (!current() || moreHistory.disabled || remotePage === null) return;
        moreHistory.disabled = true;
        try {
          const result = await ctx.transport.listVersions({ page: remotePage, perPage: 20 });
          if (!current()) return;
          for (const version of result.versions) entry(`云端 · ${date(version.date)} · ${version.message.split("\n")[0]}`, async () => (await ctx.transport.loadVersion(version.sha)).notes, "remote");
          remotePage = result.nextPage;
          moreHistory.hidden = !result.hasMore;
          status.textContent = list.children.length ? "点击版本查看正文。" : "还没有可恢复的历史版本。";
        } catch { if (current()) { status.textContent = list.children.length ? "云端历史暂不可用，仍可打开本机快照。" : "当前无法连接云端，也没有本机快照。"; } }
        finally { if (current()) moreHistory.disabled = false; }
      }
      if (current()) await loadRemote();
    }
    more.addEventListener("click", () => {
      if (!ctx.unlocked()) return;
      menu.hidden = !menu.hidden; more.setAttribute("aria-expanded", String(!menu.hidden));
      const rect = more.getBoundingClientRect(); menu.style.top = `${Math.max(8, rect.bottom + 6)}px`;
      menu.style.maxHeight = `${Math.max(100, (window.visualViewport?.height || innerHeight) - rect.bottom - 20)}px`;
    });
    document.addEventListener("pointerdown", event => { if (!menu.contains(event.target) && !more.contains(event.target)) hideMenu(); });
    menu.addEventListener("click", event => { if (event.target.closest("button")) hideMenu(); });
    $("closeToolsButton").addEventListener("click", close);
    dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });
    dialog.addEventListener("close", () => {
      if (dialog.open) return;
      generation++; hideMenu(); body.replaceChildren(); title.textContent = "";
    });
    $("searchButton").addEventListener("click", search);
    $("moveNoteButton").addEventListener("click", () => move());
    $("duplicatePageButton").addEventListener("click", () => { if (ctx.unlocked()) ctx.duplicatePage(); });
    $("versionsButton").addEventListener("click", versions);
    $("paperExportButton").addEventListener("click", paperExport);
    document.addEventListener("keydown", event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k" && ctx.unlocked()) { event.preventDefault(); search(); }
      if (event.key === "Escape") hideMenu();
    });
    return Object.freeze({ close, search, move, backup, paperExport, importFile, versions });
  }
  window.OnePageTools = Object.freeze({ attach });
})();
