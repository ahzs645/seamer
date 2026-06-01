// Minimal HPGL (plotter) parser → polylines in millimetres, for the 2D trace overlay.
// Handles the common drawing subset: PU (pen-up move), PD (pen-down draw), PA (plot absolute);
// other mnemonics (IN, SP, SC, PR, …) are ignored. Plotter units are 1/40 mm (40 units/mm).

import type { Vec2 } from './patternGeometry';

const UNIT_MM = 0.025; // 1 plotter unit = 0.025 mm

/** Polylines (mm) → HPGL plotter program. Each polyline = pen-up to its start, pen-down through its
 *  points; closed polylines repeat their first point. Optional pen-per-polyline for layer colours. */
export function toHPGL(polys: { pts: Vec2[]; closed?: boolean; pen?: number }[]): string {
  const u = (v: number) => Math.round(v / UNIT_MM); // mm → plotter units
  const out: string[] = ['IN;', 'SP1;'];
  let pen = 1;
  for (const poly of polys) {
    const pts = poly.pts;
    if (pts.length < 2) continue;
    if (poly.pen && poly.pen !== pen) { pen = poly.pen; out.push(`SP${pen};`); }
    out.push(`PU${u(pts[0].x)},${u(pts[0].y)};`);
    const seq = poly.closed ? [...pts.slice(1), pts[0]] : pts.slice(1);
    out.push('PD' + seq.map((p) => `${u(p.x)},${u(p.y)}`).join(',') + ';');
  }
  out.push('PU;', 'SP0;', 'IN;');
  return out.join('\n');
}

export function parseHPGL(text: string): Vec2[][] {
  const polys: Vec2[][] = [];
  let cur: Vec2[] = [];
  let penDown = false;
  let x = 0, y = 0;
  const flush = () => { if (cur.length > 1) polys.push(cur); cur = []; };

  for (const raw of text.replace(/[\r\n]+/g, '').split(';')) {
    const cmd = raw.trim();
    if (cmd.length < 2) continue;
    const op = cmd.slice(0, 2).toUpperCase();
    const args = cmd.slice(2).split(/[\s,]+/).map(Number).filter((n) => Number.isFinite(n));
    if (op === 'PU') {
      flush();
      penDown = false;
      for (let i = 0; i + 1 < args.length; i += 2) { x = args[i]; y = args[i + 1]; }
      cur = [{ x: x * UNIT_MM, y: y * UNIT_MM }];
    } else if (op === 'PD') {
      penDown = true;
      if (cur.length === 0) cur = [{ x: x * UNIT_MM, y: y * UNIT_MM }];
      for (let i = 0; i + 1 < args.length; i += 2) { x = args[i]; y = args[i + 1]; cur.push({ x: x * UNIT_MM, y: y * UNIT_MM }); }
    } else if (op === 'PA') {
      for (let i = 0; i + 1 < args.length; i += 2) {
        x = args[i]; y = args[i + 1];
        if (penDown) cur.push({ x: x * UNIT_MM, y: y * UNIT_MM });
        else { flush(); cur = [{ x: x * UNIT_MM, y: y * UNIT_MM }]; }
      }
    }
  }
  flush();
  return polys;
}
