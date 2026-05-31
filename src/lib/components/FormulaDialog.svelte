<script lang="ts">
  import { untrack } from 'svelte';
  interface Var { name: string; value: number }
  let { formula = '', variables = [], onsave, oncancel }:
    { formula?: string; variables?: Var[]; onsave: (f: string, value: number | null) => void; oncancel: () => void } = $props();

  let text = $state(untrack(() => formula));
  let area: HTMLTextAreaElement | undefined = $state();

  // only valid JS identifiers can be referenced safely
  const usable = $derived(variables.filter((v) => /^[A-Za-z_$][\w$]*$/.test(v.name)));

  /** Evaluate the expression with the variables (and Math.*) in scope. Returns null on error. */
  function evalFormula(expr: string): number | null {
    if (!expr.trim()) return null;
    if (!/^[\w\s+\-*/().,%]*$/.test(expr)) return null; // reject anything but math + identifiers
    try {
      const names = usable.map((v) => v.name);
      const vals = usable.map((v) => v.value);
      // eslint-disable-next-line no-new-func
      const fn = new Function(...names, 'Math', `"use strict"; return (${expr});`);
      const r = fn(...vals, Math);
      return typeof r === 'number' && isFinite(r) ? r : null;
    } catch { return null; }
  }

  const result = $derived(evalFormula(text));

  function insert(token: string) {
    const el = area;
    if (!el) { text += token; return; }
    const s = el.selectionStart ?? text.length, e = el.selectionEnd ?? text.length;
    text = text.slice(0, s) + token + text.slice(e);
    queueMicrotask(() => { el.focus(); el.selectionStart = el.selectionEnd = s + token.length; });
  }
</script>

<div class="fixed inset-0 z-[120] flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
  <div class="bg-base-100 rounded-lg shadow-xl w-[min(560px,95vw)] p-5">
    <div class="flex items-center mb-3">
      <h3 class="font-bold flex items-center gap-2"><span class="material-symbols-rounded">function</span> Formula editor</h3>
      <button class="ml-auto btn btn-sm btn-ghost btn-circle" aria-label="Close" onclick={oncancel}><span class="material-symbols-rounded">close</span></button>
    </div>

    <textarea bind:this={area} bind:value={text} rows="3" class="textarea textarea-bordered w-full font-mono text-sm" placeholder="e.g. waist / 4 + 1.5"></textarea>

    <div class="mt-2 text-sm flex items-center gap-2">
      <span class="opacity-70">=</span>
      <span class="font-mono {result === null ? 'text-error' : 'text-success'}">{result === null ? (text.trim() ? 'invalid' : '—') : result.toFixed(3)}</span>
    </div>

    {#if usable.length}
      <div class="mt-3">
        <p class="text-xs opacity-60 mb-1">Insert a variable</p>
        <div class="flex flex-wrap gap-1">
          {#each usable as v}
            <button class="btn btn-xs" title={`${v.name} = ${v.value}`} onclick={() => insert(v.name)}>{v.name}</button>
          {/each}
        </div>
      </div>
    {/if}
    <div class="mt-2 flex flex-wrap gap-1">
      {#each ['+', '−', '×', '÷', '(', ')'] as op, i}
        <button class="btn btn-xs btn-ghost font-mono" onclick={() => insert(['+', '-', '*', '/', '(', ')'][i])}>{op}</button>
      {/each}
    </div>

    <div class="flex justify-end gap-2 mt-4">
      <button class="btn btn-sm btn-ghost" onclick={oncancel}>Cancel</button>
      <button class="btn btn-sm btn-primary" onclick={() => onsave(text, result)}>Apply</button>
    </div>
  </div>
</div>
