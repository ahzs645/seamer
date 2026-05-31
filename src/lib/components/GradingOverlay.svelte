<script lang="ts">
  import { onMount } from 'svelte';
  import type { Pattern } from '$lib/types/pattern';
  import {
    indexPaths, indexPoints, pieceWorldOutline, pieceWorldInternalPolylines,
    pathPolyline, type Vec2
  } from '$lib/utils/patternGeometry';

  let { currentPattern, onclose }: { currentPattern: Pattern; onclose: () => void } = $props();

  let tab = $state<'table' | 'overlay'>('overlay');
  let showDraft = $state(false);
  let showPieces = $state(true);
  let alignByOrigin = $state(false);
  let canvasEl = $state<HTMLCanvasElement>();
  let ctx: CanvasRenderingContext2D | null = null;

  // size layers = base (scale 1) + the pattern's graded sizes
  const sizeLayers = $derived([
    { id: 'base', name: currentPattern.currentSize || 'Base', scale: 1, color: '#334155' },
    ...(currentPattern.gradingProfile?.sizes ?? [])
  ]);

  function pieceOrigin(piece: Pattern['pieces'][number]): Vec2 {
    return { x: piece.position.x, y: piece.position.y };
  }

  function draw() {
    if (!ctx || !canvasEl) return;
    const c = ctx;
    const W = canvasEl.width, H = canvasEl.height;
    c.clearRect(0, 0, W, H);
    c.fillStyle = '#ffffff'; c.fillRect(0, 0, W, H);

    const paths = indexPaths(currentPattern);
    const points = indexPoints(currentPattern);

    // per-piece base geometry + its origin (grading scales about the origin)
    type Shape = { outline: Vec2[]; internals: Vec2[][]; origin: Vec2 };
    const shapes: Shape[] = [];
    for (const piece of currentPattern.pieces) {
      const outline = pieceWorldOutline(currentPattern, piece, paths, points, 3);
      const internals = pieceWorldInternalPolylines(currentPattern, piece, paths, points, 3);
      if (outline.length >= 2) shapes.push({ outline, internals, origin: pieceOrigin(piece) });
    }
    const draftPolys = showDraft ? currentPattern.paths.map((p) => pathPolyline(p, points, 3)) : [];

    // graded transform for a piece at a given size: scale about origin, optionally re-centre on it
    const grade = (p: Vec2, origin: Vec2, scale: number): Vec2 => {
      const x = origin.x + (p.x - origin.x) * scale;
      const y = origin.y + (p.y - origin.y) * scale;
      return alignByOrigin ? { x: x - origin.x, y: y - origin.y } : { x, y };
    };

    // fit everything (all sizes) to the canvas
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const acc = (p: Vec2) => { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); };
    if (showPieces) for (const sh of shapes) for (const sz of sizeLayers) for (const p of sh.outline) acc(grade(p, sh.origin, sz.scale));
    for (const poly of draftPolys) poly.forEach(acc);
    if (!isFinite(minX)) { minX = minY = 0; maxX = maxY = 100; }
    const pad = 30;
    const s = Math.min((W - pad * 2) / Math.max(1, maxX - minX), (H - pad * 2) / Math.max(1, maxY - minY));
    const ox = (W - (maxX - minX) * s) / 2, oy = (H - (maxY - minY) * s) / 2;
    const T = (p: Vec2) => ({ x: ox + (p.x - minX) * s, y: H - (oy + (p.y - minY) * s) }); // flip y

    const trace = (poly: Vec2[], close: boolean, map: (p: Vec2) => Vec2 = (p) => p) => {
      if (poly.length < 2) return;
      c.beginPath(); const a = T(map(poly[0])); c.moveTo(a.x, a.y);
      for (let i = 1; i < poly.length; i++) { const q = T(map(poly[i])); c.lineTo(q.x, q.y); }
      if (close) c.closePath();
    };

    if (showDraft) {
      c.strokeStyle = 'rgba(100,116,139,0.5)'; c.lineWidth = 1; c.setLineDash([4, 3]);
      for (const poly of draftPolys) { trace(poly, false); c.stroke(); }
      c.setLineDash([]);
    }
    if (showPieces) {
      for (const sz of sizeLayers) {
        c.strokeStyle = sz.color; c.lineWidth = sz.id === 'base' ? 1.75 : 1.25;
        for (const sh of shapes) {
          trace(sh.outline, true, (p) => grade(p, sh.origin, sz.scale)); c.stroke();
          c.save(); c.strokeStyle = sz.color + '88'; c.setLineDash([4, 3]);
          for (const ip of sh.internals) { trace(ip, false, (p) => grade(p, sh.origin, sz.scale)); c.stroke(); }
          c.restore();
        }
      }
    }
  }

  function resize() {
    if (!canvasEl) return;
    const r = canvasEl.parentElement!.getBoundingClientRect();
    canvasEl.width = Math.max(1, Math.floor(r.width));
    canvasEl.height = Math.max(1, Math.floor(r.height));
    draw();
  }

  onMount(() => {
    if (!canvasEl) return;
    ctx = canvasEl.getContext('2d');
    resize();
    const ro = new ResizeObserver(resize);
    if (canvasEl.parentElement) ro.observe(canvasEl.parentElement);
    return () => ro.disconnect();
  });

  $effect(() => { void [tab, showDraft, showPieces, alignByOrigin, currentPattern]; if (tab === 'overlay') draw(); });
