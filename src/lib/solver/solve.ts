// Parametric constraint solver: resolves variables from formulas, then computes the positions of
// formula-constrained points (offset / length+angle / sliding) in dependency order. Points without a
// `constraint` keep their fixed x/y. Enables measurement-driven re-drafting and true grading.

import type { Pattern, ConstrainablePoint, ConstrainablePath } from '$lib/types/pattern';
import { evalExpr } from './formula';

export type Scope = Record<string, number>;

/**
 * Resolve all variables (+ body measurements) to a scope. Each variable is bound by BOTH its id and
 * its name (the source's formulas reference variables by id; authored constraints use names).
 * `overrides` are per-variable-id (used for grading sizes).
 */
export function resolveVariables(pattern: Pattern, overrides: Record<string, number> = {}): Scope {
  const scope: Scope = {};
  for (const [name, value] of Object.entries(pattern.body.fields)) scope[name] = value;
  const bind = (v: Pattern['variables'][number], val: number) => { scope[v.id] = val; if (v.name) scope[v.name] = val; };

  const resolved = new Set<string>();
  let changed = true;
  let guard = pattern.variables.length + 3;
  while (changed && guard-- > 0) {
    changed = false;
    for (const v of pattern.variables) {
      if (resolved.has(v.id)) continue;
      if (v.id in overrides) { bind(v, overrides[v.id]); resolved.add(v.id); changed = true; continue; }
      const f = v.valueFormula?.formula?.trim();
      if (!f) { bind(v, v.value ?? 0); resolved.add(v.id); changed = true; continue; }
      const r = evalExpr(f, scope);
      if (r !== null) { bind(v, r); resolved.add(v.id); changed = true; }
    }
  }
  for (const v of pattern.variables) if (!resolved.has(v.id)) bind(v, v.value ?? 0);
  return scope;
}

type Pt = { x: number; y: number };

