/* Fixed-paper geometry for One Page. All dimensions are CSS pixels. */
(function (root) {
  'use strict';

  const MARGIN = 6;
  const GAP = 4;
  const EPSILON = 0.000001;

  function number(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function normalizeBounds(bounds) {
    if (!bounds || typeof bounds !== 'object') return null;
    const x = number(bounds.x, 0);
    const y = number(bounds.y, 0);
    const w = number(bounds.w ?? bounds.width, NaN);
    const h = number(bounds.h ?? bounds.height, NaN);
    if (!(w > 0 && h > 0)) return null;
    return { x, y, w, h };
  }

  function normalizeRect(rect) {
    if (!rect || typeof rect !== 'object') return null;
    const x = number(rect.x, NaN);
    const y = number(rect.y, NaN);
    const w = number(rect.w ?? rect.width, NaN);
    const h = number(rect.h ?? rect.height, NaN);
    if (!(w > 0 && h > 0) || !Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x, y, w, h, id: rect.id };
  }

  function overlapsWithGap(a, b) {
    return a.x < b.x + b.w + GAP - EPSILON &&
      a.x + a.w + GAP > b.x + EPSILON &&
      a.y < b.y + b.h + GAP - EPSILON &&
      a.y + a.h + GAP > b.y + EPSILON;
  }

  function isValidRect(rect, existingRects, bounds, exceptId) {
    const box = normalizeRect(rect);
    const paper = normalizeBounds(bounds);
    if (!box || !paper) return false;
    if (box.x < paper.x + MARGIN - EPSILON ||
      box.y < paper.y + MARGIN - EPSILON ||
      box.x + box.w > paper.x + paper.w - MARGIN + EPSILON ||
      box.y + box.h > paper.y + paper.h - MARGIN + EPSILON) return false;

    for (const candidate of Array.isArray(existingRects) ? existingRects : []) {
      if (exceptId !== undefined && candidate && candidate.id === exceptId) continue;
      const other = normalizeRect(candidate);
      if (other && overlapsWithGap(box, other)) return false;
    }
    return true;
  }

  function uniqueCoordinates(values, minimum, maximum) {
    const seen = new Set();
    const result = [];
    for (const value of values) {
      if (!Number.isFinite(value) || value < minimum - EPSILON || value > maximum + EPSILON) continue;
      const clamped = Math.max(minimum, Math.min(maximum, value));
      // Geometry is measured in CSS pixels; this also deduplicates equal edge candidates.
      const key = clamped.toFixed(4);
      if (!seen.has(key)) {
        seen.add(key);
        result.push(clamped);
      }
    }
    return result;
  }

  function findPlacement(existingRects, size, bounds, preferred) {
    const paper = normalizeBounds(bounds);
    const requested = normalizeRect({ x: 0, y: 0, w: size && (size.w ?? size.width), h: size && (size.h ?? size.height) });
    if (!paper || !requested) return null;

    const minX = paper.x + MARGIN;
    const minY = paper.y + MARGIN;
    const maxX = paper.x + paper.w - MARGIN - requested.w;
    const maxY = paper.y + paper.h - MARGIN - requested.h;
    if (maxX < minX - EPSILON || maxY < minY - EPSILON) return null;

    const preferredX = preferred && Number.isFinite(Number(preferred.x))
      ? Math.max(minX, Math.min(maxX, Number(preferred.x))) : null;
    const preferredY = preferred && Number.isFinite(Number(preferred.y))
      ? Math.max(minY, Math.min(maxY, Number(preferred.y))) : null;
    const hasPreferred = preferredX !== null && preferredY !== null;
    const occupied = (Array.isArray(existingRects) ? existingRects : []).map(normalizeRect).filter(Boolean);

    if (hasPreferred && isValidRect({ ...requested, x: preferredX, y: preferredY }, occupied, paper)) {
      return { x: preferredX, y: preferredY };
    }

    const xEdges = [minX, maxX];
    const yEdges = [minY, maxY];
    if (hasPreferred) {
      xEdges.push(preferredX);
      yEdges.push(preferredY);
    }
    for (const other of occupied) {
      xEdges.push(other.x - requested.w - GAP, other.x + other.w + GAP);
      yEdges.push(other.y - requested.h - GAP, other.y + other.h + GAP);
    }
    const xs = uniqueCoordinates(xEdges, minX, maxX);
    const ys = uniqueCoordinates(yEdges, minY, maxY);
    const positions = [];
    for (const y of ys) {
      for (const x of xs) {
        positions.push({ x, y, distance: hasPreferred
          ? Math.hypot(x - preferredX, y - preferredY) : 0 });
      }
    }
    positions.sort((a, b) => (a.distance - b.distance) || (a.y - b.y) || (a.x - b.x));
    for (const position of positions) {
      if (isValidRect({ ...requested, x: position.x, y: position.y }, occupied, paper)) {
        return { x: position.x, y: position.y };
      }
    }
    return null;
  }

  function makeRectSize(text, measureHeight, bounds, options) {
    if (typeof measureHeight !== 'function') throw new TypeError('measureHeight must be a function');
    const paper = normalizeBounds(bounds);
    if (!paper) return null;

    const settings = options || {};
    // Placement always reserves MARGIN; sizing may reserve more, never less.
    const margin = Math.max(MARGIN, number(settings.margin, MARGIN));
    const availableWidth = paper.w - 2 * margin;
    const availableHeight = paper.h - 2 * margin;
    if (availableWidth <= 0 || availableHeight <= 0) return null;

    const minWidth = Math.min(availableWidth, Math.max(1, number(settings.minWidth, 112)));
    const maxWidth = Math.min(availableWidth, Math.max(minWidth, number(settings.maxWidth, availableWidth)));
    const minHeight = Math.max(1, number(settings.minHeight, 20));
    const extraHeight = Math.max(0, number(settings.extraHeight, 2));
    const targetAspect = Math.max(0.1, number(settings.targetAspect, 1.25));
    if (minHeight > availableHeight) return null;

    const widths = [minWidth, maxWidth];
    // Dense enough to respond to line wraps while keeping measurement inexpensive.
    for (let width = Math.ceil(minWidth / 24) * 24; width < maxWidth; width += 24) widths.push(width);
    if (Number.isFinite(Number(settings.preferredWidth))) widths.push(Number(settings.preferredWidth));

    let best = null;
    const seen = new Set();
    for (const candidate of widths) {
      const width = Math.max(minWidth, Math.min(maxWidth,
        Math.ceil(Math.max(minWidth, Math.min(maxWidth, candidate)))));
      if (seen.has(width)) continue;
      seen.add(width);
      // The callback measures the entire card, including its padding and border,
      // for this *outer* width. The same CSS must be used when rendering the card.
      const measured = Number(measureHeight(width, String(text ?? '')));
      if (!Number.isFinite(measured) || measured < 0) continue;
      const height = Math.ceil(Math.max(minHeight, measured + extraHeight));
      if (height > availableHeight || width > availableWidth) continue;

      const area = width * height;
      const aspect = width / height;
      // Compact area is primary. A mild penalty avoids very tall slivers when
      // a wider card contains the same text in nearly the same total area.
      const score = area * (1 + 0.12 * Math.abs(Math.log(aspect / targetAspect)));
      if (!best || score < best.score ||
        (Math.abs(score - best.score) < EPSILON && width < best.w)) {
        best = { w: width, h: height, score };
      }
    }
    return best ? { w: best.w, h: best.h } : null;
  }

  root.OnePageLayout = Object.freeze({
    MARGIN, GAP, normalizeBounds, normalizeRect,
    makeRectSize, findPlacement, isValidRect
  });
})(typeof window !== 'undefined' ? window : globalThis);
