// 2D pattern exporters: SVG, DXF (R12 LWPOLYLINE), CSV. All in millimetres.
// Geometry is taken from the placed (world) piece outlines + internal paths.

import type { Pattern } from '$lib/types/pattern';
import {
  indexPaths, indexPoints, pieceWorldOutline, pieceWorldInternalPolylines, pieceAllowancePolygon, pieceTransform, type Vec2
} from './patternGeometry';

type Layer = 'pattern' | 'seam-allowance' | 'internal' | 'marker';
interface Poly { pts: Vec2[]; closed: boolean; layer: Layer }

function collectPolylines(pattern: Pattern): Poly[] {
  const paths = indexPaths(pattern);
  const points = indexPoints(pattern);
  const out: Poly[] = [];
  for (const piece of pattern.pieces) {
    const outline = pieceWorldOutline(pattern, piece, paths, points, 2);
    if (outline.length >= 2) {
      out.push({ pts: outline, closed: true, layer: 'pattern' });
      // seam allowance: the cut line, offset from the stitch outline (per-piece width + corner joins)
      const sa = piece.seamAllowance ?? pattern.seamAllowance ?? 0;
      if (sa > 0.05 && outline.length >= 3) {
        const allow = pieceAllowancePolygon(pattern, piece, piece.seamAllowanceInside ? -sa : sa, paths, points, 2);
        if (allow.length >= 3) out.push({ pts: allow, closed: true, layer: 'seam-allowance' });
      }
    }
    for (const ip of pieceWorldInternalPolylines(pattern, piece, paths, points, 2)) {
      if (ip.length >= 2) out.push({ pts: ip, closed: false, layer: 'internal' });
    }
    // drill holes / punch markers → small circle (drill) or cross (punch)
    if (piece.markers?.length) {
      const tf = pieceTransform(piece, points);
      for (const m of piece.markers) {
        const w = tf({ x: m.x, y: m.y });
        if (m.type === 'drill') {
          const r = 2.5; const circle: Vec2[] = [];
          for (let i = 0; i <= 16; i++) { const a = (i / 16) * Math.PI * 2; circle.push({ x: w.x + Math.cos(a) * r, y: w.y + Math.sin(a) * r }); }
          out.push({ pts: circle, closed: true, layer: 'marker' });
        } else {
          out.push({ pts: [{ x: w.x - 2, y: w.y - 2 }, { x: w.x + 2, y: w.y + 2 }], closed: false, layer: 'marker' });
          out.push({ pts: [{ x: w.x - 2, y: w.y + 2 }, { x: w.x + 2, y: w.y - 2 }], closed: false, layer: 'marker' });
        }
      }
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
  const style: Record<Layer, string> = {
    'pattern': 'stroke="#000" stroke-width="0.5"',
    'seam-allowance': 'stroke="#888" stroke-width="0.4" stroke-dasharray="3,2"',
    'internal': 'stroke="#444" stroke-width="0.35" stroke-dasharray="2,2"',
    'marker': 'stroke="#c0392b" stroke-width="0.4"'
  };
  const paths = polys.map((p) => {
    const d = p.pts.map((v, i) => `${i === 0 ? 'M' : 'L'}${X(v.x)},${Y(v.y)}`).join(' ') + (p.closed ? ' Z' : '');
    return `  <path d="${d}" fill="none" ${style[p.layer]}/>`;
  }).join('\n');
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const texts = (pattern.texts ?? []).filter((t) => t.value).map((t) => {
    const anchor = t.align === 'left' ? 'start' : t.align === 'right' ? 'end' : 'middle';
    const rot = t.rotation ? ` transform="rotate(${(-t.rotation).toFixed(2)} ${X(t.x)} ${Y(t.y)})"` : '';
    return `  <text x="${X(t.x)}" y="${Y(t.y)}" font-size="${(t.fontSize ?? 15).toFixed(1)}" fill="${t.color ?? '#000'}" text-anchor="${anchor}" dominant-baseline="middle"${rot}>${esc(t.value)}</text>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${w.toFixed(1)}mm" height="${h.toFixed(1)}mm" viewBox="0 0 ${w.toFixed(1)} ${h.toFixed(1)}">
${paths}
${texts}
</svg>`;
}

export function patternToDXF(pattern: Pattern): string {
  const polys = collectPolylines(pattern);
  const lines: string[] = ['0', 'SECTION', '2', 'ENTITIES'];
  for (const p of polys) {
    lines.push('0', 'LWPOLYLINE', '8', p.layer, '90', String(p.pts.length), '70', p.closed ? '1' : '0');
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

/** Trigger a Blob download in the browser. */
export function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

/**
 * Pattern → raster PNG (Blob) of the flat plan: light-filled piece outlines + dashed internals,
 * scaled to fit `maxPx` on the long edge. Resolves null if the pattern has no geometry.
 */
export function patternToPNG(pattern: Pattern, maxPx = 2000, marginPx = 40): Promise<Blob | null> {
  const polys = collectPolylines(pattern);
  if (polys.length === 0) return Promise.resolve(null);
  const b = bounds(polys);
  const wMm = b.maxX - b.minX || 1;
  const hMm = b.maxY - b.minY || 1;
  const scale = (maxPx - marginPx * 2) / Math.max(wMm, hMm);
  const W = Math.ceil(wMm * scale + marginPx * 2);
  const H = Math.ceil(hMm * scale + marginPx * 2);
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const c = canvas.getContext('2d');
  if (!c) return Promise.resolve(null);
  c.fillStyle = '#ffffff';
  c.fillRect(0, 0, W, H);
  // pattern y is up; canvas y is down → flip about maxY
  const tx = (v: Vec2) => ({ x: (v.x - b.minX) * scale + marginPx, y: (b.maxY - v.y) * scale + marginPx });
  const trace = (pts: Vec2[]) => {
    c.beginPath();
    const a = tx(pts[0]); c.moveTo(a.x, a.y);
    for (let i = 1; i < pts.length; i++) { const q = tx(pts[i]); c.lineTo(q.x, q.y); }
  };
  for (const p of polys) {
    if (!p.closed) continue;
    trace(p.pts); c.closePath();
    c.fillStyle = 'rgba(148,163,184,0.15)'; c.fill();
    c.strokeStyle = '#1e293b'; c.lineWidth = 2; c.setLineDash([]); c.stroke();
  }
  c.strokeStyle = 'rgba(30,41,59,0.6)'; c.lineWidth = 1.5; c.setLineDash([6, 4]);
  for (const p of polys) { if (p.closed) continue; trace(p.pts); c.stroke(); }
  c.setLineDash([]);
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), 'image/png'));
}

/** Open the pattern's SVG in a new window and invoke the browser's print dialog. */
export function printPattern(pattern: Pattern, title = 'Pattern') {
  const svg = patternToSVG(pattern);
  const w = window.open('', '_blank', 'width=900,height=700');
  if (!w) return;
  w.document.write(
    `<!doctype html><html><head><title>${title}</title>` +
      `<style>@page{margin:10mm}body{margin:0}svg{width:100%;height:auto;display:block}</style>` +
      `</head><body>${svg}` +
      `<script>window.onload=function(){window.focus();window.print();}<\/script>` +
      `</body></html>`
  );
  w.document.close();
}
