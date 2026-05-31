<script lang="ts">
  import type { Pattern, Material, TextureSlot } from '$lib/types/pattern';

  interface Props {
    currentPattern: Pattern;
    onchange: (p: Pattern) => void;
  }

  let { currentPattern, onchange }: Props = $props();
  let editingId: string | null = $state(null);

  function defaultSlot(color: string): TextureSlot {
    return {
      url: '', mediaId: null, color, scale: 100,
      normalUrl: '', normalMediaId: null, normalMapScale: 100,
      opacityUrl: '', opacityMediaId: null, opacityMapScale: 100
    };
  }

  function swatch(mat: Material): string {
    return mat.frontTexture?.color ?? '#7c8aa0';
  }

  function addMaterial() {
    const id = crypto.randomUUID();
    const mat: Material = {
      id,
      name: 'New Fabric',
      frontTexture: defaultSlot('#6b7a8f'),
      backTexture: defaultSlot('#6b7a8f'),
      useSeparateBackSide: false,
      stretchWarpValue: 10,
      stretchWeftValue: 10,
      bendValue: 0,
      thickness: 0.5,
      weight: 150,
      roughness: 0.8,
      metalness: 0.1,
      specularIntensity: 0.25,
      opacity: 1,
      normalScale: 1,
      alphaCutoff: 0,
      libraryItemId: null,
      libraryVersion: null,
      libraryUpdatedAt: null
    };
    onchange({ ...currentPattern, materials: [...currentPattern.materials, mat], hasChanged: true });
    editingId = id;
  }

  function removeMaterial(id: string) {
    onchange({ ...currentPattern, materials: currentPattern.materials.filter((m) => m.id !== id), hasChanged: true });
  }

  function patch(id: string, fn: (m: Material) => Material) {
    const materials = currentPattern.materials.map((m) => (m.id === id ? fn(m) : m));
    onchange({ ...currentPattern, materials, hasChanged: true });
  }

  function setColor(id: string, color: string) {
    patch(id, (m) => ({
      ...m,
      frontTexture: { ...(m.frontTexture ?? defaultSlot(color)), color },
      backTexture: m.useSeparateBackSide ? m.backTexture : { ...(m.backTexture ?? defaultSlot(color)), color }
    }));
  }
</script>

<div class="text-xs">
  <h3 class="font-bold mb-2">Fabric</h3>

  <div class="space-y-1 mb-2 max-h-72 overflow-y-auto">
    {#each currentPattern.materials as mat (mat.id)}
      {#if editingId === mat.id}
        <div class="bg-base-200 p-2 rounded space-y-1">
          <input type="text" class="input input-bordered input-xs w-full" value={mat.name}
            oninput={(e) => patch(mat.id, (m) => ({ ...m, name: e.currentTarget.value }))} />
          <label class="flex items-center gap-1">Color
            <input type="color" class="flex-1 h-6" value={swatch(mat)} oninput={(e) => setColor(mat.id, e.currentTarget.value)} />
          </label>
          <div class="grid grid-cols-2 gap-1">
            <label>Stretch warp
              <input type="number" min="0" max="100" class="input input-bordered input-xs w-full" value={mat.stretchWarpValue}
                oninput={(e) => patch(mat.id, (m) => ({ ...m, stretchWarpValue: +e.currentTarget.value }))} /></label>
            <label>Stretch weft
              <input type="number" min="0" max="100" class="input input-bordered input-xs w-full" value={mat.stretchWeftValue}
                oninput={(e) => patch(mat.id, (m) => ({ ...m, stretchWeftValue: +e.currentTarget.value }))} /></label>
            <label>Bend
              <input type="number" min="0" max="100" class="input input-bordered input-xs w-full" value={mat.bendValue}
                oninput={(e) => patch(mat.id, (m) => ({ ...m, bendValue: +e.currentTarget.value }))} /></label>
            <label>Thickness (mm)
              <input type="number" step="0.1" class="input input-bordered input-xs w-full" value={mat.thickness}
                oninput={(e) => patch(mat.id, (m) => ({ ...m, thickness: +e.currentTarget.value }))} /></label>
            <label class="col-span-2">Weight (g/m²)
              <input type="number" class="input input-bordered input-xs w-full" value={mat.weight}
                oninput={(e) => patch(mat.id, (m) => ({ ...m, weight: +e.currentTarget.value }))} /></label>
          </div>
          <button class="btn btn-xs btn-ghost w-full" onclick={() => (editingId = null)}>Done</button>
        </div>
      {:else}
        <div role="button" tabindex="0" class="flex items-center gap-1 p-1 rounded hover:bg-base-200 cursor-pointer w-full text-left"
          ondblclick={() => (editingId = mat.id)}
          onkeydown={(e: KeyboardEvent) => { if (e.key === 'Enter') editingId = mat.id; }}>
          <span class="w-3 h-3 rounded-full inline-block border" style="background: {swatch(mat)}"></span>
          <span class="flex-1 truncate">{mat.name}</span>
          <span class="text-xs opacity-50">↔{mat.stretchWarpValue}/{mat.stretchWeftValue}</span>
          <button class="btn btn-xs btn-ghost px-1" onclick={(e: MouseEvent) => { e.stopPropagation(); editingId = mat.id; }}>✎</button>
          <button class="btn btn-xs btn-ghost px-0.5 text-error" onclick={(e: MouseEvent) => { e.stopPropagation(); removeMaterial(mat.id); }}>&times;</button>
        </div>
      {/if}
    {/each}
    {#if currentPattern.materials.length === 0}
      <p class="text-xs opacity-50 my-1">No fabrics defined.</p>
    {/if}
  </div>

  <button class="btn btn-xs btn-ghost w-full" onclick={addMaterial}>+ Add Fabric</button>
</div>
