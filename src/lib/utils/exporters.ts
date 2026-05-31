// 2D pattern exporters: SVG, DXF (R12 LWPOLYLINE), CSV. All in millimetres.
// Geometry is taken from the placed (world) piece outlines + internal paths.

import type { Pattern } from '$lib/types/pattern';
import {
  indexPaths, indexPoints, pieceWorldOutline, pieceWorldInternalPolylines, type Vec2
} from './patternGeometry';

interface Poly { pts: Vec2[]; closed: boolean }

function collectPolylines(pattern: Pattern): Poly[] {
  const paths = indexPaths(pattern);
  const points = indexPoints(pattern);
  const out: Poly[] = [];
  for (const piece of pattern.pieces) {
    const outline = pieceWorldOutline(pattern, piece, paths, points, 2);
    if (outline.length >= 2) out.push({ pts: outline, closed: true });
    for (const ip of pieceWorldInternalPolylines(pattern, piece, paths, points, 2)) {
      if (ip.length >= 2) out.push({ pts: ip, closed: false });
    }
  }
  return out;
}

function bounds(polys: Poly[]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of polys) for (const v of p.pts) {
    minX = Math.min(minX, v.x); minY = Math.min(minY, v.y);
    maxX = Math.max(maxX, v.x); maxY = Math.max(maxY, v.y);
  }
  if (!isFinite(minX)) { minX = minY = 0; maxX = maxY = 100; }
  return { minX, minY, maxX, maxY };
}

export function patternToSVG(pattern: Pattern): string {
  const polys = collectPolylines(pattern);
  const b = bounds(polys);
  const pad = 20;
  const w = b.maxX - b.minX + pad * 2, h = b.maxY - b.minY + pad * 2;
  // SVG y is down; pattern y is up → flip y about maxY
  const X = (x: number) => (x - b.minX + pad).toFixed(2);
  const Y = (y: number) => (b.maxY - y + pad).toFixed(2);
  const paths = polys.map((p) => {
    const d = p.pts.map((v, i) => `${i === 0 ? 'M' : 'L'}${X(v.x)},${Y(v.y)}`).join(' ') + (p.closed ? ' Z' : '');
    return `  <path d="${d}" fill="none" stroke="#000" stroke-width="0.5"/>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${w.toFixed(1)}mm" height="${h.toFixed(1)}mm" viewBox="0 0 ${w.toFixed(1)} ${h.toFixed(1)}">
${paths}
</svg>`;
}

export function patternToDXF(pattern: Pattern): string {
  const polys = collectPolylines(pattern);
  const lines: string[] = ['0', 'SECTION', '2', 'ENTITIES'];
  for (const p of polys) {
    lines.push('0', 'LWPOLYLINE', '8', 'pattern', '90', String(p.pts.length), '70', p.closed ? '1' : '0');
    for (const v of p.pts) lines.push('10', v.x.toFixed(3), '20', v.y.toFixed(3));
  }
  lines.push('0', 'ENDSEC', '0', 'EOF');
  return lines.join('\n');
}

export function patternToCSV(pattern: Pattern): string {
  const rows = ['point,x_mm,y_mm'];
  for (const p of pattern.points) rows.push(`${JSON.stringify(p.name)},${p.x.toFixed(3)},${p.y.toFixed(3)}`);
  return rows.join('\n');
}

export function downloadText(filename: string, text: string, mime: string) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}
