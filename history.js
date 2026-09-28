/* Local undo/redo. Only document differences are retained, never full document
 * snapshots on each keystroke. Images remain immutable private assets. */
(() => {
  "use strict";
  const MAX_BYTES = 4 * 1024 * 1024;
  const NOTE_FIELDS = ["pageId", "content", "contentScale", "x", "y", "w", "h",
    "manualSize", "manualPosition", "conflictOf", "legacyTags"];
  const PAGE_FIELDS = ["name", "width", "height", "conflictOf"];
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object || {}, key);
  const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const equal = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);
  const mapItems = items => new Map((items || []).map(item => [item.id, item]));
  const scale = value => Number.isFinite(value) && value >= 0.25 && value <= 8 ? value : 1;

  function valueAt(item, field) {
    if (field === "contentScale") return { present: true, value: scale(item?.contentScale) };
    return { present: own(item, field), value: clone(item?.[field]) };
  }

  function digest(text) {
    let first = 2166136261, second = 2246822519;
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      first = Math.imul(first ^ code, 16777619);
      second = Math.imul(second ^ code, 1597334677);
    }
    return [text.length, first >>> 0, second >>> 0];
  }

  function textDifference(before, after) {
    let start = 0;
    const common = Math.min(before.length, after.length);
    while (start < common && before[start] === after[start]) start++;
    let oldEnd = before.length, newEnd = after.length;
    while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) {
      oldEnd--; newEnd--;
    }
    return { field: "content", text: true, start,
      // Detach slices from their potentially huge original string buffers.
      removed: clone(before.slice(start, oldEnd)), inserted: clone(after.slice(start, newEnd)),
      before: digest(before), after: digest(after) };
  }

  function recordMatches(a, b, collection) {
    if (!a || !b || a.id !== b.id) return false;
    const fields = collection === "notes" ? NOTE_FIELDS : PAGE_FIELDS;
    return fields.every(field => equal(valueAt(a, field), valueAt(b, field)));
  }

  function collectDifferences(before, after, collection) {
    const oldItems = mapItems(before[collection]), newItems = mapItems(after[collection]);
    const fields = collection === "notes" ? NOTE_FIELDS : PAGE_FIELDS;
    const operations = [];
    for (const id of new Set([...oldItems.keys(), ...newItems.keys()])) {
      const oldItem = oldItems.get(id), newItem = newItems.get(id);
      if (!oldItem || !newItem) {
        operations.push({ collection, id, kind: oldItem ? "remove" : "add", item: clone(oldItem || newItem),
          index: (oldItem ? before[collection] : after[collection]).findIndex(item => item.id === id) });
        continue;
      }
      const changes = [];
      for (const field of fields) {
        // Comparing strings directly avoids copying whole bodies into a value wrapper.
        if (field === "content" && typeof oldItem.content === "string" && typeof newItem.content === "string") {
          if (oldItem.content !== newItem.content) changes.push(textDifference(oldItem.content, newItem.content));
          continue;
        }
        const oldValue = valueAt(oldItem, field), newValue = valueAt(newItem, field);
        if (!equal(oldValue, newValue)) changes.push({ field, before: oldValue, after: newValue });
      }
      if (changes.length) operations.push({ collection, id, kind: "fields", changes });
    }
    return operations;
  }

  function assetDifference(before, after) {
    const result = {};
    for (const id of new Set([...Object.keys(before.assets || {}), ...Object.keys(after.assets || {})])) {
      const oldAsset = before.assets?.[id], newAsset = after.assets?.[id];
      if (!equal(oldAsset, newAsset)) result[id] = clone(newAsset || oldAsset);
    }
    return result;
  }

  function estimatedBytes(value) {
    if (typeof value === "string") return 16 + value.length * 2;
    if (value === null || value === undefined || typeof value !== "object") return 8;
    let bytes = 32;
    for (const [key, item] of Object.entries(value)) bytes += 16 + key.length * 2 + estimatedBytes(item);
    return bytes;
  }

  function selectionCopy(value) {
    if (value === undefined) return undefined;
    try { return estimatedBytes(value) <= 16_384 ? clone(value) : undefined; }
    catch { return undefined; }
  }

  function operationShape(operations) {
    return operations.map(operation => `${operation.collection}:${operation.id}:${operation.kind}:${
      operation.changes?.map(change => change.field).join(",") || ""}`).join("|");
  }

  function coalesce(previous, next, before, after) {
    if (previous.operations.some(operation => operation.kind !== "fields") ||
        operationShape(previous.operations) !== operationShape(next.operations)) return null;
    const combined = clone(previous);
    for (let index = 0; index < next.operations.length; index++) {
      const oldOperation = previous.operations[index], newOperation = next.operations[index];
      const target = combined.operations[index];
      target.changes = [];
      for (let fieldIndex = 0; fieldIndex < newOperation.changes.length; fieldIndex++) {
        const oldChange = oldOperation.changes[fieldIndex], newChange = newOperation.changes[fieldIndex];
        if (!equal(oldChange.after, newChange.before)) return null;
        if (oldChange.text) {
          const currentBefore = mapItems(before[newOperation.collection]).get(newOperation.id)?.content;
          const currentAfter = mapItems(after[newOperation.collection]).get(newOperation.id)?.content;
          if (typeof currentBefore !== "string" || typeof currentAfter !== "string" ||
              currentBefore.slice(oldChange.start, oldChange.start + oldChange.inserted.length) !== oldChange.inserted) return null;
          const original = currentBefore.slice(0, oldChange.start) + oldChange.removed +
            currentBefore.slice(oldChange.start + oldChange.inserted.length);
          if (original !== currentAfter) target.changes.push(textDifference(original, currentAfter));
        } else if (!equal(oldChange.before, newChange.after)) {
          target.changes.push({ field: oldChange.field, before: clone(oldChange.before), after: clone(newChange.after) });
        }
      }
    }
    combined.operations = combined.operations.filter(operation => operation.changes.length);
    combined.assets = { ...combined.assets, ...next.assets };
    combined.selectionAfter = next.selectionAfter;
    combined.at = next.at;
    return combined;
  }

  function directionKind(operation, undo) {
    return operation.kind === "fields" ? "fields" : undo
      ? operation.kind === "add" ? "remove" : "add" : operation.kind;
  }

  function operationOrder(operation, undo) {
    const kind = directionKind(operation, undo);
    if (operation.collection === "pages" && kind === "add") return 0;
    if (operation.collection === "pages" && kind === "remove") return 3;
    return operation.collection === "notes" && kind === "remove" ? 1 : 2;
  }

  function applyStep(step, current, undo) {
    const data = clone(current);
    data.pages ||= []; data.notes ||= []; data.assets ||= {};
    let conflicts = 0;
    const appliedOperations = [];
    for (const [id, asset] of Object.entries(step.assets)) {
      if (!own(data.assets, id)) data.assets[id] = clone(asset);
      else if (!equal(data.assets[id], asset)) conflicts++;
    }
    const operations = [...step.operations].sort((a, b) => operationOrder(a, undo) - operationOrder(b, undo));
    for (const operation of operations) {
      const items = data[operation.collection];
      const index = items.findIndex(item => item.id === operation.id);
      const item = items[index];
      const kind = directionKind(operation, undo);
      if (kind === "add") {
        if (item || operation.collection === "notes" && !data.pages.some(page => page.id === operation.item.pageId)) {
          conflicts++; continue;
        }
        items.splice(Math.min(operation.index, items.length), 0, clone(operation.item));
      } else if (kind === "remove") {
        if (!recordMatches(item, operation.item, operation.collection) ||
            operation.collection === "pages" && data.notes.some(note => note.pageId === operation.id)) {
          conflicts++; continue;
        }
        items.splice(index, 1);
      } else {
        if (!item) { conflicts++; continue; }
        const updates = [];
        let matches = true;
        for (const change of operation.changes) {
          const expected = undo ? change.after : change.before;
          const desired = undo ? change.before : change.after;
          if (change.text) {
            const from = undo ? change.inserted : change.removed;
            const to = undo ? change.removed : change.inserted;
            if (typeof item.content !== "string" || !equal(digest(item.content), expected) ||
                item.content.slice(change.start, change.start + from.length) !== from) { matches = false; break; }
            updates.push([change.field, { present: true, value: item.content.slice(0, change.start) + to +
              item.content.slice(change.start + from.length) }]);
          } else {
            if (!equal(valueAt(item, change.field), expected) || change.field === "pageId" &&
                desired.present && !data.pages.some(page => page.id === desired.value)) { matches = false; break; }
            updates.push([change.field, desired]);
          }
        }
        // Apply one note's related fields atomically so a conflicted resize
        // cannot change width while leaving the content scale unchanged.
        if (!matches) { conflicts++; continue; }
        for (const [field, desired] of updates) {
          if (desired.present) item[field] = clone(desired.value);
          else delete item[field];
        }
        item.updatedAt = new Date().toISOString();
      }
      appliedOperations.push(operation);
    }
    if (!data.pages.some(page => page.id === data.activePageId)) data.activePageId = data.pages[0]?.id || null;
    return { data, selection: undo ? clone(step.selectionBefore) : clone(step.selectionAfter),
      applied: appliedOperations.length, conflicts, appliedOperations };
  }

  class OnePageHistory {
    #undo = [];
    #redo = [];
    #maxSteps;
    #maxBytes;
    #window;
    constructor({ maxSteps = 60, maxBytes = MAX_BYTES, groupWindowMs = 800 } = {}) {
      this.#maxSteps = Number.isInteger(maxSteps) && maxSteps > 0 ? Math.min(60, maxSteps) : 60;
      this.#maxBytes = Number.isFinite(maxBytes) && maxBytes >= 128 ? Math.min(MAX_BYTES, maxBytes) : MAX_BYTES;
      this.#window = Number.isFinite(groupWindowMs) && groupWindowMs >= 0 ? groupWindowMs : 800;
    }
    canUndo() { return this.#undo.length > 0; }
    canRedo() { return this.#redo.length > 0; }
    reset() { this.#undo = []; this.#redo = []; }
    stats() { return { undoSteps: this.#undo.length, redoSteps: this.#redo.length,
      bytes: [...this.#undo, ...this.#redo].reduce((total, step) => total + step.bytes, 0) }; }
    capture(before, after, options = {}) {
      const operations = [...collectDifferences(before, after, "pages"), ...collectDifferences(before, after, "notes")];
      if (!operations.length) return { recorded: false, reason: "unchanged" };
      let step = { operations, assets: assetDifference(before, after),
        group: typeof options.group === "string" ? options.group.slice(0, 200) : null,
        selectionBefore: selectionCopy(options.selectionBefore), selectionAfter: selectionCopy(options.selectionAfter),
        at: Number.isFinite(options.at) ? options.at : Date.now() };
      this.#redo = [];
      const previous = this.#undo.at(-1);
      if (step.group && previous?.group === step.group && step.at >= previous.at && step.at - previous.at <= this.#window) {
        const combined = coalesce(previous, step, before, after);
        if (combined) {
          step = combined;
          this.#undo.pop();
        }
      }
      if (!step.operations.length) return { recorded: true, reason: "coalesced-away" };
      delete step.bytes;
      step.bytes = estimatedBytes(step);
      if (step.bytes > this.#maxBytes) return { recorded: false, reason: "too-large" };
      this.#undo.push(step);
      while (this.stats().bytes > this.#maxBytes || this.#undo.length > this.#maxSteps) this.#undo.shift();
      return { recorded: true };
    }
    #travel(current, undo) {
      const source = undo ? this.#undo : this.#redo;
      const target = undo ? this.#redo : this.#undo;
      const step = source.pop();
      if (!step) return { data: current, selection: undefined, applied: 0, conflicts: 0 };
      const result = applyStep(step, current, undo);
      if (result.applied) {
        const transferable = { ...step, operations: result.appliedOperations };
        delete transferable.bytes;
        transferable.bytes = estimatedBytes(transferable);
        target.push(transferable);
      }
      delete result.appliedOperations;
      return result;
    }
    undo(current) { return this.#travel(current, true); }
    redo(current) { return this.#travel(current, false); }
  }
  if (typeof window !== "undefined") window.OnePageHistory = OnePageHistory;
  if (typeof module !== "undefined" && module.exports) module.exports = OnePageHistory;
})();
