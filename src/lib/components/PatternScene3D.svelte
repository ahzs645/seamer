<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import type { Pattern } from '$lib/types/pattern';
  import { PatternRenderer, type RendererStatus, type SceneMode } from '$lib/scene/scene3d';
  import { isDarkTheme, toggleTheme, applyStoredTheme } from '$lib/utils/theme';

  interface Props {
    currentPattern: Pattern;
    selectedPieceId?: string | null;
    onpieceselect?: (id: string | null) => void;
    labelDisplay?: 'off' | 'billboard' | 'flat';
    /** Fired when a user-run drape settles, with per-piece settled savedPositions to persist. */
    ondrapesettled?: (savedByPiece: Record<string, number[]>) => void;
  }

  let { currentPattern, selectedPieceId = null, onpieceselect, labelDisplay = 'flat', ondrapesettled }: Props = $props();

  let containerEl: HTMLDivElement;
  let renderer: PatternRenderer | null = null;
  let status = $state<RendererStatus>('idle');
  let statusMessage = $state('');
  let poses = $state<string[]>([]);
  let currentPose = $state('T');
  let webgpu = $state(true);
  let showTriangles = $state(false);
  let showAvatar = $state(true);
  let sceneMode = $state<SceneMode>('view');
  // Which piece-edit tool is active while sceneMode === 'arrange': the flat-layout "Arrange" tool, or
  // the in-place "Move pieces" tool that drags the draped pieces and eases them back on Drape.
  let arrangeKind = $state<'arrange' | 'manipulate' | null>(null);
  let selectedPiece = $state<string | null>(null);
  let gizmoMode = $state<'translate' | 'rotate'>('translate');
  let lightingMode = $state<string>('flat');
  let dark = $state(false);
  const lightingTabs = [
    { id: 'flat', label: 'Flat' },
    { id: 'studio1', label: 'Studio 1' },
    { id: 'studio2', label: 'Studio 2' },
    { id: 'sunset', label: 'Sunset' }
  ];

  let rebuildTimer: ReturnType<typeof setTimeout> | undefined;
  let lastKey = '';

  function patternKey(p: Pattern): string {
    return JSON.stringify({
      body: p.body,
      pieces: p.pieces.map((pc) => ({ id: pc.id, n: pc.mainPaths.length, a: pc.settings3d.arrangement, f: pc.settings3d.frozen, h: pc.hidden })),
      pts: p.points.length,
      seams: p.seams.length,
      mats: p.materials.map((m) => ({ id: m.id, c: m.frontTexture?.color, sw: m.stretchWarpValue, wf: m.stretchWeftValue, b: m.bendValue, w: m.weight }))
    });
  }

  onMount(() => {
    applyStoredTheme();
    dark = isDarkTheme();
    renderer = new PatternRenderer(containerEl);
    webgpu = renderer.webgpuAvailable();
    renderer.onStatus = (s, msg) => { status = s; statusMessage = msg ?? ''; };
    renderer.onModeChange = (m, piece) => { sceneMode = m; selectedPiece = piece; if (m === 'view') arrangeKind = null; };
    renderer.onSelectPiece = (id) => { onpieceselect?.(id); };
    renderer.onDrapeSettled = (savedByPiece) => { ondrapesettled?.(savedByPiece); };
    lastKey = patternKey(currentPattern);
    lightingMode = currentPattern.settings3d.lightingMode || 'flat';
    renderer.setPattern(currentPattern).then(() => {
      poses = renderer?.poseNames() ?? [];
      renderer?.setHighlightedPiece(selectedPieceId);
      applyLabelDisplay();
    });
  });

  onDestroy(() => {
    clearTimeout(rebuildTimer);
    renderer?.dispose();
    renderer = null;
  });

  $effect(() => {
    const key = patternKey(currentPattern);
    if (key === lastKey || !renderer) return;
    lastKey = key;
    clearTimeout(rebuildTimer);
    const snapshot = currentPattern;
    rebuildTimer = setTimeout(() => {
      renderer?.setPattern(snapshot).then(() => {
        poses = renderer?.poseNames() ?? [];
        renderer?.setHighlightedPiece(selectedPieceId);
        applyLabelDisplay();
      });
    }, 350);
  });

  // push external (2D) selection into the 3D view
  $effect(() => {
    const id = selectedPieceId;
    renderer?.setHighlightedPiece(id ?? null);
  });

  function toggleSimulate() {
    if (!renderer) return;
    if (status === 'simulating') renderer.stopSimulation();
    else renderer.simulate();
  }
  function reset() { renderer?.resetSimulation(); }
  function toggleArrangeMode() {
    if (!renderer) return;
    if (sceneMode === 'arrange' && arrangeKind === 'arrange') { renderer.exitArrangeMode(); return; }
    if (sceneMode === 'arrange') renderer.exitArrangeMode(); // switching from the Move tool
    renderer.enterArrangeMode();
    arrangeKind = 'arrange';
  }
  function toggleManipulateMode() {
    if (!renderer) return;
    if (sceneMode === 'arrange' && arrangeKind === 'manipulate') { renderer.exitArrangeMode(); return; }
    if (sceneMode === 'arrange') renderer.exitArrangeMode(); // switching from the Arrange tool
    renderer.enterManipulateMode();
    arrangeKind = 'manipulate';
  }
  function setGizmoMode(m: 'translate' | 'rotate') { gizmoMode = m; renderer?.setArrangeTransformMode(m); }
  function drapeFromArrangement() { renderer?.simulateFromArrangement(); }
  function setLighting(mode: string) { lightingMode = mode; renderer?.setLightingMode(mode); }
  // Dark mode flips the app's DaisyUI data-theme; both the 3D scene and the 2D canvas observe it and
  // re-theme themselves (see utils/theme), and all DaisyUI panels switch with it.
  function toggleDark() { dark = toggleTheme() === 'dark'; }
  function setPose(p: string) { currentPose = p; renderer?.setPose(p); }
  function toggleTriangles() { showTriangles = !showTriangles; renderer?.setShowTriangles(showTriangles); }
  function toggleAvatar() { showAvatar = !showAvatar; renderer?.setAvatarVisible(showAvatar); }

  // apply the piece-label display setting (driven from the Properties panel)
  function applyLabelDisplay() {
    renderer?.setShowLabels(labelDisplay !== 'off');
    renderer?.setLabelMode(labelDisplay === 'flat' ? 'flat' : 'billboard');
  }
  $effect(() => { void labelDisplay; applyLabelDisplay(); });
  function downloadOBJ() {
    if (!renderer) return;
    const obj = renderer.exportOBJ();
    const blob = new Blob([obj], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${currentPattern.name.replace(/\s+/g, '_') || 'garment'}.obj`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // 'A' toggles arrange mode (matches the source's keyboard shortcut).
  function handleKey(e: KeyboardEvent) {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'a' || e.key === 'A') { e.preventDefault(); toggleArrangeMode(); }
    if (e.key === 'm' || e.key === 'M') { e.preventDefault(); toggleManipulateMode(); }
  }

  // Right-side 3D control rail — Material Symbols icons + hover-to-expand labels, mirroring the
  // original studio. `sep` inserts a spacer before the button; `shortcut` shows a kbd on hover.
  interface Tool { label: string; icon: string; onClick: () => void; active?: () => boolean; sep?: boolean; shortcut?: string }
  const tools = $derived<Tool[]>([
    { label: status === 'simulating' ? 'Stop simulation' : 'Start simulation', icon: status === 'simulating' ? 'stop' : 'play_arrow', onClick: toggleSimulate, active: () => status === 'simulating' },
    { label: 'Reset simulation', icon: 'refresh', onClick: reset },
    { label: 'Show triangles', icon: 'change_history', onClick: toggleTriangles, active: () => showTriangles, sep: true },
    { label: 'Show avatar', icon: 'person', onClick: toggleAvatar, active: () => showAvatar },
    { label: sceneMode === 'arrange' && arrangeKind === 'arrange' ? 'Exit arrange mode' : 'Arrange (A)', icon: 'scatter_plot', onClick: toggleArrangeMode, active: () => sceneMode === 'arrange' && arrangeKind === 'arrange', shortcut: 'A' },
    { label: sceneMode === 'arrange' && arrangeKind === 'manipulate' ? 'Exit move mode' : 'Move pieces (M)', icon: 'open_with', onClick: toggleManipulateMode, active: () => sceneMode === 'arrange' && arrangeKind === 'manipulate', shortcut: 'M' },
    { label: dark ? 'Light mode' : 'Dark mode', icon: dark ? 'light_mode' : 'dark_mode', onClick: toggleDark, active: () => dark, sep: true },
    { label: 'Download as OBJ', icon: 'download', onClick: downloadOBJ }
  ]);
</script>

<svelte:window onkeydown={handleKey} />

<div class="w-full h-full relative">
  <div bind:this={containerEl} class="w-full h-full"></div>

  {#if !webgpu}
    <div class="absolute top-2 left-1/2 -translate-x-1/2 z-10 bg-warning text-warning-content text-xs rounded px-3 py-1 shadow">
      WebGPU not available — avatar shown, but live draping needs Chrome/Edge.
    </div>
  {/if}
  {#if status === 'error'}
    <div class="absolute top-2 left-1/2 -translate-x-1/2 z-10 bg-error text-error-content text-xs rounded px-3 py-1 shadow max-w-md text-center">{statusMessage || 'Renderer error'}</div>
  {/if}
  {#if status === 'loading'}
    <div class="absolute inset-0 flex items-center justify-center z-10 pointer-events-none"><span class="loading loading-spinner loading-md opacity-60"></span></div>
  {/if}

  <!-- Right-side control toolbar (mirrors the original studio) -->
  <div class="flex flex-col mt-3 absolute right-2 top-[6rem] z-10" data-tour-id="tour-3d-controls">
    {#each tools as tool}
      {#if tool.sep}<div class="h-8 mx-2"></div>{/if}
      <button
        type="button"
        title={tool.label}
        aria-label={tool.label}
        class="group relative flex items-center h-8 md:h-10 justify-center btn p-0 my-0.5 ml-1 mr-0 md:mr-1 max-w-[calc(100vw-3rem)] overflow-hidden transition-all self-end text-center hover:aspect-auto aspect-square shadow"
        class:btn-accent={tool.active?.()}
        class:btn-primary={!tool.active?.()}
        onclick={tool.onClick}
      >
        <span class="min-w-0 flex-1 p-0 hidden group-hover:inline">
          <span class="max-w-[9rem] overflow-hidden text-ellipsis text-xs pl-2 pr-1 whitespace-nowrap inline-flex items-center gap-1" style="line-height: 2">
            {tool.label}
            {#if tool.shortcut}<span class="kbd kbd-xs">{tool.shortcut}</span>{/if}
          </span>
        </span>
        <span class="block aspect-square h-full flex items-center justify-center">
          <span class="material-symbols-rounded notranslate" aria-hidden="true">{tool.icon}</span>
        </span>
      </button>
    {/each}
  </div>

  <!-- Piece-edit panel: select a piece, move/rotate it with the gizmo, then drape/settle -->
  {#if sceneMode === 'arrange'}
    <div class="absolute top-12 left-1/2 -translate-x-1/2 z-10 flex flex-col items-center gap-1">
      <div class="bg-base-200/90 backdrop-blur rounded-lg shadow px-3 py-2 flex items-center gap-2">
        <span class="text-xs opacity-70">{selectedPiece ? 'Piece selected' : 'Click a piece to select'}</span>
        <div class="join">
          <button class="join-item btn btn-xs" class:btn-active={gizmoMode === 'translate'} onclick={() => setGizmoMode('translate')}>Move</button>
          <button class="join-item btn btn-xs" class:btn-active={gizmoMode === 'rotate'} onclick={() => setGizmoMode('rotate')}>Rotate</button>
        </div>
        <button class="btn btn-xs btn-primary" onclick={drapeFromArrangement}>{arrangeKind === 'manipulate' ? 'Settle ▶' : 'Drape ▶'}</button>
        <button class="btn btn-xs btn-ghost" onclick={() => renderer?.exitArrangeMode()}>Cancel</button>
      </div>
      {#if arrangeKind === 'manipulate'}
        <span class="text-[10px] opacity-60 bg-base-200/70 rounded px-2 py-0.5">Drag a piece off the body — Settle eases it back into place</span>
      {/if}
    </div>
  {/if}

  <!-- Lighting-mode tabs (mirrors the source: Flat / Studio 1 / Studio 2 / Sunset) -->
  <div class="absolute bottom-2 left-1/2 -translate-x-1/2 z-10">
    <div class="join join-horizontal bg-base-200/85 backdrop-blur rounded-lg shadow">
      {#each lightingTabs as tab}
        <button class="join-item btn btn-xs" class:btn-active={lightingMode === tab.id} onclick={() => setLighting(tab.id)}>{tab.label}</button>
      {/each}
    </div>
  </div>

  <!-- Pose selector -->
  {#if poses.length}
    <div class="absolute bottom-11 left-1/2 -translate-x-1/2 z-10">
      <div class="join join-horizontal bg-base-200/85 backdrop-blur rounded-lg shadow">
        {#each poses as p}
          <button class="join-item btn btn-xs" class:btn-active={currentPose === p} onclick={() => setPose(p)}>{p}</button>
        {/each}
      </div>
    </div>
  {/if}

  <div class="absolute top-2 left-2 z-10 text-xs opacity-60 bg-base-200/80 rounded px-2 py-1">
    {currentPattern.body.gender} · {currentPattern.pieces.length} pieces
  </div>
</div>
