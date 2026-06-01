<script lang="ts">
  // Bottom status bar: live cursor position (mm), current tool, selection counts and a saved/unsaved
  // indicator — mirroring the original studio's readout strip.
  import { cursorMm, selectedTool, selectedPointIds, selectedPathIds, selectedPieceIds } from '$lib/stores/pattern';
  import type { Pattern } from '$lib/types/pattern';

  let { currentPattern, saved }: { currentPattern: Pattern; saved: boolean } = $props();

  const selCount = $derived($selectedPointIds.size + $selectedPathIds.size + $selectedPieceIds.size);
  const unit = $derived(currentPattern.lengthUnit ?? 'mm');
  const toUnit = (mm: number) => (unit === 'cm' ? mm / 10 : unit === 'inch' ? mm / 25.4 : mm);
</script>

<div class="h-6 px-3 flex items-center gap-4 text-[11px] bg-base-300 border-t border-base-200 text-base-content/70 shrink-0 select-none">
  <span class="font-mono w-40">
    {#if $cursorMm}
      x {toUnit($cursorMm.x).toFixed(unit === 'inch' ? 2 : 1)} · y {toUnit($cursorMm.y).toFixed(unit === 'inch' ? 2 : 1)} {unit}
    {:else}
      —
    {/if}
  </span>
  <span>tool: <b class="text-base-content/90">{$selectedTool}</b></span>
  <span>selection: <b class="text-base-content/90">{selCount}</b></span>
  <span class="ml-auto flex items-center gap-1">
    <span class="w-2 h-2 rounded-full {saved ? 'bg-success' : 'bg-warning'}"></span>
    {saved ? 'Saved' : 'Unsaved changes'}
  </span>
</div>
