// Safe arithmetic expression evaluator used by the parametric solver and the formula editor.
// Supports numbers, + - * / % ( ), identifiers (resolved from `scope`), and Math.* helpers.

const SAFE = /^[\w\s+\-*/().,%]*$/;

/** Evaluate `expr` with the given numeric scope. Returns null on any error/non-finite result. */
export function evalExpr(expr: string, scope: Record<string, number>): number | null {
  // The source wraps variable/path refs in braces — `{var_id}+4`, `{Path_id.length}`. They carry no
  // arithmetic meaning, so drop them before evaluating (otherwise the SAFE check rejects the formula).
  const src = (expr ?? '').replace(/[{}]/g, '').trim();
  if (!src) return null;
  if (!SAFE.test(src)) return null;
  // only valid JS identifiers can be bound as function args
  const names = Object.keys(scope).filter((n) => /^[A-Za-z_$][\w$]*$/.test(n));
  const vals = names.map((n) => scope[n]);
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function(...names, 'Math', `"use strict"; return (${src});`);
    const r = fn(...vals, Math);
    return typeof r === 'number' && isFinite(r) ? r : null;
  } catch {
    return null;
  }
}

/** Identifiers referenced by an expression (best-effort, for dependency ordering). */
export function referencedNames(expr: string): string[] {
  if (!expr) return [];
  const out = new Set<string>();
  const re = /[A-Za-z_$][\w$]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(expr))) {
    const id = m[0];
    if (id !== 'Math') out.add(id);
  }
  return [...out];
}
