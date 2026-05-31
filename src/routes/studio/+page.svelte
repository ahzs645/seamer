<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import PatternCanvas2D from '$lib/components/PatternCanvas2D.svelte';
  import PatternScene3D from '$lib/components/PatternScene3D.svelte';
  import StudioToolbar from '$lib/components/StudioToolbar.svelte';
  import PropertyPanel from '$lib/components/PropertyPanel.svelte';
  import LayerPanel from '$lib/components/LayerPanel.svelte';
  import BodyPanel from '$lib/components/BodyPanel.svelte';
  import MaterialPanel from '$lib/components/MaterialPanel.svelte';
  import SeamPanel from '$lib/components/SeamPanel.svelte';
  import ObjectBrowser from '$lib/components/ObjectBrowser.svelte';
  import { pattern, selectedPointIds, selectedPathIds, selectedPieceIds, pushUndo, undo, redo } from '$lib/stores/pattern';
  import { loadPattern, savePattern as saveToDB } from '$lib/stores/localDB';
  import { EMPTY_PATTERN, type Pattern, type Piece, type ConstrainablePoint } from '$lib/types/pattern';
  import { isSimpleFormat, convertSimplePattern } from '$lib/utils/importSimplePattern';
  import { deletePoint, deletePath, deletePiece } from '$lib/utils/patternMutations';
  import Toaster from '$lib/components/Toaster.svelte';
  import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
  import GradingOverlay from '$lib/components/GradingOverlay.svelte';
  import { toastSuccess, toastError } from '$lib/stores/toast';
  import { confirm } from '$lib/stores/confirm';
  import { patternToSVG, patternToDXF, patternToCSV, downloadText, patternToPNG, downloadBlob, printPattern } from '$lib/utils/exporters';
  import { dxfToPattern, svgToPattern } from '$lib/utils/patternImport';
  import ErrorsPanel from '$lib/components/ErrorsPanel.svelte';
  import KeyboardShortcuts from '$lib/components/KeyboardShortcuts.svelte';
  import WelcomeModal from '$lib/components/WelcomeModal.svelte';
  import { redraft, hasConstraints, makeParametric } from '$lib/solver/solve';

  let currentPattern = $state<Pattern>(structuredClone(EMPTY_PATTERN));
  let saved = $state(true);
  let viewMode = $state<'2d' | '3d' | 'both'>('both');
  let leftTab = $state<'layers' | 'body' | 'materials' | 'seams'>('layers');
  let showRightPanel = $state(true);
  let showLeftPanel = $state(true);
  let patternName = $state('New Pattern');
  let labelDisplay = $state<'off' | 'billboard' | 'flat'>('flat'); // projected-on-fabric, like the source
  let showObjectBrowser = $state(false);
  let showShortcuts = $state(false);
  let showGrading = $state(false);

  const templatePatterns: Record<string, { name: string; description: string; file: string }> = {
    'parametric-skirt': { name: 'Parametric Skirt ✨', description: 'Truly parametric: waist/hip/length variables re-draft the geometry; grades by size', file: 'parametric-skirt.json' },
    'simple-pants': { name: 'Trousers', description: 'Simple pants in 3D (full 3D data)', file: 'simple-pants-3d.json' },
    'flare-dress': { name: 'Fit & Flare Dress (imported)', description: 'Sleeveless fit and flare dress — converted from a 2D export', file: 'flare-dress.raw.json' },
    'pencil-skirt': { name: 'Pencil Skirt (3D)', description: 'Pencil skirt with waistband, multi-seam (full 3D data)', file: 'pencil-skirt.json' },
    'pencil-skirt-2d': { name: 'Pencil Skirt (2D)', description: '2D skirt block that updates with the body', file: 'pencil-skirt-2d-bodydouble.json' },
    'pencil-skirt-2d-tutorial': { name: 'Pencil Skirt (2D, tutorial)', description: '2D pencil skirt from the YouTube tutorial', file: 'pencil-skirt-2d-tutorial.json' },
    'grundschnitt-rock': { name: 'Skirt Block', description: 'Basic skirt block (Grundschnitt Rock)', file: 'grundschnitt-rock.json' },
    'panty-block': { name: 'Panty Block', description: 'Basic highwaisted panty block', file: 'panty-block.json' },
    'russ-pants': { name: 'Russ Pants', description: "Norwegian 'russ' party pants", file: 'russ-pants.json' },
    'tshirt-basic': { name: 'T-Shirt (Basic)', description: 'Front and back pieces with many variables', file: 'tshirt-basic.json' },
    'long-sleeve-shirt': { name: 'Long Sleeve Shirt', description: 'Long sleeve shirt with collar and cuffs', file: 'long-sleeve-shirt.json' },
    'parametric-shirt': { name: 'Parametric Shirt', description: 'Long sleeve shirt controlled by measurements', file: 'parametric-shirt.json' },
    'shirt-with-pocket': { name: 'Shirt with Pocket', description: 'Shirt with a front chest pocket', file: 'shirt-with-pocket.json' },
    'test-shirt-3d': { name: 'Test Shirt (3D)', description: 'Demo shirt in 3D', file: 'test-shirt-3d.json' },
    'tailored-shirt': { name: 'Tailored Shirt', description: "Sample pattern from Aldrich's book", file: 'tailored-shirt.json' },
    'womens-jacket': { name: "Women's Jacket", description: "Ladies' basic jacket with two-piece sleeves", file: 'womens-jacket.json' },
    'oversized-blazer': { name: 'Oversized Blazer', description: 'Oversized longline blazer base (WIP)', file: 'oversized-blazer.json' },
    'black-dress': { name: 'Black Dress', description: 'Little black dress, simple', file: 'black-dress.json' },
    'flared-midi-dress': { name: 'Flared Midi Dress', description: 'Snug at bust and waist with maxi flared lower part', file: 'flared-midi-dress.json' },
    'nightwing-logo': { name: 'Nightwing Logo', description: 'Nightwing chest logo applique', file: 'nightwing-logo.json' }
  };

  let autoSaveTimer: ReturnType<typeof setInterval>;

  onMount(() => {
    (async () => {
      const id = $page.url.searchParams.get('id');
      if (id) {
        const loaded = await loadPattern(id);
        if (loaded) { currentPattern = loaded; patternName = loaded.name; pushUndo(structuredClone(loaded)); }
        pattern.set(currentPattern);
      } else {
        await loadTemplate('simple-pants'); // auto-load a garment to drape
      }
    })();

    autoSaveTimer = setInterval(async () => {
      if (!saved) { await saveToDB(currentPattern); saved = true; }
    }, 5000);

    const handler = (e: BeforeUnloadEvent) => { if (!saved) e.preventDefault(); };
    window.addEventListener('beforeunload', handler);

    return () => { clearInterval(autoSaveTimer); window.removeEventListener('beforeunload', handler); };
  });

  function handlePatternUpdate(updated: Pattern) {
    if (JSON.stringify(currentPattern) !== JSON.stringify(updated)) pushUndo($state.snapshot(currentPattern) as Pattern);
    // live re-draft: recompute formula-constrained points from variables/measurements
    if (hasConstraints(updated)) {
      const solved = redraft(updated);
      if (JSON.stringify(solved.points) !== JSON.stringify(updated.points) || JSON.stringify(solved.variables) !== JSON.stringify(updated.variables)) {
        updated = solved;
      }
    }
    currentPattern = updated; saved = false; pattern.set(updated);
  }

  // A user-run drape settled: persist the freshly-settled per-piece savedPositions so re-opening shows
  // the result instantly and body re-fits chain off the latest drape. Not an undo-able user edit, so
  // no pushUndo; savedPositions isn't in the 3D patternKey, so this won't trigger a re-drape. Mark
  // unsaved and let the 5s autosave (or an explicit save) write it.
  function handleDrapeSettled(savedByPiece: Record<string, number[]>) {
    let changed = false;
    const pieces = currentPattern.pieces.map((p) => {
      const sp = savedByPiece[p.id];
      if (!sp) return p;
      changed = true;
      return { ...p, settings3d: { ...p.settings3d, savedPositions: sp } };
    });
    if (!changed) return;
    currentPattern = { ...currentPattern, pieces };
    pattern.set(currentPattern);
    saved = false;
  }

  async function handleSave() {
    currentPattern = { ...currentPattern, name: patternName };
    await saveToDB(currentPattern); saved = true;
    toastSuccess('Pattern saved');
  }

  async function handleExport() {
    const blob = new Blob([JSON.stringify(currentPattern, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a');
    a.href = url; a.download = `${patternName.replace(/\s+/g, '_')}.seamer.json`; a.click(); URL.revokeObjectURL(url);
  }

  function exportAs(fmt: 'svg' | 'dxf' | 'csv') {
    const base = patternName.replace(/\s+/g, '_') || 'pattern';
    if (fmt === 'svg') downloadText(`${base}.svg`, patternToSVG(currentPattern), 'image/svg+xml');
    else if (fmt === 'dxf') downloadText(`${base}.dxf`, patternToDXF(currentPattern), 'application/dxf');
    else downloadText(`${base}.csv`, patternToCSV(currentPattern), 'text/csv');
    toastSuccess(`Exported ${fmt.toUpperCase()}`);
  }

  async function exportPNG() {
    const base = patternName.replace(/\s+/g, '_') || 'pattern';
    const blob = await patternToPNG(currentPattern);
    if (!blob) { toastError('Nothing to export'); return; }
    downloadBlob(`${base}.png`, blob);
    toastSuccess('Exported PNG');
  }

  function doPrint() { printPattern(currentPattern, patternName || 'Pattern'); }

  /** Parse imported text by extension into a Pattern (shared by the file picker + sample loader). */
  function parseImport(text: string, ext: string | undefined, name: string): Pattern {
    if (ext === 'dxf') return dxfToPattern(text, name);
    if (ext === 'svg') return svgToPattern(text, name);
    const raw = JSON.parse(text);
    return isSimpleFormat(raw) ? convertSimplePattern(raw) : (raw as Pattern);
  }

  function applyImported(data: Pattern) {
    currentPattern = data; patternName = data.name; pattern.set(data); pushUndo(structuredClone(data)); saved = true;
    toastSuccess(`Imported "${data.name}"`);
  }

  function handleImport() {
    const input = document.createElement('input'); input.type = 'file'; input.accept = '.json,.seamer.json,.dxf,.svg';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0]; if (!file) return;
      const ext = file.name.split('.').pop()?.toLowerCase();
      try {
        applyImported(parseImport(await file.text(), ext, file.name.replace(/\.(dxf|svg|json|seamer\.json)$/i, '')));
      } catch { toastError('Could not import file'); }
    };
    input.click();
  }

  // Bundled DXF/SVG fixtures (served from /samples) for one-click import testing.
  const importSamples: { file: string; label: string }[] = [
    { file: 'pocket-curved.svg', label: 'Pocket (curved, SVG)' },
    { file: 'two-pieces.svg', label: 'Two pieces (SVG)' },
    { file: 'rect-piece.dxf', label: 'Rectangle (DXF)' },
    { file: 'curved-hem.dxf', label: 'Curved hem (DXF bulge)' }
  ];

  async function importSample(file: string) {
    try {
      const res = await fetch(`/samples/${file}`);
      if (!res.ok) throw new Error('not found');
      const ext = file.split('.').pop()?.toLowerCase();
      applyImported(parseImport(await res.text(), ext, file.replace(/\.(dxf|svg)$/i, '')));
    } catch { toastError(`Could not load sample "${file}"`); }
  }

  async function handleNew() {
    if (currentPattern.pieces.length > 0 || currentPattern.points.length > 0) {
      const ok = await confirm({
        title: 'Clear the scene?',
        message: 'Are you sure you want to clear the scene? This removes the current pattern from the canvas.',
        confirmLabel: 'Clear scene', danger: true
      });
      if (!ok) return;
    }
    currentPattern = structuredClone(EMPTY_PATTERN); patternName = 'New Pattern'; pattern.set(currentPattern); pushUndo(structuredClone(EMPTY_PATTERN)); saved = true;
    toastSuccess('Scene cleared');
  }

  async function loadTemplate(key: string) {
    const tpl = templatePatterns[key];
    if (!tpl) return;
    try {
      const res = await fetch(`/templates/${tpl.file}`);
      if (!res.ok) throw new Error('Not found');
      const raw = await res.json();
      let data: Pattern = isSimpleFormat(raw) ? convertSimplePattern(raw) : (raw as Pattern);
      data.id = crypto.randomUUID(); data.versionId = crypto.randomUUID(); data.isPublic = false;
      // recover parametric constructions from the baked template (no-op if already constrained / not recoverable)
      data = makeParametric(data);
      currentPattern = data; patternName = tpl.name || data.name; pattern.set(data); pushUndo(structuredClone(data)); saved = true;
    } catch {
      currentPattern = { ...EMPTY_PATTERN, name: tpl.name, description: tpl.description, enable3d: true, viewMode: 'both' };
      patternName = tpl.name; pattern.set(currentPattern); pushUndo($state.snapshot(currentPattern) as Pattern); saved = true;
    }
  }

  function handlePieceSelect(id: string | null) {
    selectedPieceIds.set(id ? new Set([id]) : new Set());
    selectedPointIds.set(new Set());
    selectedPathIds.set(new Set());
  }

  function handleUndo() { const prev = undo(); if (prev) { currentPattern = prev; patternName = prev.name; pattern.set(prev); saved = false; } }
  function handleRedo() { const next = redo(); if (next) { currentPattern = next; patternName = next.name; pattern.set(next); saved = false; } }

  function handleKeydown(e: KeyboardEvent) {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if ((e.metaKey || e.ctrlKey) && e.key === 'z') { e.preventDefault(); e.shiftKey ? handleRedo() : handleUndo(); }
    if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); handleSave(); }
    if ((e.metaKey || e.ctrlKey) && (e.key === 'd' || e.key === 'D')) { e.preventDefault(); duplicateSelectedPiece(); }
    if ((e.metaKey || e.ctrlKey) && (e.key === 'c' || e.key === 'C')) { e.preventDefault(); handleCopy(); }
    if ((e.metaKey || e.ctrlKey) && (e.key === 'v' || e.key === 'V')) { e.preventDefault(); handlePaste(); }
    if (e.key === '?' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); showShortcuts = !showShortcuts; }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      let p = $pattern;
      let changed = false;
      // Cascading deletes via patternMutations: folding sequentially so deleting points + paths +
      // pieces in one keystroke accumulates into a single update (and removes dependent edges/seams).
      for (const id of $selectedPointIds) { p = deletePoint(p, id); changed = true; }
      for (const id of $selectedPathIds) { p = deletePath(p, id); changed = true; }
      for (const id of $selectedPieceIds) { p = deletePiece(p, id); changed = true; }
      if (changed) {
        handlePatternUpdate(p);
        selectedPointIds.set(new Set());
        selectedPathIds.set(new Set());
        selectedPieceIds.set(new Set());
        toastSuccess('Deleted');
      }
    }
  }

  const uidFor = (pre: string) => `${pre}_${crypto.randomUUID().replace(/-/g, '').slice(0, 9)}`;
  let clipboard: { kind: 'pieces'; items: Piece[] } | { kind: 'points'; items: ConstrainablePoint[] } | null = null;
  const plural = (n: number) => `${n} item${n === 1 ? '' : 's'}`;

  function handleCopy() {
    const p = $pattern;
    if ($selectedPieceIds.size > 0) {
      const items = p.pieces.filter(pc => $selectedPieceIds.has(pc.id)).map(pc => structuredClone($state.snapshot(pc)) as Piece);
      clipboard = { kind: 'pieces', items };
      toastSuccess(`${plural(items.length)} copied to clipboard`);
    } else if ($selectedPointIds.size > 0) {
      const items = p.points.filter(pt => $selectedPointIds.has(pt.id)).map(pt => structuredClone($state.snapshot(pt)) as ConstrainablePoint);
      clipboard = { kind: 'points', items };
      toastSuccess(`${plural(items.length)} copied to clipboard`);
    }
  }

  function handlePaste() {
    if (!clipboard) return;
    const p = $pattern;
    if (clipboard.kind === 'pieces') {
      const clones = clipboard.items.map(src => {
        const c = structuredClone(src) as Piece;
        c.id = uidFor('Piece');
        c.name = `Copy of ${src.name}`;
        c.position = { x: src.position.x + 50, y: src.position.y - 50 };
        for (const pp of [...c.mainPaths, ...c.internalPaths]) pp.id = uidFor('PiecePath');
        return c;
      });
      handlePatternUpdate({ ...p, pieces: [...p.pieces, ...clones], hasChanged: true });
      selectedPieceIds.set(new Set(clones.map(c => c.id)));
      toastSuccess(`${plural(clones.length)} pasted`);
    } else {
      const prefix = p.pointPrefix || 'A';
      let n = p.points.length;
      const names = new Set(p.points.map(q => q.name));
      const nextName = () => { while (names.has(`${prefix}${n}`)) n++; const nm = `${prefix}${n}`; names.add(nm); return nm; };
      const clones = clipboard.items.map(src => ({ ...structuredClone(src), id: uidFor('ConstrainablePoint'), name: nextName(), x: src.x + 25, y: src.y + 25 }) as ConstrainablePoint);
      handlePatternUpdate({ ...p, points: [...p.points, ...clones], hasChanged: true });
      selectedPointIds.set(new Set(clones.map(c => c.id)));
      toastSuccess(`${plural(clones.length)} pasted`);
    }
  }

  function duplicateSelectedPiece() {
    if ($selectedPieceIds.size !== 1) return;
    const p = $pattern;
    const piece = p.pieces.find(pc => $selectedPieceIds.has(pc.id));
    if (!piece) return;
    const uid = (pre: string) => `${pre}_${crypto.randomUUID().replace(/-/g, '').slice(0, 9)}`;
    const clone = structuredClone($state.snapshot(piece));
    clone.id = uid('Piece');
    clone.name = `Copy of ${piece.name}`;
    clone.position = { x: piece.position.x + 50, y: piece.position.y - 50 };
    for (const pp of [...clone.mainPaths, ...clone.internalPaths]) pp.id = uid('PiecePath');
    handlePatternUpdate({ ...p, pieces: [...p.pieces, clone], hasChanged: true });
    selectedPieceIds.set(new Set([clone.id]));
    toastSuccess(`Duplicated "${piece.name}"`);
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="flex flex-col h-screen overflow-hidden">
  <div class="flex items-center justify-between px-3 py-1.5 bg-base-200 border-b shrink-0">
    <div class="flex items-center gap-2">
      <a href="/" class="btn btn-ghost btn-xs">&larr;</a>
      <span class="text-sm font-lexend font-semibold hidden lg:inline">Pattern Studio</span>
    </div>
    <div class="flex items-center gap-2">
      <input type="text" class="input input-bordered input-xs w-40 lg:w-56" placeholder="Pattern name..." bind:value={patternName} />
      <div class="dropdown dropdown-end">
        <div role="button" class="btn btn-xs btn-ghost">Templates</div>
        <ul class="dropdown-content menu bg-base-200 rounded-box z-50 w-56 p-2 shadow">
          {#each Object.entries(templatePatterns) as [key, tpl]}
            <li><button class="w-full text-left" onclick={() => loadTemplate(key)}>{tpl.name}<span class="text-xs opacity-50 ml-1">{tpl.description.substring(0, 40)}</span></button></li>
          {/each}
        </ul>
      </div>
      <div class="join join-horizontal">
        <button class="join-item btn btn-xs" class:btn-active={viewMode === '2d'} onclick={() => viewMode = '2d'}>2D</button>
        <button class="join-item btn btn-xs" class:btn-active={viewMode === 'both'} onclick={() => viewMode = 'both'}>Both</button>
        <button class="join-item btn btn-xs" class:btn-active={viewMode === '3d'} onclick={() => viewMode = '3d'}>3D</button>
      </div>
    </div>
    <div class="flex items-center gap-1">
      <button class="btn btn-ghost btn-xs" onclick={handleUndo} title="Undo (Ctrl+Z)">&#x21A9;</button>
      <button class="btn btn-ghost btn-xs" onclick={handleRedo} title="Redo (Ctrl+Shift+Z)">&#x21AA;</button>
      <div class="dropdown dropdown-end">
        <div role="button" tabindex="0" class="btn btn-ghost btn-xs">Import</div>
        <ul class="dropdown-content menu bg-base-200 rounded-box z-50 w-52 p-2 shadow text-sm">
          <li><button onclick={handleImport}>From file… (JSON/DXF/SVG)</button></li>
          <li class="menu-title pt-2">Samples</li>
          {#each importSamples as s}
            <li><button onclick={() => importSample(s.file)}>{s.label}</button></li>
          {/each}
        </ul>
      </div>
      <div class="dropdown dropdown-end">
        <div role="button" tabindex="0" class="btn btn-ghost btn-xs">Export</div>
        <ul class="dropdown-content menu bg-base-200 rounded-box z-50 w-44 p-2 shadow text-sm">
          <li><button onclick={handleExport}>JSON (.seamer.json)</button></li>
          <li><button onclick={() => exportAs('svg')}>SVG</button></li>
          <li><button onclick={() => exportAs('dxf')}>DXF</button></li>
          <li><button onclick={exportPNG}>PNG</button></li>
          <li><button onclick={() => exportAs('csv')}>CSV (points)</button></li>
          <li><button onclick={doPrint}>Print…</button></li>
        </ul>
      </div>
      <button class="btn btn-ghost btn-xs" onclick={handleNew}>New</button>
      <button class="btn btn-xs" class:btn-accent={!saved} class:btn-ghost={saved} onclick={handleSave}>{saved ? 'Saved' : 'Save'}</button>
      <button class="btn btn-ghost btn-xs" onclick={() => showLeftPanel = !showLeftPanel} title="Toggle left panel">&#x2630;</button>
      <button class="btn btn-ghost btn-xs" onclick={() => showRightPanel = !showRightPanel} title="Toggle right panel">&#x25B6;</button>
      <button class="btn btn-xs" class:btn-active={showObjectBrowser} onclick={() => showObjectBrowser = !showObjectBrowser} title="Toggle object browser">
        <span class="material-symbols-rounded notranslate align-middle" style="font-size:18px">view_list</span>
      </button>
      <ErrorsPanel {currentPattern} />
      <button class="btn btn-ghost btn-xs" onclick={() => showShortcuts = true} title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts">
        <span class="material-symbols-rounded notranslate align-middle" style="font-size:18px">keyboard</span>
      </button>
    </div>
  </div>

  <div class="flex-1 flex overflow-hidden">
    {#if showLeftPanel}
      <div class="w-56 border-r bg-base-100 flex flex-col shrink-0 overflow-hidden">
        <div class="tabs tabs-boxed tabs-xs bg-base-200 px-1 pt-1">
          <button class="tab" class:tab-active={leftTab === 'layers'} onclick={() => leftTab = 'layers'}>Layers</button>
          <button class="tab" class:tab-active={leftTab === 'body'} onclick={() => leftTab = 'body'}>Body</button>
          <button class="tab" class:tab-active={leftTab === 'materials'} onclick={() => leftTab = 'materials'}>Fabric</button>
          <button class="tab" class:tab-active={leftTab === 'seams'} onclick={() => leftTab = 'seams'}>Seams</button>
        </div>
        <div class="flex-1 overflow-y-auto p-2">
          {#if leftTab === 'layers'}<LayerPanel {currentPattern} onchange={handlePatternUpdate} />
          {:else if leftTab === 'body'}<BodyPanel {currentPattern} onchange={handlePatternUpdate} />
          {:else if leftTab === 'materials'}<MaterialPanel {currentPattern} onchange={handlePatternUpdate} />
          {:else if leftTab === 'seams'}<SeamPanel {currentPattern} onchange={handlePatternUpdate} />
          {/if}
        </div>
      </div>
    {/if}

    <div class="flex-1 flex overflow-hidden">
      {#if viewMode === 'both'}
        <div class="w-1/2 border-r relative"><PatternCanvas2D {currentPattern} onchange={handlePatternUpdate} /></div>
        <div class="w-1/2 relative"><PatternScene3D {currentPattern} selectedPieceId={[...$selectedPieceIds][0] ?? null} onpieceselect={handlePieceSelect} ondrapesettled={handleDrapeSettled} {labelDisplay} /></div>
      {:else if viewMode === '2d'}
        <div class="flex-1 relative"><PatternCanvas2D {currentPattern} onchange={handlePatternUpdate} /></div>
      {:else}
        <div class="flex-1 relative"><PatternScene3D {currentPattern} selectedPieceId={[...$selectedPieceIds][0] ?? null} onpieceselect={handlePieceSelect} ondrapesettled={handleDrapeSettled} {labelDisplay} /></div>
      {/if}
    </div>

    {#if showRightPanel}
      <PropertyPanel {currentPattern} onchange={handlePatternUpdate} onclose={() => (showRightPanel = false)} {labelDisplay} onlabeldisplaychange={(v) => (labelDisplay = v)} ongrading={() => (showGrading = true)} />
    {/if}
  </div>

  <div class="h-10 border-t bg-base-200 shrink-0">
    <StudioToolbar {currentPattern} onchange={handlePatternUpdate} />
  </div>

  {#if showObjectBrowser}
    <ObjectBrowser {currentPattern} onchange={handlePatternUpdate} bind:open={showObjectBrowser} />
  {/if}
</div>

<KeyboardShortcuts bind:open={showShortcuts} />
<WelcomeModal onshowshortcuts={() => (showShortcuts = true)} />

<Toaster />
<ConfirmDialog />
{#if showGrading}<GradingOverlay {currentPattern} onclose={() => (showGrading = false)} />{/if}
