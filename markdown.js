(() => {
  "use strict";

  const marked = window.marked;
  const purify = window.DOMPurify;
  const notifiedImages = new Set();
  const boundContainers = new WeakSet();
  const rasterMimes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
  const assetIdPattern = /^[a-zA-Z0-9._-]{1,128}$/;

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, character => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[character]);
  }

  function safeLink(value) {
    const raw = String(value ?? "").trim();
    if (!raw || /[\u0000-\u0020\u007f]/.test(raw)) return null;
    try {
      const url = new URL(raw, document.baseURI);
      if (!["https:", "http:", "mailto:"].includes(url.protocol)) return null;
      if (url.username || url.password) return null;
      return url.href;
    } catch {
      return null;
    }
  }

  const parser = marked ? new marked.Marked({ gfm: true, breaks: true, async: false }) : null;
  if (parser) parser.use({ renderer: {
    // A note can contain Markdown, but raw HTML is always ordinary visible text.
    html(token) {
      return escapeHtml(token.text ?? token.raw ?? "").replace(/\n/g, "<br>\n");
    },
    link(token) {
      const text = this.parser.parseInline(token.tokens);
      const href = safeLink(token.href);
      if (!href) return `<span>${text}</span>`;
      const title = token.title ? ` title="${escapeHtml(token.title)}"` : "";
      return `<a href="${escapeHtml(href)}"${title} target="_blank" rel="noopener noreferrer">${text}</a>`;
    },
    image(token) {
      const match = /^onepage:([a-zA-Z0-9._-]{1,128})$/.exec(String(token.href ?? ""));
      const alt = escapeHtml(token.text ?? "");
      if (match) return `<span class="md-image" data-onepage-asset="${match[1]}" data-image-alt="${alt}"></span>`;
      return `<span class="md-external-image">外部图片需导入${alt ? `：${alt}` : ""}</span>`;
    }
  } });

  const sanitizeOptions = {
    ALLOWED_TAGS: ["p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "em", "del", "s",
      "a", "code", "pre", "blockquote", "ul", "ol", "li", "table", "thead", "tbody", "tr", "th", "td", "input", "span"],
    ALLOWED_ATTR: ["href", "title", "target", "rel", "class", "start", "align", "type", "checked", "disabled",
      "data-onepage-asset", "data-image-alt"],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    FORBID_TAGS: ["svg", "math", "style", "script", "iframe", "object", "embed", "form"],
    FORBID_ATTR: ["id", "name", "style", "src", "srcset", "onerror", "onload"],
    RETURN_DOM_FRAGMENT: true
  };

  function assetMetadata(assets, id) {
    if (!assets || !Object.prototype.hasOwnProperty.call(assets, id)) return null;
    const asset = assets[id];
    if (!asset || !rasterMimes.has(String(asset.mime).toLowerCase())) return null;
    const width = Number(asset.width), height = Number(asset.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || width > 100000 || height > 100000) return null;
    return { width, height };
  }

  function safeAssetUrl(value) {
    if (typeof value !== "string") return null;
    if (/^data:image\/(?:png|jpeg|webp|gif);base64,[a-zA-Z0-9+/=\r\n]+$/i.test(value)) return value;
    try {
      const url = new URL(value);
      // Only imported local/private image blobs are displayed. External images never load.
      if (url.protocol === "blob:" && url.origin === window.location.origin) return url.href;
    } catch { /* A missing or pending asset keeps its fixed-size placeholder. */ }
    return null;
  }

  function bindLinks(container) {
    if (boundContainers.has(container)) return;
    for (const eventName of ["pointerdown", "click", "keydown"]) {
      container.addEventListener(eventName, event => {
        if (event.target.closest?.("a")) event.stopPropagation();
      });
    }
    boundContainers.add(container);
  }

  function hydrateImages(container, options) {
    let images = 0, unresolvedImages = 0;
    for (const slot of container.querySelectorAll("[data-onepage-asset]")) {
      const id = slot.dataset.onepageAsset;
      if (!assetIdPattern.test(id)) continue;
      const alt = slot.dataset.imageAlt ?? "";
      const metadata = assetMetadata(options.assets, id);
      const width = metadata?.width ?? 4, height = metadata?.height ?? 3;
      slot.style.display = "block";
      slot.style.position = "relative";
      slot.style.width = "100%";
      slot.style.aspectRatio = `${width} / ${height}`;
      slot.setAttribute("role", "img");
      slot.setAttribute("aria-label", alt || "图片");
      const placeholder = document.createElement("span");
      placeholder.className = "md-image-placeholder";
      placeholder.style.position = "absolute";
      placeholder.style.inset = "0";
      placeholder.textContent = metadata ? (alt || "图片加载中") : (alt ? `图片未找到：${alt}` : "图片未找到");
      slot.append(placeholder);
      let url = null;
      if (metadata && typeof options.getAssetUrl === "function") {
        try { url = safeAssetUrl(options.getAssetUrl(id)); } catch { /* Preserve the image reference when storage is offline. */ }
      }
      if (!url) {
        unresolvedImages += 1;
        continue;
      }
      const image = document.createElement("img");
      image.alt = alt;
      image.width = Math.round(width);
      image.height = Math.round(height);
      image.decoding = "async";
      image.draggable = false;
      image.style.position = "absolute";
      image.style.inset = "0";
      image.style.width = "100%";
      image.style.height = "100%";
      image.style.objectFit = "contain";
      image.addEventListener("load", () => {
        slot.classList.add("is-loaded");
        placeholder.hidden = true;
        const notificationKey = `${id}:${url}`;
        if (typeof options.onImageLoad === "function" && container.isConnected && !notifiedImages.has(notificationKey)) {
          notifiedImages.add(notificationKey);
          options.onImageLoad(id, image);
        }
      }, { once: true });
      image.addEventListener("error", () => {
        slot.classList.add("is-unavailable");
        placeholder.textContent = alt ? `图片暂不可用：${alt}` : "图片暂不可用";
      }, { once: true });
      image.src = url;
      slot.append(image);
      images += 1;
    }
    const blocks = [...container.children];
    container.classList.toggle("is-image-only", blocks.length === 1 &&
      blocks[0].tagName === "P" && blocks[0].children.length === 1 &&
      blocks[0].firstElementChild.matches(".md-image") && blocks[0].textContent.trim() === blocks[0].firstElementChild.textContent.trim());
    return { images, unresolvedImages };
  }

  function render(container, source, options = {}) {
    if (!container?.replaceChildren) throw new TypeError("Markdown needs a DOM container");
    container.classList.add("markdown-content");
    bindLinks(container);
    if (!parser || !purify?.sanitize) {
      // Missing dependencies must never turn the body into unsanitized HTML.
      container.textContent = String(source ?? "");
      return { images: 0, unresolvedImages: 0 };
    }
    const html = parser.parse(String(source ?? ""));
    const fragment = purify.sanitize(html, sanitizeOptions);
    container.replaceChildren(fragment);
    return hydrateImages(container, options);
  }

  function assetIds(source) {
    if (!parser || !marked?.walkTokens) return [];
    const ids = new Set();
    marked.walkTokens(parser.lexer(String(source ?? "")), token => {
      if (token.type !== "image") return;
      const match = /^onepage:([a-zA-Z0-9._-]{1,128})$/.exec(String(token.href ?? ""));
      if (match) ids.add(match[1]);
    });
    return [...ids];
  }

  window.OnePageMarkdown = Object.freeze({
    render,
    assetIds,
    clearCache() { notifiedImages.clear(); }
  });
})();
