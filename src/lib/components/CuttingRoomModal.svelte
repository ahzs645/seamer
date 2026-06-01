<script lang="ts">
  // Cutting Room — nest pieces onto fabric, preview the marker, track which pieces have been cut,
  // then export/print. Offers the fast shelf packer and a true-shape genetic nester with rotations
  // (a faithful-in-spirit port of the original studio's cutting room). Settings + cut state persist
  // in pattern.markerSettings.
  import type { Pattern } from '$lib/types/pattern';
  import {
    nestPieces, nestPiecesTrueShape, markerToSVG, type MarkerLayout, type CutOffType
  } from '$lib/utils/markerLayout';
  import { printMarkerTiled } from '$lib/utils/exporters';
  import { downloadText } from '$lib/utils/exporters';
  import { toastSuccess, toastError } from '$lib/stores/toast';

  let { currentPattern, onchange, onclose }:
    { currentPattern: Pattern; onchange: (p: Pattern, label?: string) => void; onclose: () => void } = $props();

  interface MarkerSettings {
    algorithm: 'fast' | 'trueShape';
    fabricWidthMm: number;
    gapMm: number;
    allowedRotations: number[];
    generations: number;
    cutOff: CutOffType;
    cutIds: string[];
  }
  // svelte-ignore state_referenced_locally -- intentional one-time read of persisted settings on open
  const saved = (currentPattern.markerSettings ?? null) as Partial<MarkerSettings> | null;

  let algorithm = $state<MarkerSettings['algorithm']>(saved?.algorithm ?? 'trueShape');
  let fabricWidthMm = $state(saved?.fabricWidthMm ?? 1400);
  let gapMm = $state(saved?.gapMm ?? 10);
  let rotationMode = $state(rotationsToMode(saved?.allowedRotations));
  let generations = $state(saved?.generations ?? 12);
  let cutOff = $state<CutOffType>(saved?.cutOff ?? 'none');
  let cutIds = $state<Set<string>>(new Set(saved?.cutIds ?? []));

  let layout = $state<MarkerLayout | null>(null);
  let busy = $state(false);

  function rotationsToMode(r?: number[]): '0' | '0,180' | '4way' | 'free' {
    if (!r || r.length <= 1) return '0';
    if (r.length === 2) return '0,180';
    if (r.length === 4) return '4way';
    return 'free';
  }
  function modeToRotations(): number[] {
    switch (rotationMode) {
      case '0': return [0];
      case '0,180': return [0, 180];
      case '4way': return [0, 90, 180, 270];
      case 'free': return [0, 45, 90, 135, 180, 225, 270, 315];
    }
  }

  function persist() {
    const settings: MarkerSettings = { algorithm, fabricWidthMm, gapMm, allowedRotations: modeToRotations(), generations, cutOff, cutIds: [...cutIds] };
    onchange({ ...currentPattern, markerSettings: settings, hasChanged: true }, 'Cutting room settings');
  }

  async function nest() {
    busy = true;
    // yield so the spinner paints before a (possibly heavy) GA run
    await new Promise((r) => setTimeout(r, 10));
    try {
      layout = algorithm === 'fast'
        ? nestPieces(currentPattern, fabricWidthMm, gapMm)
        : nestPiecesTrueShape(currentPattern, { fabricWidthMm, gapMm, allowedRotations: modeToRotations(), generations });
      if (!layout.placements.length) toastError('No pieces to nest');
      else persist();
    } finally {
      busy = false;
    }
  }

  const svg = $derived(layout ? markerToSVG(layout, cutOff, cutIds) : '');
  const uncut = $derived(layout ? layout.placements.filter((p) => !cutIds.has(p.instanceId ?? '')).length : 0);

  function toggleCut(id: string) {
    const next = new Set(cutIds);
    next.has(id) ? next.delete(id) : next.add(id);
    cutIds = next;
    persist();
  }
  function markAllCut() { if (!layout) return; cutIds = new Set(layout.placements.map((p) => p.instanceId ?? '')); persist(); }
  function resetCut() { cutIds = new Set(); persist(); }

  function exportSVG() {
    if (!layout) return;
    const base = (currentPattern.name || 'pattern').replace(/\s+/g, '_');
    downloadText(`${base}_marker.svg`, markerToSVG(layout, cutOff, cutIds), 'image/svg+xml');
    toastSuccess('Marker exported');
  }
  function print() {
    if (!layout) return;
    printMarkerTiled(layout, { title: (currentPattern.name || 'Pattern') + ' — marker' });
  }

  // initial nest on open
  $effect(() => { if (!layout) nest(); });
</script>

<div
  class="fixed inset-0 z-[200] flex items-center justify-center bg-black/40 p-4"
  role="button" tabindex="-1"
  onclick={(e) => { if (e.target === e.currentTarget) onclose(); }}
  onkeydown={(e) => e.key === 'Escape' && onclose()}
