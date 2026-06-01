<script lang="ts">
  import type { Pattern, Seam } from '$lib/types/pattern';
  import { indexPiecePathOwners, seamLabel } from '$lib/utils/patternGeometry';

  interface Props {
    currentPattern: Pattern;
    onchange: (p: Pattern) => void;
  }

  let { currentPattern, onchange }: Props = $props();
  let fromId = $state('');
  let toId = $state('');
  let fromMirror = $state(false);
  let toMirror = $state(false);

  // Flattened list of every piece edge (PiecePath) with a readable label.
  interface EdgeOption { id: string; label: string }
  const edges = $derived.by<EdgeOption[]>(() => {
    const out: EdgeOption[] = [];
    const pathName = (id: string) => currentPattern.paths.find((p) => p.id === id)?.name ?? id.slice(0, 6);
    for (const piece of currentPattern.pieces) {
      for (const pp of piece.mainPaths) {
        out.push({ id: pp.id, label: `${piece.name} · ${pp.name || pathName(pp.path)}` });
      }
    }
    return out;
  });

  const edgeLabel = $derived.by(() => {
    const m = new Map<string, string>();
    for (const e of edges) m.set(e.id, e.label);
    return (id: string) => m.get(id) ?? id.slice(0, 8);
  });

  // Faithful "Piece: Edge -> Piece: Edge (reversed)" label, shared with the Object browser.
  const owners = $derived(indexPiecePathOwners(currentPattern));

  function addSeam() {
    if (!fromId || !toId || fromId === toId) return;
    const seam: Seam = {
      id: 'Seam_' + crypto.randomUUID().slice(0, 9),
      name: '',
      fromPaths: [{ id: fromId, mirrored: fromMirror, reversed: false }],
      toPaths: [{ id: toId, mirrored: toMirror, reversed: false }]
    };
    onchange({ ...currentPattern, seams: [...currentPattern.seams, seam], hasChanged: true });
    fromId = ''; toId = ''; fromMirror = false; toMirror = false;
  }

  function removeSeam(id: string) {
    onchange({ ...currentPattern, seams: currentPattern.seams.filter((s) => s.id !== id), hasChanged: true });
  }

  // Reverse a seam: swap which side is "from" and which is "to" (mirrors the original seam.reverse).
  function reverseSeam(id: string) {
    const seams = currentPattern.seams.map((s) => (s.id === id ? { ...s, fromPaths: s.toPaths, toPaths: s.fromPaths } : s));
    onchange({ ...currentPattern, seams, hasChanged: true });
  }
</script>

<div class="text-xs">
  <h3 class="font-bold mb-2">Seams</h3>

  <div class="space-y-1 mb-2 max-h-44 overflow-y-auto">
    {#each currentPattern.seams as seam (seam.id)}
      <div class="flex items-center gap-1 p-1 rounded bg-base-200">
        <span class="flex-1 truncate text-[11px]" title={seamLabel(currentPattern, seam, owners)}>
          {seamLabel(currentPattern, seam, owners)}
        </span>
        <button class="btn btn-xs btn-ghost px-0.5" title="Reverse seam direction" aria-label="Reverse seam" onclick={() => reverseSeam(seam.id)}>
          <span class="material-symbols-rounded text-sm align-middle">swap_horiz</span>
        </button>
        <button class="btn btn-xs btn-ghost px-0.5 text-error" onclick={() => removeSeam(seam.id)}>&times;</button>
      </div>
    {/each}
    {#if currentPattern.seams.length === 0}
      <p class="text-xs opacity-50 my-1">No seams defined.</p>
    {/if}
  </div>

  {#if edges.length >= 2}
    <div class="bg-base-200 p-2 rounded space-y-1">
      <div class="flex gap-1 items-center">
        <select class="select select-bordered select-xs flex-1" bind:value={fromId}>
          <option value="">From edge…</option>
          {#each edges as e}<option value={e.id}>{e.label}</option>{/each}
        </select>
        <label class="flex items-center gap-0.5"><input type="checkbox" class="checkbox checkbox-xs" bind:checked={fromMirror} />M</label>
      </div>
      <div class="flex gap-1 items-center">
        <select class="select select-bordered select-xs flex-1" bind:value={toId}>
          <option value="">To edge…</option>
          {#each edges as e}<option value={e.id} disabled={e.id === fromId}>{e.label}</option>{/each}
        </select>
        <label class="flex items-center gap-0.5"><input type="checkbox" class="checkbox checkbox-xs" bind:checked={toMirror} />M</label>
      </div>
      <button class="btn btn-xs btn-ghost w-full" onclick={addSeam} disabled={!fromId || !toId}>Add Seam</button>
    </div>
  {:else}
    <p class="text-xs opacity-50">Need at least 2 piece edges to create a seam.</p>
  {/if}
</div>
