<script lang="ts">
  import type { Pattern, Layer } from '$lib/types/pattern';

  interface Props {
    currentPattern: Pattern;
    onchange: (p: Pattern) => void;
  }

  let { currentPattern, onchange }: Props = $props();
  let newLayerName = $state('');

  function toggleVisibility(layerId: string) {
    const layers = currentPattern.layers.map(l =>
      l.id === layerId ? { ...l, visible: !l.visible } : l
    );
    onchange({ ...currentPattern, layers, hasChanged: true });
  }

  function toggleLock(layerId: string) {
    const layers = currentPattern.layers.map(l =>
      l.id === layerId ? { ...l, locked: !l.locked } : l
    );
    onchange({ ...currentPattern, layers, hasChanged: true });
  }

  function selectLayer(layerId: string) {
    onchange({ ...currentPattern, currentLayerId: layerId, hasChanged: true });
  }

  function addLayer() {
    if (!newLayerName.trim()) return;
    const id = 'layer_' + crypto.randomUUID().slice(0, 9);
    const newLayer: Layer = {
      id,
      name: newLayerName.trim(),
      visible: true,
      locked: false,
      order: currentPattern.layers.length,
      style: {}
    };
    onchange({
      ...currentPattern,
      layers: [...currentPattern.layers, newLayer],
      currentLayerId: id,
      hasChanged: true
    });
    newLayerName = '';
  }

  function deleteLayer(layerId: string) {
    if (currentPattern.layers.length <= 1) return;
    const layers = currentPattern.layers.filter(l => l.id !== layerId);
    const newCurrentId = currentPattern.currentLayerId === layerId
      ? layers[0]?.id || 'default'
      : currentPattern.currentLayerId;
    onchange({ ...currentPattern, layers, currentLayerId: newCurrentId, hasChanged: true });
  }
</script>

<div class="text-xs">
  <h3 class="font-bold mb-2">Layers</h3>

  <div class="space-y-1 mb-2">
    {#each currentPattern.layers as layer (layer.id)}
      <div
        role="button"
        tabindex="0"
        class="flex items-center gap-1 p-1 rounded cursor-pointer w-full text-left {currentPattern.currentLayerId === layer.id ? 'bg-base-300' : 'hover:bg-base-200'}"
        onclick={() => selectLayer(layer.id)}
        onkeydown={(e: KeyboardEvent) => { if (e.key === 'Enter') selectLayer(layer.id); }}
      >
        <button
          class="btn btn-xs btn-ghost px-1"
          class:text-opacity-30={!layer.visible}
          onclick={(e: MouseEvent) => { e.stopPropagation(); toggleVisibility(layer.id); }}
        >
          {layer.visible ? '👁' : '🚫'}
        </button>
        <span class="flex-1 truncate">{layer.name}</span>
        <button
          class="btn btn-xs btn-ghost px-1"
          class:text-error={layer.locked}
          onclick={(e: MouseEvent) => { e.stopPropagation(); toggleLock(layer.id); }}
        >
          {layer.locked ? '🔒' : '🔓'}
        </button>
        {#if currentPattern.layers.length > 1}
          <button class="btn btn-xs btn-ghost px-1 text-error" onclick={(e: MouseEvent) => { e.stopPropagation(); deleteLayer(layer.id); }}>✕</button>
        {/if}
      </div>
    {/each}
  </div>

  <div class="flex gap-1">
    <input
      type="text"
      class="input input-bordered input-xs flex-1"
      placeholder="New layer..."
      bind:value={newLayerName}
      onkeydown={(e) => e.key === 'Enter' && addLayer()}
    />
    <button class="btn btn-xs btn-ghost" onclick={addLayer}>+</button>
  </div>
</div>
