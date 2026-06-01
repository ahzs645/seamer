<script lang="ts">
  // Preferences — theme, grid/snap, interaction quality, autosave cadence and the 3D stats overlay.
  // The original buried these across menus; here they live in one panel. All bind to live stores /
  // utilities so changes take effect immediately and persist (localStorage / theme attribute).
  import { showGrid, snapToGrid, interactionMode, autoSaveSeconds, show3dStats } from '$lib/stores/pattern';
  import { isDarkTheme, toggleTheme } from '$lib/utils/theme';

  let { onclose }: { onclose: () => void } = $props();
  let dark = $state(isDarkTheme());

  function flipTheme() { toggleTheme(); dark = isDarkTheme(); }
</script>

<div
  class="fixed inset-0 z-[200] flex items-center justify-center bg-black/40"
  role="button" tabindex="-1"
  onclick={(e) => { if (e.target === e.currentTarget) onclose(); }}
  onkeydown={(e) => e.key === 'Escape' && onclose()}
>
  <div class="bg-base-100 w-[min(440px,92vw)] rounded-lg shadow-2xl p-4 space-y-3" role="dialog" aria-label="Settings">
    <div class="flex items-center justify-between">
      <h2 class="font-bold text-lg flex items-center gap-2"><span class="material-symbols-rounded">settings</span> Settings</h2>
      <button class="btn btn-ghost btn-sm btn-square" onclick={onclose} aria-label="Close">✕</button>
    </div>

    <div class="space-y-2 text-sm">
      <div class="flex items-center justify-between">
        <span>Theme</span>
        <button class="btn btn-sm btn-ghost gap-1" onclick={flipTheme}>
          <span class="material-symbols-rounded text-base">{dark ? 'dark_mode' : 'light_mode'}</span>{dark ? 'Dark' : 'Light'}
        </button>
      </div>

      <label class="flex items-center justify-between"><span>Show grid</span>
        <input type="checkbox" class="toggle toggle-sm" checked={$showGrid} onchange={(e) => showGrid.set(e.currentTarget.checked)} /></label>

      <label class="flex items-center justify-between"><span>Snap to grid</span>
        <input type="checkbox" class="toggle toggle-sm" checked={$snapToGrid} onchange={(e) => snapToGrid.set(e.currentTarget.checked)} /></label>

      <label class="flex items-center justify-between"><span>Interaction quality</span>
        <select class="select select-bordered select-sm" value={$interactionMode} onchange={(e) => interactionMode.set(e.currentTarget.value as 'fast' | 'accurate')}>
          <option value="fast">Fast</option><option value="accurate">Accurate</option>
        </select></label>

      <label class="flex items-center justify-between"><span>3D stats overlay (FPS)</span>
        <input type="checkbox" class="toggle toggle-sm" checked={$show3dStats} onchange={(e) => show3dStats.set(e.currentTarget.checked)} /></label>

      <label class="flex items-center justify-between gap-2"><span>Autosave every</span>
        <span class="flex items-center gap-1">
          <input type="number" min="2" max="120" step="1" class="input input-bordered input-sm w-20" value={$autoSaveSeconds}
            oninput={(e) => autoSaveSeconds.set(Math.max(2, Math.min(120, parseInt(e.currentTarget.value) || 5)))} />
          <span class="text-base-content/60">s</span>
        </span></label>
    </div>

    <p class="text-[11px] text-base-content/50">Preferences are saved on this device.</p>
  </div>
</div>
