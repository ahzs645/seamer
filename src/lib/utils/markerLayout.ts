// Marker / cut-nesting layout: pack every piece's cut outline (seam-allowance line, or the stitch
// outline when there's no allowance) onto a fabric of a fixed width, minimising total length. Uses a
// simple shelf (first-fit decreasing by height) packer on axis-aligned bounding boxes — good enough
// for a usable cutting marker; rotation/true-shape nesting is intentionally out of scope.

import type { Pattern } from '$lib/types/pattern';
import {
  indexPaths, indexPoints, pieceWorldOutline, pieceAllowancePolygon, pieceCutCounts, type Vec2
} from './patternGeometry';

export interface Placement {
  pieceId: string;
  name: string;
  /** translated cut polygon in marker space (mm, origin top-left, y down) */
  poly: Vec2[];
  /** translated stitch outline (for reference inside the cut line) */
  outline: Vec2[];
  bbox: { w: number; h: number };
}

export interface MarkerLayout {
  fabricWidthMm: number;
  usedLengthMm: number;
  gapMm: number;
  placements: Placement[];
}

function polyBounds(poly: Vec2[]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of poly) {
    if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

/** Pack pieces onto a fabric of width `fabricWidthMm`, returning per-piece marker placements. */
export function nestPieces(pattern: Pattern, fabricWidthMm = 1400, gapMm = 10): MarkerLayout {
  const paths = indexPaths(pattern);
  const points = indexPoints(pattern);

  // Each piece → its cut polygon (allowance if any) + stitch outline, both normalised to local (0,0).
  interface Item { pieceId: string; name: string; cut: Vec2[]; outline: Vec2[]; w: number; h: number }
  const items: Item[] = [];
  for (const piece of pattern.pieces) {
    if (piece.hidden) continue;
    const outline = pieceWorldOutline(pattern, piece, paths, points, 2);
    if (outline.length < 3) continue;
    const sa = piece.seamAllowance ?? pattern.seamAllowance ?? 0;
    const cut = sa > 0.05 ? pieceAllowancePolygon(pattern, piece, piece.seamAllowanceInside ? -sa : sa, paths, points, 2) : outline;
    const ref = cut.length >= 3 ? cut : outline;
    const bb = polyBounds(ref);
    const w = bb.maxX - bb.minX, h = bb.maxY - bb.minY;
    const norm = (poly: Vec2[]) => poly.map((p) => ({ x: p.x - bb.minX, y: p.y - bb.minY }));
    // mirror a normalised poly within its own bbox, across the configured axis
    const mirror = (poly: Vec2[]) => poly.map((p) => (piece.mirrorLeftPiecesAxis === 'Y' ? { x: p.x, y: h - p.y } : { x: w - p.x, y: p.y }));
    const baseCut = norm(ref), baseOut = norm(outline);
    const { asIs, mirrored } = pieceCutCounts(piece);
    for (let i = 0; i < asIs; i++) items.push({ pieceId: piece.id, name: piece.name, cut: baseCut, outline: baseOut, w, h });
    for (let i = 0; i < mirrored; i++) items.push({ pieceId: piece.id, name: `${piece.name} (mirror)`, cut: mirror(baseCut), outline: mirror(baseOut), w, h });
  }

  // First-fit decreasing by height (shelf packing).
  items.sort((a, b) => b.h - a.h);
  const placements: Placement[] = [];
  let shelfY = gapMm;
  let cursorX = gapMm;
  let shelfH = 0;
  let usedLength = gapMm;
  for (const it of items) {
    if (cursorX + it.w + gapMm > fabricWidthMm && cursorX > gapMm) {
      // new shelf
      shelfY += shelfH + gapMm;
      cursorX = gapMm;
      shelfH = 0;
    }
    const dx = cursorX, dy = shelfY;
    placements.push({
      pieceId: it.pieceId,
      name: it.name,
      poly: it.cut.map((p) => ({ x: p.x + dx, y: p.y + dy })),
      outline: it.outline.map((p) => ({ x: p.x + dx, y: p.y + dy })),
      bbox: { w: it.w, h: it.h }
    });
    cursorX += it.w + gapMm;
    shelfH = Math.max(shelfH, it.h);
    usedLength = Math.max(usedLength, shelfY + it.h + gapMm);
  }
  return { fabricWidthMm, usedLengthMm: usedLength, gapMm, placements };
}

/** Render a nesting layout as a true-scale SVG (mm), fabric outlined, pieces labelled. */
export function markerToSVG(layout: MarkerLayout): string {
  const W = layout.fabricWidthMm;
  const H = Math.max(layout.usedLengthMm, 50);
  const path = (poly: Vec2[], closed = true) =>
    poly.map((v, i) => `${i === 0 ? 'M' : 'L'}${v.x.toFixed(2)},${v.y.toFixed(2)}`).join(' ') + (closed ? ' Z' : '');
  const body = layout.placements.map((pl) => {
    const cx = pl.poly.reduce((s, p) => s + p.x, 0) / (pl.poly.length || 1);
    const cy = pl.poly.reduce((s, p) => s + p.y, 0) / (pl.poly.length || 1);
    return (
      `  <path d="${path(pl.poly)}" fill="rgba(148,163,184,0.12)" stroke="#888" stroke-width="0.4" stroke-dasharray="3,2"/>\n` +
      `  <path d="${path(pl.outline)}" fill="none" stroke="#000" stroke-width="0.5"/>\n` +
      `  <text x="${cx.toFixed(1)}" y="${cy.toFixed(1)}" font-size="10" fill="#334155" text-anchor="middle" dominant-baseline="middle">${pl.name.replace(/[<&>]/g, '')}</text>`
    );
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W.toFixed(1)}mm" height="${H.toFixed(1)}mm" viewBox="0 0 ${W.toFixed(1)} ${H.toFixed(1)}">
  <rect x="0" y="0" width="${W.toFixed(1)}" height="${H.toFixed(1)}" fill="none" stroke="#0ea5e9" stroke-width="0.6"/>
${body}
</svg>`;
}