>
  <div class="bg-base-100 w-[min(1000px,96vw)] h-[min(700px,92vh)] rounded-lg shadow-2xl flex flex-col overflow-hidden" role="dialog" aria-label="Cutting room">
    <div class="flex items-center justify-between px-4 py-2 border-b border-base-300">
      <h2 class="font-bold text-lg flex items-center gap-2"><span class="material-symbols-rounded">content_cut</span> Cutting Room</h2>
      <button class="btn btn-ghost btn-sm btn-square" onclick={onclose} aria-label="Close">✕</button>
    </div>

    <div class="flex flex-1 overflow-hidden">
      <!-- controls -->
      <div class="w-64 border-r border-base-300 p-3 overflow-y-auto text-sm space-y-3 shrink-0">
        <label class="flex flex-col gap-1">Algorithm
          <select class="select select-bordered select-sm" bind:value={algorithm}>
            <option value="fast">Fast (bounding box)</option>
            <option value="trueShape">True shape (rotations + GA)</option>
          </select>
        </label>
        <label class="flex flex-col gap-1">Fabric width (mm)
          <input type="number" min="100" step="10" class="input input-bordered input-sm" bind:value={fabricWidthMm} /></label>
        <label class="flex flex-col gap-1">Gap (mm)
          <input type="number" min="0" step="1" class="input input-bordered input-sm" bind:value={gapMm} /></label>
        {#if algorithm === 'trueShape'}
          <label class="flex flex-col gap-1">Allowed rotations
            <select class="select select-bordered select-sm" bind:value={rotationMode}>
              <option value="0">None (0°)</option>
              <option value="0,180">Flip (0°, 180°)</option>
              <option value="4way">Quarter (0/90/180/270°)</option>
              <option value="free">Free (8 angles)</option>
            </select>
          </label>
          <label class="flex flex-col gap-1">Search effort (generations): {generations}
            <input type="range" min="0" max="40" step="1" class="range range-xs" bind:value={generations} /></label>
        {/if}
        <label class="flex flex-col gap-1">Cut-off boundary
          <select class="select select-bordered select-sm" bind:value={cutOff}>
            <option value="none">None</option>
            <option value="boundingBox">Bounding box</option>
            <option value="convexHull">Convex hull</option>
            <option value="concaveHull">Concave hull</option>
          </select>
        </label>
        <button class="btn btn-primary btn-sm w-full" onclick={nest} disabled={busy}>
          {#if busy}<span class="loading loading-spinner loading-xs"></span> Nesting…{:else}Nest pieces{/if}
        </button>

        {#if layout}
          <div class="border-t border-base-300 pt-2 text-xs space-y-1">
            <div>Pieces: <b>{layout.placements.length}</b> ({uncut} uncut)</div>
            <div>Length: <b>{Math.round(layout.usedLengthMm)}</b> mm</div>
            {#if layout.efficiency !== undefined}<div>Efficiency: <b>{(layout.efficiency * 100).toFixed(1)}%</b></div>{/if}
          </div>
          <div class="flex gap-1">
            <button class="btn btn-ghost btn-xs flex-1" onclick={markAllCut}>Mark all cut</button>
            <button class="btn btn-ghost btn-xs flex-1" onclick={resetCut}>Reset</button>
          </div>
          <div class="flex gap-1">
            <button class="btn btn-ghost btn-xs flex-1" onclick={exportSVG}>Export SVG</button>
            <button class="btn btn-ghost btn-xs flex-1" onclick={print}>Print…</button>
          </div>
        {/if}
      </div>

      <!-- preview -->
      <div class="flex-1 flex flex-col overflow-hidden">
        <div class="flex-1 overflow-auto bg-base-200 p-3 flex items-start justify-center">
          {#if svg}
            <!-- eslint-disable-next-line svelte/no-at-html-tags -->
            <div class="bg-white shadow max-w-full [&_svg]:max-w-full [&_svg]:h-auto">{@html svg}</div>
          {:else}
            <div class="text-base-content/50 text-sm mt-12">No layout yet.</div>
          {/if}
        </div>
        {#if layout && layout.placements.length}
          <div class="h-28 border-t border-base-300 overflow-y-auto p-2">
            <div class="grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs">
              {#each layout.placements as pl (pl.instanceId)}
                <label class="flex items-center gap-1 truncate">
                  <input type="checkbox" class="checkbox checkbox-xs" checked={cutIds.has(pl.instanceId ?? '')} onchange={() => toggleCut(pl.instanceId ?? '')} />
                  <span class="truncate" class:line-through={cutIds.has(pl.instanceId ?? '')} class:opacity-50={cutIds.has(pl.instanceId ?? '')}>{pl.name}{pl.rotationDeg ? ` · ${pl.rotationDeg}°` : ''}</span>
                </label>
              {/each}
            </div>
          </div>
        {/if}
      </div>
    </div>
  </div>
</div>