</script>

<div class="fixed inset-0 z-[115] flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
  <div class="bg-base-100 rounded-lg shadow-xl w-[min(900px,95vw)] h-[min(640px,90vh)] flex flex-col p-4">
    <div class="flex items-center mb-2">
      <h3 class="font-bold">Sizes &amp; grading</h3>
      <button class="ml-auto btn btn-sm btn-ghost btn-circle" aria-label="Close" onclick={onclose}><span class="material-symbols-rounded">close</span></button>
    </div>

    <div class="bg-base-200 flex items-center w-full">
      <button class="px-5 py-2 text-sm" class:bg-base-300={tab === 'table'} class:font-bold={tab === 'table'} class:rounded-t-lg={tab === 'table'} onclick={() => (tab = 'table')}>Table</button>
      <button class="px-5 py-2 text-sm" class:bg-base-300={tab === 'overlay'} class:font-bold={tab === 'overlay'} class:rounded-t-lg={tab === 'overlay'} onclick={() => (tab = 'overlay')}>Overlay</button>
    </div>

    <div class="w-full min-h-0 grow pt-3">
      {#if tab === 'overlay'}
        <div class="flex h-full min-h-0 flex-col gap-3">
          <div class="flex flex-wrap items-center gap-4">
            <label class="label cursor-pointer gap-2 py-0"><input type="checkbox" class="checkbox checkbox-sm" bind:checked={showDraft} /> <span class="label-text">Show draft</span></label>
            <label class="label cursor-pointer gap-2 py-0"><input type="checkbox" class="checkbox checkbox-sm" bind:checked={showPieces} /> <span class="label-text">Show pieces</span></label>
            <label class="label cursor-pointer gap-2 py-0"><input type="checkbox" class="checkbox checkbox-sm" bind:checked={alignByOrigin} /> <span class="label-text">Align pieces by origin</span></label>
            <button class="btn btn-xs" onclick={resize}>Reset view</button>
          </div>
          <div class="relative grow min-h-[20rem] overflow-hidden rounded border border-base-300 bg-base-100">
            <canvas bind:this={canvasEl} class="absolute inset-0 h-full w-full"></canvas>
          </div>
          <div class="flex flex-wrap gap-2">
            {#each sizeLayers as sz}
              <div class="badge badge-outline gap-1 px-2 py-2 text-xs"><span class="inline-block h-2 w-2 rounded-full" style="background-color:{sz.color}"></span> <span>{sz.name} {sz.scale !== 1 ? `(${sz.scale.toFixed(2)}×)` : ''}</span></div>
            {/each}
          </div>
        </div>
      {:else}
        <div class="h-full overflow-auto">
          <table class="table table-sm">
            <thead><tr><th>Variable</th><th>Type</th>{#each sizeLayers as sz}<th class="text-right">{sz.name}</th>{/each}</tr></thead>
            <tbody>
              {#each currentPattern.variables as v}
                <tr><td>{v.name || 'unnamed'}</td><td class="opacity-60">{v.type}</td>
                  {#each sizeLayers as sz}<td class="text-right tabular-nums">{v.value == null ? '—' : (v.value * sz.scale).toFixed(2)}</td>{/each}
                </tr>
              {:else}
                <tr><td colspan={2 + sizeLayers.length} class="opacity-60">No variables. Add variables in Properties → Sizes &amp; Variables.</td></tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </div>
  </div>
</div>