/** Position `dist` mm along a polyline (straight segments between anchors), clamped to its ends. */
function pointAlong(anchors: Pt[], dist: number): Pt {
  if (anchors.length === 1) return { ...anchors[0] };
  let remaining = dist;
  for (let i = 1; i < anchors.length; i++) {
    const a = anchors[i - 1], b = anchors[i];
    const segLen = Math.hypot(b.x - a.x, b.y - a.y);
    if (remaining <= segLen || i === anchors.length - 1) {
      const t = segLen > 0 ? Math.max(0, remaining) / segLen : 0;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    remaining -= segLen;
  }
  return { ...anchors[anchors.length - 1] };
}

/** Solve every point's position given a variable scope. Fixed points keep x/y; constrained points compute. */
export function solvePoints(pattern: Pattern, scope: Scope): Map<string, Pt> {
  const out = new Map<string, Pt>();
  for (const p of pattern.points) if (!p.constraint) out.set(p.id, { x: p.x, y: p.y });
  const pathById = new Map(pattern.paths.map((pa) => [pa.id, pa]));

  let changed = true;
  let guard = pattern.points.length + 4;
  while (changed && guard-- > 0) {
    changed = false;
    for (const p of pattern.points) {
      if (out.has(p.id) || !p.constraint) continue;
      const cn = p.constraint;
      if (cn.type === 'offset' || cn.type === 'lengthAngle') {
        const a = out.get(cn.from);
        if (!a) continue;
        if (cn.type === 'offset') {
          const dx = evalExpr(cn.dxFormula, scope), dy = evalExpr(cn.dyFormula, scope);
          if (dx === null || dy === null) continue;
          out.set(p.id, { x: a.x + dx, y: a.y + dy }); changed = true;
        } else {
          const len = evalExpr(cn.lengthFormula, scope), ang = evalExpr(cn.angleFormula, scope);
          if (len === null || ang === null) continue;
          const r = (ang * Math.PI) / 180;
          out.set(p.id, { x: a.x + len * Math.cos(r), y: a.y + len * Math.sin(r) }); changed = true;
        }
      } else if (cn.type === 'sliding') {
        const path = pathById.get(cn.path);
        if (!path) continue;
        const anchors = path.pathPoints.map((pp) => out.get(pp.id));
        if (anchors.some((a) => !a)) continue;
        const dist = evalExpr(cn.positionFormula, scope);
        if (dist === null) continue;
        out.set(p.id, pointAlong(anchors as Pt[], dist)); changed = true;
      }
    }
  }
  // unresolved constrained points (cycles / missing deps) → keep their last baked position
  for (const p of pattern.points) if (!out.has(p.id)) out.set(p.id, { x: p.x, y: p.y });
  return out;
}

/** Any point in the pattern is parametrically constrained? */
export function hasConstraints(pattern: Pattern): boolean {
  return pattern.points.some((p) => !!p.constraint);
}

/** Return a copy of the pattern with variables resolved and constrained points recomputed. */
export function applySolved(pattern: Pattern, scope: Scope): Pattern {
  const solved = solvePoints(pattern, scope);
  const points: ConstrainablePoint[] = pattern.points.map((p) => {
    const s = solved.get(p.id);
    return s ? { ...p, x: s.x, y: s.y } : p;
  });
  const variables = pattern.variables.map((v) => (v.name in scope ? { ...v, value: scope[v.name] } : v));
  return { ...pattern, points, variables };
}

/** Re-draft from the pattern's own variable values/formulas (live editing). */
export function redraft(pattern: Pattern): Pattern {
  return applySolved(pattern, resolveVariables(pattern));
}

/** Geometry resolved at a graded size (size.values override variable values). */
export function solveForSize(pattern: Pattern, overrides: Record<string, number>): Pattern {
  return applySolved(pattern, resolveVariables(pattern, overrides));
}

const UNIT_MM: Record<string, number> = { cm: 10, mm: 1, inch: 25.4, in: 25.4 };
const unitToMm = (u?: string) => UNIT_MM[u ?? ''] ?? 1;

/**
 * Recover parametric constructions from a template whose points are baked. The original app stores
 * construction on PATHS (a `line` path with `basePoint` + length/angle formulas positions its other
 * endpoint by polar). The construction *order* is lost, so we disambiguate each point's constructor
 * by which formula reproduces its baked position (within tol). Recovered points get a `lengthAngle`
 * constraint (formulas normalised to mm/degrees) so they re-draft from variables; everything else is
 * left untouched. Never moves geometry at base values — only enables parametric editing/grading.
 */
export function makeParametric(pattern: Pattern, tolMm = 2): Pattern {
  if (pattern.points.some((p) => p.constraint)) return pattern; // already parametric / authored
  const scope = resolveVariables(pattern);
  const baked = new Map(pattern.points.map((p) => [p.id, { x: p.x, y: p.y }]));

  // candidate constructors per point: line paths (no `.length` deps, to stay solver-supportable)
  const cand = new Map<string, ConstrainablePath[]>();
  for (const pa of pattern.paths) {
    if (pa.pathType !== 'line' || !pa.basePoint || pa.pathPoints.length !== 2 || !pa.lengthFormula?.formula) continue;
    if (/\.length/.test(pa.lengthFormula.formula) || /\.length/.test(pa.angleFormula?.formula ?? '')) continue;
    const other = pa.pathPoints.find((q) => q.id !== pa.basePoint);
    if (!other) continue;
    (cand.get(other.id) ?? cand.set(other.id, []).get(other.id)!).push(pa);
  }
  if (cand.size === 0) return pattern;

  const norm = (f: string, factor: number) => (factor === 1 ? `(${f})` : `(${f})*${factor}`);
  const sol = new Map<string, { x: number; y: number }>();
  const chosen = new Map<string, ConstrainablePath>();
  for (const p of pattern.points) if (!cand.has(p.id)) sol.set(p.id, baked.get(p.id)!);

  let changed = true, guard = pattern.points.length + 8;
  while (changed && guard-- > 0) {
    changed = false;
    for (const [pid, paths] of cand) {
      if (sol.has(pid)) continue;
      let best: { x: number; y: number } | null = null, bestErr = tolMm, bestPa: ConstrainablePath | null = null;
      for (const pa of paths) {
        const base = sol.get(pa.basePoint!);
        if (!base) continue;
        const lraw = evalExpr(pa.lengthFormula!.formula, scope);
        const araw = pa.angleFormula ? evalExpr(pa.angleFormula.formula, scope) : 0;
        if (lraw === null || araw === null) continue;
        const L = lraw * unitToMm(pa.lengthFormula!.unit);
        const ang = (araw * (pa.angleFormula?.unit === 'radians' ? 180 / Math.PI : 1) * Math.PI) / 180;
        const pos = { x: base.x + L * Math.cos(ang), y: base.y + L * Math.sin(ang) };
        const err = Math.hypot(pos.x - baked.get(pid)!.x, pos.y - baked.get(pid)!.y);
        if (err < bestErr) { bestErr = err; best = pos; bestPa = pa; }
      }
      if (best && bestPa) { sol.set(pid, best); chosen.set(pid, bestPa); changed = true; }
    }
  }
  if (chosen.size === 0) return pattern;

  const points = pattern.points.map((p) => {
    const pa = chosen.get(p.id);
    if (!pa) return p;
    const lf = norm(pa.lengthFormula!.formula, unitToMm(pa.lengthFormula!.unit));
    const af = norm(pa.angleFormula?.formula ?? '0', pa.angleFormula?.unit === 'radians' ? 180 / Math.PI : 1);
    return { ...p, constraint: { type: 'lengthAngle' as const, from: pa.basePoint!, lengthFormula: lf, angleFormula: af } };
  });
  return { ...pattern, points };
}
