/*
 * Private GitHub notebook transport.  The public page never contains a token:
 * each device receives its own token from the user, and localStorage contains
 * only an AES-GCM encrypted copy.  A six-digit PIN has little entropy, so this
 * protects mainly against casual access on the same device; it is not a
 * replacement for device security or a long password.
 *
 * API: new NotebookSync({ owner, repo, path }); isConfigured();
 * setup(pin, token); unlock(pin); lock(); load(); save(notes, sha);
 * saveDraft(value); loadDraft(); clearDraft(); validateToken(token); forget().
 * Draft methods round-trip any JSON value and keep it encrypted on this device.
 * Promise methods reject with an Error whose
 * code is a stable string such as UNAUTHORIZED, FORBIDDEN, NOT_FOUND, or
 * CONFLICT (the last one means the UI should reload and resolve edits).
 */
(() => {
  "use strict";

  const API_ROOT = "https://api.github.com";
  const API_VERSION = "2022-11-28";
  const KDF_ITERATIONS = 600_000;
  // GitHub's Contents API stops returning Base64 content for files above 1 MB.
  const MAX_CONTENT_BYTES = 1_000_000;
  const STORAGE_VERSION = 1;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8", { fatal: true });

  function syncError(code, message, status) {
    const error = new Error(message);
    error.name = "NotebookSyncError";
    error.code = code;
    if (status !== undefined) error.status = status;
    return error;
  }

  function requireCrypto() {
    if (!globalThis.crypto?.subtle || !globalThis.crypto.getRandomValues) {
      throw syncError("UNSUPPORTED", "此浏览器不支持安全加密，请使用新版浏览器并通过 HTTPS 打开网页。");
    }
  }

  function requirePin(pin) {
    if (typeof pin !== "string" || !/^\d{6}$/.test(pin)) {
      throw syncError("INVALID_PIN", "请输入恰好 6 位数字密码。");
    }
  }

  function requireToken(token) {
    if (typeof token !== "string" || !token.trim()) {
      throw syncError("INVALID_TOKEN", "请输入 GitHub 访问令牌。");
    }
    return token.trim();
  }

  function bytesToBase64(bytes) {
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
  }

  function base64ToBytes(value) {
    if (typeof value !== "string") {
      throw syncError("INVALID_DATA", "数据格式有误。");
    }
    try {
      const binary = atob(value.replace(/\s/g, ""));
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return bytes;
    } catch {
      throw syncError("INVALID_DATA", "Base64 数据已损坏。");
    }
  }

  function httpError(response, context) {
    const status = response.status;
    if (status === 401) return syncError("UNAUTHORIZED", "GitHub 授权已失效，请重新配置访问令牌。", status);
    if (status === 403) {
      if (response.headers.get("x-ratelimit-remaining") === "0") {
        return syncError("RATE_LIMITED", "GitHub 请求次数暂时达到上限，请稍后再试。", status);
      }
      return syncError("FORBIDDEN", "GitHub 拒绝访问，请检查令牌的仓库和 Contents 权限。", status);
    }
    if (status === 404) {
      const message = context === "content"
        ? "找不到笔记文件，或当前令牌缺少 Contents 读取权限。"
        : "私有仓库不存在，或当前令牌无权访问。";
      return syncError("NOT_FOUND", message, status);
    }
    if (status === 409) return syncError("CONFLICT", "笔记已在别处更新，请重新加载后合并修改。", status);
    return syncError("HTTP_ERROR", `GitHub 请求失败（HTTP ${status}）。`, status);
  }

  async function deriveKey(pin, salt) {
    const material = await crypto.subtle.importKey(
      "raw", encoder.encode(pin), "PBKDF2", false, ["deriveKey"]
    );
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", salt, iterations: KDF_ITERATIONS, hash: "SHA-256" },
      material,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  }

  class NotebookSync {
    #token = null;
    #key = null;
    #storageKey;
    #draftStorageKey;
    #repoUrl;
    #contentUrl;
    #context;
    #draftContext;

    constructor({ owner, repo, path } = {}) {
      if (typeof owner !== "string" || !/^[A-Za-z0-9-]+$/.test(owner) ||
          typeof repo !== "string" || !/^[A-Za-z0-9._-]+$/.test(repo) ||
          typeof path !== "string" || !path ||
          path.split("/").some(part => !part || part === "." || part === "..")) {
        throw syncError("INVALID_CONFIG", "GitHub 仓库或文件路径配置有误。");
      }
      const encodedPath = path.split("/").map(encodeURIComponent).join("/");
      this.#repoUrl = `${API_ROOT}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
      this.#contentUrl = `${this.#repoUrl}/contents/${encodedPath}`;
      this.#storageKey = `notebook-sync:v1:${owner}/${repo}/${path}`;
      this.#draftStorageKey = `notebook-draft:v1:${owner}/${repo}/${path}`;
      this.#context = encoder.encode(`${owner}/${repo}/${path}`);
      this.#draftContext = encoder.encode(`draft:${owner}/${repo}/${path}`);
    }

    isConfigured() {
      try {
        return localStorage.getItem(this.#storageKey) !== null;
      } catch {
        throw syncError("STORAGE_UNAVAILABLE", "浏览器无法读取本地授权信息。");
      }
    }

    async setup(pin, token) {
      requireCrypto();
      requirePin(pin);
      const cleanToken = requireToken(token);
      await this.validateToken(cleanToken);

      const salt = crypto.getRandomValues(new Uint8Array(16));
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const key = await deriveKey(pin, salt);
      const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: this.#context },
        key,
        encoder.encode(cleanToken)
      ));
      const record = {
        version: STORAGE_VERSION,
        iterations: KDF_ITERATIONS,
        salt: bytesToBase64(salt),
        iv: bytesToBase64(iv),
        ciphertext: bytesToBase64(ciphertext)
      };
      try {
        localStorage.setItem(this.#storageKey, JSON.stringify(record));
      } catch {
        throw syncError("STORAGE_UNAVAILABLE", "浏览器无法保存加密后的授权信息。");
      }
      this.#token = cleanToken;
      this.#key = key;
    }

    async unlock(pin) {
      requireCrypto();
      requirePin(pin);
      let raw;
      try {
        raw = localStorage.getItem(this.#storageKey);
      } catch {
        throw syncError("STORAGE_UNAVAILABLE", "浏览器无法读取本地授权信息。");
      }
      if (raw === null) throw syncError("NOT_CONFIGURED", "请先配置 GitHub 访问令牌。");

      let record;
      try {
        record = JSON.parse(raw);
        if (record.version !== STORAGE_VERSION || record.iterations !== KDF_ITERATIONS) {
          throw new Error("unsupported format");
        }
      } catch {
        throw syncError("INVALID_CONFIG", "本地授权信息格式有误，请重新配置。");
      }
      const salt = base64ToBytes(record.salt);
      const iv = base64ToBytes(record.iv);
      const ciphertext = base64ToBytes(record.ciphertext);
      if (salt.length !== 16 || iv.length !== 12 || ciphertext.length < 16) {
        throw syncError("INVALID_CONFIG", "本地授权信息已损坏，请重新配置。");
      }
      try {
        const key = await deriveKey(pin, salt);
        const plaintext = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv, additionalData: this.#context },
          key,
          ciphertext
        );
        this.#token = requireToken(decoder.decode(plaintext));
        this.#key = key;
      } catch {
        this.#token = null;
        this.#key = null;
        throw syncError("UNLOCK_FAILED", "密码错误，或本地授权信息已损坏。");
      }
    }

    lock() {
      this.#token = null;
      this.#key = null;
    }

    async #fetch(url, token, options = {}) {
      try {
        return await fetch(url, {
          ...options,
          cache: "no-store",
          credentials: "omit",
          redirect: "error",
          referrerPolicy: "no-referrer",
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${token}`,
            "X-GitHub-Api-Version": API_VERSION,
            ...options.headers
          }
        });
      } catch {
        throw syncError("NETWORK_ERROR", "无法连接 GitHub，请检查网络后重试。");
      }
    }

    async #json(response) {
      try {
        return await response.json();
      } catch {
        throw syncError("INVALID_RESPONSE", "GitHub 返回的数据无法读取。");
      }
    }

    async #assertPrivateRepo(token) {
      const response = await this.#fetch(this.#repoUrl, token);
      if (!response.ok) throw httpError(response);
      const info = await this.#json(response);
      if (info.private !== true) {
        throw syncError("REPOSITORY_PUBLIC", "笔记仓库目前是公开的。请先将仓库设为私有。");
      }
    }

    async validateToken(token) {
      const cleanToken = requireToken(token);
      await this.#assertPrivateRepo(cleanToken);
      const response = await this.#fetch(this.#contentUrl, cleanToken);
      // Deployment creates data/notes.json first. A 404 now means missing
      // Contents access or a broken deployment, so it must not pass validation.
      if (!response.ok) throw httpError(response, "content");
      return true;
    }

    #requireUnlocked() {
      if (!this.#token) throw syncError("LOCKED", "请先输入 6 位密码解锁。");
      return this.#token;
    }

    async load() {
      const token = this.#requireUnlocked();
      await this.#assertPrivateRepo(token);
      const response = await this.#fetch(this.#contentUrl, token);
      if (!response.ok) throw httpError(response, "content");
      const file = await this.#json(response);
      if (file.encoding === "none") {
        throw syncError("TOO_LARGE", "笔记文件超过 GitHub Contents API 的 1 MB 读取限制，请先从 GitHub 下载备份并精简内容。");
      }
      if (file.encoding !== "base64" || typeof file.content !== "string" ||
          typeof file.sha !== "string") {
        throw syncError("INVALID_DATA", "笔记文件格式不受支持。");
      }
      try {
        const notes = JSON.parse(decoder.decode(base64ToBytes(file.content)));
        return { notes, sha: file.sha };
      } catch {
        throw syncError("INVALID_DATA", "笔记文件不是有效的 JSON，或文字编码有误。");
      }
    }

    async save(notes, sha) {
      const token = this.#requireUnlocked();
      let json;
      try {
        json = JSON.stringify(notes);
      } catch {
        throw syncError("INVALID_DATA", "笔记内容无法转换为 JSON。");
      }
      if (typeof json !== "string") {
        throw syncError("INVALID_DATA", "笔记内容不能为空。");
      }
      const contentBytes = encoder.encode(json);
      if (contentBytes.length > MAX_CONTENT_BYTES) {
        let backedUp = false;
        try {
          await this.saveDraft({ notes, sha: sha ?? null });
          backedUp = true;
        } catch {
          // Storage may be full. The caller still gets an explicit upload error.
        }
        throw syncError(
          "TOO_LARGE",
          backedUp
            ? "笔记超过约 1 MB，未上传；已保存加密本地草稿，请导出备份并精简内容。"
            : "笔记超过约 1 MB，未上传，且本地备份未能保存；请立即导出备份并精简内容。"
        );
      }
      if (sha != null && (typeof sha !== "string" || !/^[a-f0-9]{40}$/i.test(sha))) {
        throw syncError("INVALID_DATA", "笔记文件版本号格式有误。");
      }
      await this.#assertPrivateRepo(token);
      const body = {
        message: "Update private notebook",
        content: bytesToBase64(contentBytes)
      };
      if (sha != null) body.sha = sha;
      const response = await this.#fetch(this.#contentUrl, token, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      if (!response.ok) throw httpError(response);
      const result = await this.#json(response);
      if (typeof result.content?.sha !== "string") {
        throw syncError("INVALID_RESPONSE", "GitHub 未返回新版本号，请重新加载笔记。");
      }
      return result.content.sha;
    }

    async saveDraft(value) {
      if (!this.#key) throw syncError("LOCKED", "请先输入 6 位密码解锁。");
      let json;
      try {
        json = JSON.stringify(value);
      } catch {
        throw syncError("INVALID_DATA", "草稿无法转换为 JSON。");
      }
      if (typeof json !== "string") throw syncError("INVALID_DATA", "草稿内容不能为空。");
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: this.#draftContext },
        this.#key,
        encoder.encode(json)
      ));
      const record = {
        version: STORAGE_VERSION,
        iv: bytesToBase64(iv),
        ciphertext: bytesToBase64(ciphertext)
      };
      try {
        localStorage.setItem(this.#draftStorageKey, JSON.stringify(record));
      } catch {
        throw syncError("STORAGE_UNAVAILABLE", "浏览器无法保存加密草稿。");
      }
    }

    async loadDraft() {
      if (!this.#key) throw syncError("LOCKED", "请先输入 6 位密码解锁。");
      let raw;
      try {
        raw = localStorage.getItem(this.#draftStorageKey);
      } catch {
        throw syncError("STORAGE_UNAVAILABLE", "浏览器无法读取加密草稿。");
      }
      if (raw === null) return null;
      try {
        const record = JSON.parse(raw);
        if (record.version !== STORAGE_VERSION) throw new Error("unsupported format");
        const iv = base64ToBytes(record.iv);
        const ciphertext = base64ToBytes(record.ciphertext);
        if (iv.length !== 12 || ciphertext.length < 16) throw new Error("invalid draft");
        const plaintext = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv, additionalData: this.#draftContext },
          this.#key,
          ciphertext
        );
        return JSON.parse(decoder.decode(plaintext));
      } catch {
        throw syncError("DRAFT_CORRUPT", "本地草稿无法解密，可能已损坏或使用了旧密码。");
      }
    }

    clearDraft() {
      try {
        localStorage.removeItem(this.#draftStorageKey);
      } catch {
        throw syncError("STORAGE_UNAVAILABLE", "浏览器无法清除本地草稿。");
      }
    }

    forget() {
      this.lock();
      try {
        localStorage.removeItem(this.#storageKey);
        localStorage.removeItem(this.#draftStorageKey);
      } catch {
        throw syncError("STORAGE_UNAVAILABLE", "浏览器无法清除本地授权信息。");
      }
    }
  }

  window.NotebookSync = NotebookSync;
})();
