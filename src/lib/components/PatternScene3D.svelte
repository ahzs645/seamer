<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import type { Pattern } from '$lib/types/pattern';
  import { PatternRenderer, type RendererStatus, type SceneMode } from '$lib/scene/scene3d';
  import type { SimConfig } from '$lib/sim/config';
  import { isDarkTheme, toggleTheme, applyStoredTheme } from '$lib/utils/theme';
  import { pieceGeometrySignature } from '$lib/utils/patternGeometry';

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
  // Per-piece resolved-geometry signature at the last ACTUAL rebuild. Diffing the live pattern against
  // this tells us which pieces' shapes were edited, so only those re-triangulate from live geometry.
  let builtSigs = new Map<string, string>();

  function pieceSigs(p: Pattern): Map<string, string> {
    const m = new Map<string, string>();
    for (const pc of p.pieces) m.set(pc.id, pieceGeometrySignature(p, pc));
    return m;
  }

  /** The rebuild trigger. Includes each piece's RESOLVED geometry signature (not just path/point
   *  counts) so reshaping a piece in the 2D editor — moving a point, dragging a bézier handle —
   *  changes the key and forces a 3D rebuild. */
  function patternKey(p: Pattern, sigs = pieceSigs(p)): string {
    return JSON.stringify({
      body: p.body,
      pieces: p.pieces.map((pc) => ({ id: pc.id, g: sigs.get(pc.id), a: pc.settings3d.arrangement, f: pc.settings3d.frozen, h: pc.hidden })),
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
    renderer.onModeChange = (m, piece, kind) => { sceneMode = m; selectedPiece = piece; arrangeKind = kind ?? null; };
    renderer.onSelectPiece = (id) => { onpieceselect?.(id); };
    renderer.onDrapeSettled = (savedByPiece) => { ondrapesettled?.(savedByPiece); };
    builtSigs = pieceSigs(currentPattern);
    lastKey = patternKey(currentPattern, builtSigs);
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
      // Diff the about-to-build pattern against the last ACTUAL build to find which pieces' shapes
      // were edited (robust across several edits within the debounce window). Those rebuild from live
      // geometry; the rest keep their cached drape. builtSigs advances only here, when a build runs.
      const sigs = pieceSigs(snapshot);
      const changed = new Set<string>();
      for (const [id, sig] of sigs) if (builtSigs.has(id) && builtSigs.get(id) !== sig) changed.add(id);
      builtSigs = sigs;
      renderer?.setPattern(snapshot, changed).then(() => {
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
  // arrangeKind is kept in sync by renderer.onModeChange, so these just toggle/switch the tool.
  function toggleArrangeMode() {
    if (!renderer) return;
    if (sceneMode === 'arrange' && arrangeKind === 'arrange') { renderer.exitArrangeMode(); return; }
    if (sceneMode === 'arrange') renderer.exitArrangeMode(); // switching from the Move tool
    renderer.enterArrangeMode();
  }
  function toggleManipulateMode() {
    if (!renderer) return;
    if (sceneMode === 'arrange' && arrangeKind === 'manipulate') { renderer.exitArrangeMode(); return; }
    if (sceneMode === 'arrange') renderer.exitArrangeMode(); // switching from the Arrange tool
    renderer.enterManipulateMode();
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
  // Save Image: export the current 3D view as a PNG (matches the source's bottom-bar "Save Image").
  function saveImage() {
    if (!renderer) return;
    const a = document.createElement('a');
    a.href = renderer.captureImage();
    a.download = `${currentPattern.name.replace(/\s+/g, '_') || 'garment'}.png`;
    a.click();
  }

  // Simulation controls: expose the solver parameters (matches the source's "Simulation controls").
  let showSimPanel = $state(false);
  let simCfg = $state<SimConfig | null>(null);
  function toggleSimPanel() {
    showSimPanel = !showSimPanel;
    if (showSimPanel && renderer) simCfg = renderer.getSimConfig();
  }
  function setSim(patch: Partial<SimConfig>) {
    if (!renderer || !simCfg) return;
    simCfg = { ...simCfg, ...patch };
    void renderer.setSimConfig(patch);
  }
  // gravity is stored as a vector; the slider edits its magnitude (m/s²).
  function setGravity(g: number) { setSim({ gravity: [0, -g, 0] }); }

  // Frozen snapshot: a translucent ghost of the current drape, kept as a visual reference.
  let hasSnap = $state(false);
  let snapOpacity = $state(0.35);
  function freezeSnapshot() { renderer?.freezeSnapshot(snapOpacity); hasSnap = !!renderer?.hasSnapshot(); }
  function clearSnapshot() { renderer?.clearSnapshot(); hasSnap = false; }
  function setSnapOpacity(o: number) { snapOpacity = o; renderer?.setSnapshotOpacity(o); }

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
    { label: 'Simulation controls', icon: 'tune', onClick: toggleSimPanel, active: () => showSimPanel },
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

  <!-- Simulation controls panel (mirrors the source's "Simulation controls"/Simulator config) -->
  {#if showSimPanel && simCfg}
    <div class="absolute top-12 right-2 z-10 w-60 bg-base-200/95 backdrop-blur rounded-lg shadow-lg p-3 text-xs space-y-2 max-h-[70vh] overflow-y-auto">
      <div class="flex items-center justify-between"><span class="font-bold">Simulation controls</span>
        <button class="btn btn-ghost btn-xs btn-circle" onclick={() => (showSimPanel = false)} aria-label="Close">✕</button>
      </div>
      <label class="flex items-center justify-between gap-2"><span>Self-collision</span>
        <input type="checkbox" class="toggle toggle-xs" checked={simCfg.handleSelfCollisions} onchange={(e) => setSim({ handleSelfCollisions: e.currentTarget.checked })} /></label>
      <label class="flex items-center justify-between gap-2"><span>Body collision</span>
        <input type="checkbox" class="toggle toggle-xs" checked={simCfg.handleExternalCollisions} onchange={(e) => setSim({ handleExternalCollisions: e.currentTarget.checked })} /></label>
      {#each [
        { key: 'gravity', label: 'Gravity', min: 0, max: 20, step: 0.1, get: () => -simCfg!.gravity[1], set: setGravity, fmt: (v: number) => v.toFixed(1) },
        { key: 'globalDamping', label: 'Global damping', min: 0, max: 1, step: 0.01, get: () => simCfg!.globalDamping, set: (v: number) => setSim({ globalDamping: v }), fmt: (v: number) => v.toFixed(2) },
        { key: 'nearDamping', label: 'Near damping', min: 0, max: 1, step: 0.01, get: () => simCfg!.nearDamping, set: (v: number) => setSim({ nearDamping: v }), fmt: (v: number) => v.toFixed(2) },
        { key: 'simulationThickness', label: 'Thickness (mm)', min: 0, max: 20, step: 0.5, get: () => simCfg!.simulationThickness * 1000, set: (v: number) => setSim({ simulationThickness: v / 1000, edgeThickness: v / 1000 }), fmt: (v: number) => v.toFixed(1) },
        { key: 'selfCollisionFriction', label: 'Self friction', min: 0, max: 1, step: 0.05, get: () => simCfg!.selfCollisionFriction, set: (v: number) => setSim({ selfCollisionFriction: v }), fmt: (v: number) => v.toFixed(2) },
        { key: 'externalCollisionFriction', label: 'Body friction', min: 0, max: 1, step: 0.05, get: () => simCfg!.externalCollisionFriction, set: (v: number) => setSim({ externalCollisionFriction: v }), fmt: (v: number) => v.toFixed(2) },
        { key: 'seamStrength', label: 'Seam strength', min: 0, max: 2, step: 0.1, get: () => simCfg!.seamStrength, set: (v: number) => setSim({ seamStrength: v }), fmt: (v: number) => v.toFixed(1) },
        { key: 'seamIterations', label: 'Seam iterations', min: 1, max: 8, step: 1, get: () => simCfg!.seamIterations, set: (v: number) => setSim({ seamIterations: v }), fmt: (v: number) => v.toFixed(0) }
      ] as ctl (ctl.key)}
        <label class="flex flex-col gap-0.5">
          <span class="flex justify-between"><span>{ctl.label}</span><span class="opacity-60">{ctl.fmt(ctl.get())}</span></span>
          <input type="range" class="range range-xs" min={ctl.min} max={ctl.max} step={ctl.step} value={ctl.get()} oninput={(e) => ctl.set(parseFloat(e.currentTarget.value))} />
        </label>
      {/each}
      <p class="opacity-50 leading-tight pt-1">Changes apply immediately; the drape is preserved.</p>
      <div class="border-t border-base-300 pt-2 space-y-1">
        <span class="font-bold">Frozen snapshot</span>
        {#if hasSnap}
          <label class="flex flex-col gap-0.5">
            <span class="flex justify-between"><span>Opacity</span><span class="opacity-60">{snapOpacity.toFixed(2)}</span></span>
            <input type="range" class="range range-xs" min="0.05" max="1" step="0.05" value={snapOpacity} oninput={(e) => setSnapOpacity(parseFloat(e.currentTarget.value))} />
          </label>
          <div class="flex gap-1">
            <button class="btn btn-xs flex-1" onclick={freezeSnapshot}>Re-freeze</button>
            <button class="btn btn-xs btn-ghost flex-1" onclick={clearSnapshot}>Remove</button>
          </div>
        {:else}
          <button class="btn btn-xs btn-block" onclick={freezeSnapshot}>Freeze snapshot of drape</button>
        {/if}
      </div>
    </div>
  {/if}

  <!-- Lighting-mode tabs + Save Image (mirrors the source's bottom bar) -->
  <div class="absolute bottom-2 left-1/2 -translate-x-1/2 z-10 flex items-center gap-2">
    <div class="join join-horizontal bg-base-200/85 backdrop-blur rounded-lg shadow">
      {#each lightingTabs as tab}
        <button class="join-item btn btn-xs" class:btn-active={lightingMode === tab.id} onclick={() => setLighting(tab.id)}>{tab.label}</button>
      {/each}
    </div>
    <button class="btn btn-xs gap-1 bg-base-200/85 backdrop-blur shadow" title="Save a PNG of the 3D view" onclick={saveImage}>
      <span class="material-symbols-rounded notranslate text-base" aria-hidden="true">photo_camera</span>
      Save Image
    </button>
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
