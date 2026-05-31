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
  for (const [name, value] of Object.entries(pattern.body?.fields ?? {})) scope[name] = value as number;
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

const UNIT_MM: Record<string, number> = { cm: 10, mm: 1, inch: 25.4, in: 25.4 };
const unitToMm = (u?: string) => UNIT_MM[u ?? ''] ?? 1;

function cubicAt(a: Pt, c1: Pt, c2: Pt, b: Pt, t: number): Pt {
  const mt = 1 - t, w0 = mt * mt * mt, w1 = 3 * mt * mt * t, w2 = 3 * mt * t * t, w3 = t * t * t;
  return { x: w0 * a.x + w1 * c1.x + w2 * c2.x + w3 * b.x, y: w0 * a.y + w1 * c1.y + w2 * c2.y + w3 * b.y };
}

/** Geometric length (mm) of a path from its currently-solved anchors (cubic when handles exist). */
function pathLengthMm(path: ConstrainablePath, solved: Map<string, Pt>): number | null {
  const seq = path.pathPoints.map((pp) => ({ p: solved.get(pp.id), h: pp.handle }));
  if (seq.some((s) => !s.p)) return null;
  let L = 0;
  for (let i = 1; i < seq.length; i++) {
    const a = seq[i - 1].p!, b = seq[i].p!;
    const out = seq[i - 1].h?.v2, inc = seq[i].h?.v1;
    if (out || inc) {
      const c1 = out ? { x: a.x + out.x, y: a.y + out.y } : a;
      const c2 = inc ? { x: b.x + inc.x, y: b.y + inc.y } : b;
      let prev = a;
      for (let s = 1; s <= 16; s++) { const q = cubicAt(a, c1, c2, b, s / 16); L += Math.hypot(q.x - prev.x, q.y - prev.y); prev = q; }
    } else L += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return L;
}

/** Replace `PathId.length` tokens with the path's length expressed in `unit`. null if unresolvable yet. */
function subLengths(formula: string, unit: string, solved: Map<string, Pt>, pathById: Map<string, ConstrainablePath>): string | null {
  if (!/\.length/.test(formula)) return formula;
  let ok = true;
  const r = formula.replace(/([A-Za-z_$][\w$]*)\.length/g, (_m, id) => {
    const path = pathById.get(id);
    const L = path ? pathLengthMm(path, solved) : null;
    if (L === null) { ok = false; return '0'; }
    return String(L / unitToMm(unit));
  });
  return ok ? r : null;
}

function evalLen(formula: string, unit: string, scope: Scope, solved: Map<string, Pt>, pathById: Map<string, ConstrainablePath>): number | null {
  const sub = subLengths(formula, unit, solved, pathById);
  if (sub === null) return null;
  const r = evalExpr(sub, scope);
  return r === null ? null : r * unitToMm(unit);
}
function evalAngleDeg(formula: string, unit: string | undefined, scope: Scope, solved: Map<string, Pt>, pathById: Map<string, ConstrainablePath>): number | null {
  const sub = subLengths(formula, 'mm', solved, pathById); // any path-length ref in an angle stays in mm
  if (sub === null) return null;
  const r = evalExpr(sub, scope);
  return r === null ? null : r * (unit === 'radians' ? 180 / Math.PI : 1);
}

/** Compute a constrained point's position, or null if its dependencies aren't solved yet. */
function constraintPos(cn: NonNullable<ConstrainablePoint['constraint']>, scope: Scope, solved: Map<string, Pt>, pathById: Map<string, ConstrainablePath>): Pt | null {
  if (cn.type === 'offset') {
    const a = solved.get(cn.from); if (!a) return null;
    const dx = evalLen(cn.dxFormula, cn.unit ?? 'mm', scope, solved, pathById);
    const dy = evalLen(cn.dyFormula, cn.unit ?? 'mm', scope, solved, pathById);
    return dx === null || dy === null ? null : { x: a.x + dx, y: a.y + dy };
  }
  if (cn.type === 'lengthAngle') {
    const a = solved.get(cn.from); if (!a) return null;
    const len = evalLen(cn.lengthFormula, cn.lengthUnit ?? 'mm', scope, solved, pathById);
    const ang = evalAngleDeg(cn.angleFormula, cn.angleUnit ?? 'degrees', scope, solved, pathById);
    if (len === null || ang === null) return null;
    const r = (ang * Math.PI) / 180;
    return { x: a.x + len * Math.cos(r), y: a.y + len * Math.sin(r) };
  }
  // sliding: a distance (from an anchor) along a path's polyline
  const path = pathById.get(cn.path); if (!path) return null;
  const anchors = path.pathPoints.map((pp) => solved.get(pp.id));
  if (anchors.some((a) => !a)) return null;
  const dist = evalLen(cn.positionFormula, cn.unit ?? 'mm', scope, solved, pathById);
  if (dist === null) return null;
  let base = 0;
  if (cn.from) {
    let cum = 0;
    for (let i = 1; i < path.pathPoints.length; i++) {
      if (path.pathPoints[i - 1].id === cn.from) { base = cum; break; }
      cum += Math.hypot((anchors[i]! as Pt).x - (anchors[i - 1]! as Pt).x, (anchors[i]! as Pt).y - (anchors[i - 1]! as Pt).y);
    }
  }
  return pointAlong(anchors as Pt[], base + dist);
}

/** Solve every point's position given a variable scope. Fixed points keep x/y; constrained points compute. */
export function solvePoints(pattern: Pattern, scope: Scope): Map<string, Pt> {
  const out = new Map<string, Pt>();
  for (const p of pattern.points) if (!p.constraint) out.set(p.id, { x: p.x, y: p.y });
  const pathById = new Map(pattern.paths.map((pa) => [pa.id, pa]));

  let changed = true;
  let guard = pattern.points.length + 6;
  while (changed && guard-- > 0) {
    changed = false;
    for (const p of pattern.points) {
      if (out.has(p.id) || !p.constraint) continue;
      const pos = constraintPos(p.constraint, scope, out, pathById);
      if (pos) { out.set(p.id, pos); changed = true; }
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

type Constraint = NonNullable<ConstrainablePoint['constraint']>;

/**
 * Recover parametric constructions from a template whose points are baked. The original app stores
 * construction on PATHS — a line/curve path with `basePoint` + length/angle formulas positions its
 * other endpoint by polar; a path's `slidingPoints` position points along it; formulas may reference
 * `OtherPath.length` and variables (by id), in cm/inch/etc. The construction *order* is lost, so we
 * disambiguate each point's constructor by which candidate reproduces its baked position (within tol),
 * resolving path-length references iteratively. Recovered points get a constraint (units preserved) so
 * they re-draft from variables. Never moves geometry at base values — only enables parametric editing.
 */
export function makeParametric(pattern: Pattern, tolMm = 1): Pattern {
  if (!pattern.points?.length || !pattern.paths?.length) return pattern;
  if (pattern.points.some((p) => p.constraint)) return pattern; // already parametric / authored
  const scope = resolveVariables(pattern);
  const baked = new Map(pattern.points.map((p) => [p.id, { x: p.x, y: p.y }]));
  const pathById = new Map(pattern.paths.map((pa) => [pa.id, pa]));

  // candidate constructions per point (length+angle from line/curve paths; sliding from slidingPoints)
  const cand = new Map<string, Constraint[]>();
  const add = (pid: string, c: Constraint) => { if (baked.has(pid)) (cand.get(pid) ?? cand.set(pid, []).get(pid)!).push(c); };
  for (const pa of pattern.paths) {
    if ((pa.pathType === 'line' || pa.pathType === 'curve') && pa.basePoint && pa.pathPoints.length === 2 && pa.lengthFormula?.formula) {
      const other = pa.pathPoints.find((q) => q.id !== pa.basePoint);
      if (other) add(other.id, { type: 'lengthAngle', from: pa.basePoint, lengthFormula: pa.lengthFormula.formula, angleFormula: pa.angleFormula?.formula ?? '0', lengthUnit: pa.lengthFormula.unit, angleUnit: pa.angleFormula?.unit ?? 'degrees' });
    }
    for (const sp of pa.slidingPoints ?? []) {
      if (sp.positionFormula?.formula) add(sp.id, { type: 'sliding', path: pa.id, from: sp.positionFrom, positionFormula: sp.positionFormula.formula, unit: sp.positionFormula.unit });
    }
  }
  if (cand.size === 0) return pattern;

  // iterative disambiguation: solve points whose deps are ready, choosing the candidate matching baked
  const sol = new Map<string, Pt>();
  const chosen = new Map<string, Constraint>();
  for (const p of pattern.points) if (!cand.has(p.id)) sol.set(p.id, baked.get(p.id)!);

  let changed = true, guard = pattern.points.length + 8;
  while (changed && guard-- > 0) {
    changed = false;
    for (const [pid, cands] of cand) {
      if (sol.has(pid)) continue;
      let best: Pt | null = null, bestErr = tolMm, bestC: Constraint | null = null;
      for (const c of cands) {
        const pos = constraintPos(c, scope, sol, pathById);
        if (!pos) continue;
        const err = Math.hypot(pos.x - baked.get(pid)!.x, pos.y - baked.get(pid)!.y);
        if (err < bestErr) { bestErr = err; best = pos; bestC = c; }
      }
      if (best && bestC) { sol.set(pid, best); chosen.set(pid, bestC); changed = true; }
    }
  }
  if (chosen.size === 0) return pattern;

  const points = pattern.points.map((p) => (chosen.has(p.id) ? { ...p, constraint: chosen.get(p.id) } : p));
  return { ...pattern, points };
}
