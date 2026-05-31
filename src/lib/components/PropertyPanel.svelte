<script lang="ts">
  import type { Pattern, ConstrainablePoint, ConstrainablePath, Piece, PieceArrangement, PiecePath } from '$lib/types/pattern';
  import { selectedPointIds, selectedPathIds, selectedPieceIds } from '$lib/stores/pattern';

  interface Props {
    currentPattern: Pattern;
    onchange: (p: Pattern) => void;
    onclose?: () => void;
    labelDisplay?: 'off' | 'billboard' | 'flat';
    onlabeldisplaychange?: (v: 'off' | 'billboard' | 'flat') => void;
  }

  let { currentPattern, onchange, onclose, labelDisplay = 'flat', onlabeldisplaychange }: Props = $props();

  const editingPoint = $derived<ConstrainablePoint | null>(
    $selectedPointIds.size === 1 ? currentPattern.points.find((p) => p.id === [...$selectedPointIds][0]) ?? null : null
  );
  const editingPiece = $derived<Piece | null>(
    $selectedPieceIds.size === 1 ? currentPattern.pieces.find((p) => p.id === [...$selectedPieceIds][0]) ?? null : null
  );

  // which accordion section is open (Seam boundary open by default, like the source)
  let openSection = $state<string>('seam');
  function toggle(id: string) { openSection = openSection === id ? '' : id; }

  const pointName = (id: string) => currentPattern.points.find((p) => p.id === id)?.name ?? id.slice(0, 6);
  const pathName = (id: string) => currentPattern.paths.find((p) => p.id === id)?.name || 'path';

  function updatePoint(field: 'name' | 'x' | 'y', value: string | number) {
    if (!editingPoint) return;
    const points = currentPattern.points.map((p) =>
      p.id === editingPoint.id ? { ...p, [field]: typeof value === 'string' ? value : Number(value) } : p);
    onchange({ ...currentPattern, points, hasChanged: true });
  }
  function updatePiece(fn: (p: Piece) => Piece) {
    if (!editingPiece) return;
    const pieces = currentPattern.pieces.map((p) => (p.id === editingPiece.id ? fn(p) : p));
    onchange({ ...currentPattern, pieces, hasChanged: true });
  }
  function updateArrangement(field: keyof PieceArrangement, value: string | number) {
    updatePiece((p) => ({ ...p, settings3d: { ...p.settings3d, arrangement: { ...p.settings3d.arrangement, [field]: value } } }));
  }
  function selectPath(pp: PiecePath) {
    selectedPathIds.set(new Set([pp.path]));
  }
  function removeMainPath(pp: PiecePath) {
    updatePiece((p) => ({ ...p, mainPaths: p.mainPaths.filter((x) => x.id !== pp.id) }));
  }

  const sections = [
    { id: 'general', icon: 'edit', title: 'General' },
    { id: 'scaling', icon: 'open_in_full', title: 'Scaling' },
    { id: 'orientation', icon: 'explore', title: 'Orientation' },
    { id: 'seam', icon: 'select', title: 'Seam boundary' },
    { id: 'internal', icon: 'conversion_path', title: 'Internal paths' },
    { id: 'material', icon: 'texture', title: 'Material' },
    { id: '3d', icon: 'view_in_ar', title: '3D Settings' }
  ];

  // ---- pattern-level (no selection) -----------------------------------------
  let patternOpen = $state<string>('materials');
  function togglePattern(id: string) { patternOpen = patternOpen === id ? '' : id; }

  function updatePattern(partial: Partial<Pattern>) {
    onchange({ ...currentPattern, ...partial, hasChanged: true });
  }
  function updateBody(partial: Partial<Pattern['body']>) {
    updatePattern({ body: { ...currentPattern.body, ...partial } });
  }
  function updateBodyField(name: string, value: number) {
    updateBody({ fields: { ...currentPattern.body.fields, [name]: value } });
  }
  function updateSettings3D(partial: Partial<Pattern['settings3d']>) {
    updatePattern({ settings3d: { ...currentPattern.settings3d, ...partial } });
  }

  const uid = (p: string) => `${p}_${crypto.randomUUID().replace(/-/g, '').slice(0, 9)}`;
  function createMaterial() {
    const mat = {
      id: uid('mat'), name: `Material${currentPattern.materials.length + 1}`,
      frontTexture: { url: '', mediaId: null, color: '#b9b9b9', scale: 100, normalUrl: '', normalMediaId: null, normalMapScale: 100, opacityUrl: '', opacityMediaId: null, opacityMapScale: 100 },
      backTexture: null, useSeparateBackSide: false,
      stretchWarpValue: 30, stretchWeftValue: 30, bendValue: 30, thickness: 0.5, weight: 200,
      roughness: 0.8, metalness: 0, specularIntensity: 0.5, opacity: 1, normalScale: 1, alphaCutoff: 0.5,
      libraryItemId: null, libraryVersion: null, libraryUpdatedAt: null
    } as Pattern['materials'][number];
    updatePattern({ materials: [...currentPattern.materials, mat] });
  }
  function deleteMaterial(id: string) {
    updatePattern({ materials: currentPattern.materials.filter((m) => m.id !== id) });
    if (editingMaterialId === id) editingMaterialId = null;
  }

  let editingMaterialId = $state<string | null>(null);
  let linkWarpWeft = $state(true);
  type Mat = Pattern['materials'][number];
  function updateMaterial(id: string, fn: (m: Mat) => Mat) {
    updatePattern({ materials: currentPattern.materials.map((m) => (m.id === id ? fn(m) : m)) });
  }
  function setFrontTexture(id: string, partial: Partial<NonNullable<Mat['frontTexture']>>) {
    updateMaterial(id, (m) => ({ ...m, frontTexture: { ...(m.frontTexture ?? { url: '', mediaId: null, color: '#bbbbbb', scale: 100, normalUrl: '', normalMediaId: null, normalMapScale: 100, opacityUrl: '', opacityMediaId: null, opacityMapScale: 100 }), ...partial } }));
  }
  function setStretch(id: string, which: 'warp' | 'weft', value: number) {
    updateMaterial(id, (m) => ({
      ...m,
      stretchWarpValue: which === 'warp' || linkWarpWeft ? value : m.stretchWarpValue,
      stretchWeftValue: which === 'weft' || linkWarpWeft ? value : m.stretchWeftValue
    }));
  }
  function onPickImage(id: string, e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setFrontTexture(id, { url: String(reader.result), mediaId: null });
    reader.readAsDataURL(file);
  }
  function materialSwatch(m: Pattern['materials'][number]): string {
    const t = m.frontTexture;
    const color = t?.color || '#cccccc';
    return t?.url ? `background-color:${color};background-image:url('${t.url}');background-size:cover;background-position:center` : `background-color:${color}`;
  }

  // length-unit conversion for the Settings defaults (stored in mm)
  const lenUnit = $derived(currentPattern.lengthUnit);
  const toUnit = (mm: number) => (lenUnit === 'inch' ? mm / 25.4 : lenUnit === 'cm' ? mm / 10 : mm);
  const fromUnit = (v: number) => (lenUnit === 'inch' ? v * 25.4 : lenUnit === 'cm' ? v * 10 : v);
  const unitLabel = $derived(lenUnit === 'inch' ? 'in' : lenUnit);

  let selectedVariableId = $state<string | null>(null);
  const selectedVariable = $derived(currentPattern.variables.find((v) => v.id === selectedVariableId) ?? null);
  const VAR_TYPE_ICON: Record<string, string> = { number: 'tag', boolean: 'check', enum: 'list', string: 'text_fields', length: 'straighten', angle: 'rotate_right' };

  function addVariable() {
    const v = { id: uid('var'), name: 'unnamed', description: '', type: 'number', value: 0, valueFormula: { formula: '0', unit: 'none' }, isEditable: true, isVisible: true, options: [], unitType: 'length' };
    updatePattern({ variables: [...currentPattern.variables, v] as Pattern['variables'] });
    selectedVariableId = v.id;
  }
  function updateVariable(id: string, partial: Partial<Pattern['variables'][number]>) {
    updatePattern({ variables: currentPattern.variables.map((v) => (v.id === id ? { ...v, ...partial } : v)) });
  }
  function deleteVariable(id: string) {
    updatePattern({ variables: currentPattern.variables.filter((v) => v.id !== id) });
  }

  const patternSections = [
    { id: 'general', icon: 'edit', title: 'General' },
    { id: 'settings', icon: 'settings', title: 'Settings' },
    { id: '3d', icon: 'view_in_ar', title: '3D Settings' },
    { id: 'sizes', icon: 'tag', title: 'Sizes & Variables' },
    { id: 'body', icon: 'accessibility', title: 'Body' },
    { id: 'materials', icon: 'texture', title: 'Materials' }
  ];
</script>

{#snippet matSlider(label: string, value: number, min: number, max: number, step: number, oninput: (v: number) => void)}
  <label class="flex flex-col gap-0.5">
    <span class="flex justify-between"><span>{label}</span><span class="tabular-nums opacity-60">{value}</span></span>
    <input type="range" class="range range-xs" {min} {max} {step} value={value} oninput={(e) => oninput(parseFloat(e.currentTarget.value))} />
  </label>
{/snippet}

{#snippet materialEditor(m: Pattern['materials'][number])}
  <div class="border-t border-base-300 p-3 space-y-3 text-sm bg-base-100">
    <label class="flex flex-col gap-0.5">Name
      <input type="text" class="input input-bordered input-xs" value={m.name} oninput={(e) => updateMaterial(m.id, (x) => ({ ...x, name: e.currentTarget.value }))} /></label>

    <div class="space-y-1">
      <span class="font-semibold">Front side</span>
      <div class="flex items-center gap-2">
        <div class="w-12 h-12 rounded border border-base-300 shrink-0" style={materialSwatch(m)}></div>
        <div class="flex flex-col gap-1 flex-1">
          <label class="flex items-center gap-2">Color
            <input type="color" class="w-8 h-6 rounded border" value={m.frontTexture?.color ?? '#bbbbbb'} oninput={(e) => setFrontTexture(m.id, { color: e.currentTarget.value })} /></label>
          <div class="flex gap-1">
            <label class="btn btn-xs btn-outline cursor-pointer"><span class="material-symbols-rounded text-base">image</span> Image
              <input type="file" accept="image/*" class="hidden" onchange={(e) => onPickImage(m.id, e)} /></label>
            {#if m.frontTexture?.url}<button class="btn btn-xs btn-ghost" onclick={() => setFrontTexture(m.id, { url: '', mediaId: null })}><span class="material-symbols-rounded text-base">clear</span> Clear texture</button>{/if}
          </div>
        </div>
      </div>
      <label class="flex flex-col gap-0.5">Tile size (mm)
        <input type="number" step="1" class="input input-bordered input-xs" value={m.frontTexture?.scale ?? 100} oninput={(e) => setFrontTexture(m.id, { scale: parseFloat(e.currentTarget.value) || 100 })} /></label>
    </div>

    <hr class="border-base-200" />
    <div class="space-y-2">
      <span class="font-semibold">Simulation</span>
      <label class="flex items-center gap-2"><input type="checkbox" class="checkbox checkbox-xs" checked={linkWarpWeft} onchange={(e) => (linkWarpWeft = e.currentTarget.checked)} /> Link warp and weft</label>
      {@render matSlider('Stretch warp', m.stretchWarpValue, 0, 100, 1, (v) => setStretch(m.id, 'warp', v))}
      {#if !linkWarpWeft}{@render matSlider('Stretch weft', m.stretchWeftValue, 0, 100, 1, (v) => setStretch(m.id, 'weft', v))}{/if}
      {@render matSlider('Bend', m.bendValue, 0, 100, 1, (v) => updateMaterial(m.id, (x) => ({ ...x, bendValue: v })))}
      <label class="flex flex-col gap-0.5">Simulation thickness (mm)
        <input type="number" step="0.1" class="input input-bordered input-xs" value={m.thickness} oninput={(e) => updateMaterial(m.id, (x) => ({ ...x, thickness: parseFloat(e.currentTarget.value) || 0 }))} /></label>
      <label class="flex flex-col gap-0.5">Weight (g/m²)
        <input type="number" step="1" class="input input-bordered input-xs" value={m.weight} oninput={(e) => updateMaterial(m.id, (x) => ({ ...x, weight: parseFloat(e.currentTarget.value) || 0 }))} /></label>
    </div>

    <hr class="border-base-200" />
    <div class="space-y-2">
      <span class="font-semibold">Appearance</span>
      {@render matSlider('Roughness', m.roughness, 0, 1, 0.01, (v) => updateMaterial(m.id, (x) => ({ ...x, roughness: v })))}
      {@render matSlider('Metalness', m.metalness, 0, 1, 0.01, (v) => updateMaterial(m.id, (x) => ({ ...x, metalness: v })))}
      {@render matSlider('Opacity', m.opacity, 0, 1, 0.01, (v) => updateMaterial(m.id, (x) => ({ ...x, opacity: v })))}
      <label class="flex items-center gap-2"><input type="checkbox" class="checkbox checkbox-xs" checked={m.useSeparateBackSide} onchange={(e) => updateMaterial(m.id, (x) => ({ ...x, useSeparateBackSide: e.currentTarget.checked }))} /> Separate back side</label>
    </div>
  </div>
{/snippet}

{#snippet labelSetting()}
  <label class="flex flex-col gap-0.5">3D piece labels
    <select class="select select-bordered select-xs" value={labelDisplay}
      onchange={(e) => onlabeldisplaychange?.(e.currentTarget.value as 'off' | 'billboard' | 'flat')}>
      <option value="off">Off</option>
      <option value="billboard">Facing camera (billboard)</option>
      <option value="flat">Flat on fabric</option>
    </select></label>
{/snippet}

<div class="w-[340px] border-l bg-base-100 flex flex-col shrink-0 overflow-y-auto" data-tour-id="tour-properties">
  <div class="w-full bg-base-300 p-2 px-4 font-bold text-sm flex items-center sticky z-10 top-0 border-b-2 border-accent">
    <span>Properties{editingPiece ? ' for Piece' : editingPoint ? ' for Point' : ' for Pattern'}</span>
    {#if onclose}
      <button class="ml-auto pt-1" type="button" title="Close properties" aria-label="Close properties" onclick={onclose}>
        <span class="material-symbols-rounded">close</span>
      </button>
    {/if}
  </div>

  {#if editingPiece}
    {@const piece = editingPiece}
    {#each sections as s}
      {@const count = s.id === 'seam' ? piece.mainPaths.length : s.id === 'internal' ? piece.internalPaths.length : null}
      <div class="w-full bg-base-200 block mt-[-1px]" class:bg-base-300={openSection === s.id}>
        <button type="button" class="w-full flex items-center p-2 px-3 text-sm" aria-expanded={openSection === s.id} onclick={() => toggle(s.id)}>
          <span class="material-symbols-rounded mr-2">{s.icon}</span>
          <span class="text-md font-bold">{s.title}{count !== null ? ` (${count})` : ''}</span>
          <span class="material-symbols-rounded ml-auto">{openSection === s.id ? 'keyboard_arrow_down' : 'keyboard_arrow_right'}</span>
        </button>

        {#if openSection === s.id}
          <div class="w-full bg-base-100 border-t border-base-300 p-3 pt-2 text-sm space-y-2">
            {#if s.id === 'general'}
              <label class="flex flex-col gap-0.5">Name
                <input type="text" class="input input-bordered input-xs" value={piece.name}
                  oninput={(e) => updatePiece((p) => ({ ...p, name: e.currentTarget.value }))} /></label>
              <p class="opacity-70">Type: {piece.type}</p>
              <label class="flex items-center gap-2"><input type="checkbox" class="checkbox checkbox-xs" checked={piece.mirrorX}
                onchange={(e) => updatePiece((p) => ({ ...p, mirrorX: e.currentTarget.checked }))} /> Mirror X</label>
              <label class="flex items-center gap-2"><input type="checkbox" class="checkbox checkbox-xs" checked={piece.mirrorY}
                onchange={(e) => updatePiece((p) => ({ ...p, mirrorY: e.currentTarget.checked }))} /> Mirror Y</label>

            {:else if s.id === 'scaling'}
              <label class="flex items-center gap-2"><input type="checkbox" class="checkbox checkbox-xs" checked={piece.seamAllowanceInside}
                onchange={(e) => updatePiece((p) => ({ ...p, seamAllowanceInside: e.currentTarget.checked }))} /> Seam allowance inside</label>
              <p class="opacity-70">Pattern seam allowance: {(currentPattern.seamAllowance / 25.4).toFixed(2)} in</p>

            {:else if s.id === 'orientation'}
              <label class="flex flex-col gap-0.5">Rotation (°)
                <input type="number" class="input input-bordered input-xs" value={piece.rotation} step="1"
                  oninput={(e) => updatePiece((p) => ({ ...p, rotation: parseFloat(e.currentTarget.value) || 0 }))} /></label>
              <div class="grid grid-cols-2 gap-1">
                <label>Grain X<input type="number" step="0.1" class="input input-bordered input-xs w-full" value={piece.grainVector.x}
                  oninput={(e) => updatePiece((p) => ({ ...p, grainVector: { ...p.grainVector, x: parseFloat(e.currentTarget.value) || 0 } }))} /></label>
                <label>Grain Y<input type="number" step="0.1" class="input input-bordered input-xs w-full" value={piece.grainVector.y}
                  oninput={(e) => updatePiece((p) => ({ ...p, grainVector: { ...p.grainVector, y: parseFloat(e.currentTarget.value) || 0 } }))} /></label>
              </div>

            {:else if s.id === 'seam' || s.id === 'internal'}
              {@const list = s.id === 'seam' ? piece.mainPaths : piece.internalPaths}
              <div class="flex flex-col">
                {#each list as pp}
                  <div class="rounded-md border my-0.5 flex items-center px-2 py-1 gap-1"
                    class:border-accent={$selectedPathIds.has(pp.path)} class:border-base-200={!$selectedPathIds.has(pp.path)}>
                    <button class="font-bold text-sm cursor-pointer hover:text-accent text-left" onclick={() => selectPath(pp)}>{pathName(pp.path)}</button>
                    <span class="mx-1 text-xs opacity-70">({pointName(pp.from)} → {pointName(pp.to)})</span>
                    <div class="flex items-center ml-auto gap-1">
                      <button class="material-symbols-rounded text-base opacity-60" title="Condition">calculate</button>
                      <button class="material-symbols-rounded text-base opacity-60 hover:text-error" title="Remove" onclick={() => removeMainPath(pp)}>delete</button>
                    </div>
                  </div>
                {:else}
                  <p class="opacity-60">No {s.id === 'seam' ? 'boundary' : 'internal'} paths.</p>
                {/each}
              </div>

            {:else if s.id === 'material'}
              <label class="flex flex-col gap-0.5">Fabric
                <select class="select select-bordered select-xs" value={piece.materialId}
                  onchange={(e) => updatePiece((p) => ({ ...p, materialId: e.currentTarget.value }))}>
                  <option value="">None</option>
                  {#each currentPattern.materials as mat}<option value={mat.id}>{mat.name}</option>{/each}
                </select></label>

            {:else if s.id === '3d'}
              <label class="flex flex-col gap-0.5">Cylinder
                <input type="text" class="input input-bordered input-xs" value={piece.settings3d.arrangement.cylinderName}
                  oninput={(e) => updateArrangement('cylinderName', e.currentTarget.value)} /></label>
              <div class="grid grid-cols-2 gap-1">
                <label>u°<input type="number" class="input input-bordered input-xs w-full" value={piece.settings3d.arrangement.uDegrees}
                  oninput={(e) => updateArrangement('uDegrees', parseFloat(e.currentTarget.value) || 0)} /></label>
                <label>v<input type="number" step="0.05" class="input input-bordered input-xs w-full" value={piece.settings3d.arrangement.v}
                  oninput={(e) => updateArrangement('v', parseFloat(e.currentTarget.value) || 0)} /></label>
              </div>
              <label class="flex items-center gap-2"><input type="checkbox" class="checkbox checkbox-xs" checked={piece.settings3d.frozen}
                onchange={(e) => updatePiece((p) => ({ ...p, settings3d: { ...p.settings3d, frozen: e.currentTarget.checked } }))} /> Frozen (pinned)</label>
              <hr class="border-base-200" />
              {@render labelSetting()}
            {/if}
          </div>
        {/if}
      </div>
    {/each}

  {:else if editingPoint}
    <div class="p-3 space-y-2 text-sm">
      <h4 class="font-semibold text-accent">Point: {editingPoint.name}</h4>
      <label class="flex flex-col gap-0.5">Name
        <input type="text" class="input input-bordered input-xs" value={editingPoint.name} oninput={(e) => updatePoint('name', e.currentTarget.value)} /></label>
      <label class="flex flex-col gap-0.5">X (mm)
        <input type="number" class="input input-bordered input-xs" value={editingPoint.x} oninput={(e) => updatePoint('x', parseFloat(e.currentTarget.value) || 0)} step="0.1" /></label>
      <label class="flex flex-col gap-0.5">Y (mm)
        <input type="number" class="input input-bordered input-xs" value={editingPoint.y} oninput={(e) => updatePoint('y', parseFloat(e.currentTarget.value) || 0)} step="0.1" /></label>
    </div>

  {:else}
    {#each patternSections as s}
      <div class="w-full bg-base-200 block mt-[-1px]" class:bg-base-300={patternOpen === s.id}>
        <button type="button" class="w-full flex items-center p-2 px-3 text-sm" aria-expanded={patternOpen === s.id} onclick={() => togglePattern(s.id)}>
          <span class="material-symbols-rounded mr-2">{s.icon}</span>
          <span class="text-md font-bold">{s.title}{s.id === 'materials' ? ` (${currentPattern.materials.length})` : ''}</span>
          <span class="material-symbols-rounded ml-auto">{patternOpen === s.id ? 'keyboard_arrow_down' : 'keyboard_arrow_right'}</span>
        </button>
        {#if patternOpen === s.id}
          <div class="w-full bg-base-100 border-t border-base-300 p-3 pt-2 text-sm space-y-2">
            {#if s.id === 'general'}
              <label class="flex flex-col gap-0.5">Name
                <input type="text" class="input input-bordered input-xs" value={currentPattern.name} oninput={(e) => updatePattern({ name: e.currentTarget.value })} /></label>
              <label class="flex flex-col gap-0.5">Description
                <textarea class="textarea textarea-bordered textarea-xs" rows="2" oninput={(e) => updatePattern({ description: e.currentTarget.value })}>{currentPattern.description}</textarea></label>
              <div class="grid grid-cols-2 gap-1">
                <label>Length unit
                  <select class="select select-bordered select-xs w-full" value={currentPattern.lengthUnit} onchange={(e) => updatePattern({ lengthUnit: e.currentTarget.value as Pattern['lengthUnit'] })}>
                    <option value="inch">inch</option><option value="cm">cm</option><option value="mm">mm</option></select></label>
                <label>Angle unit
                  <select class="select select-bordered select-xs w-full" value={currentPattern.angleUnit} onchange={(e) => updatePattern({ angleUnit: e.currentTarget.value as Pattern['angleUnit'] })}>
                    <option value="degrees">degrees</option><option value="radians">radians</option></select></label>
              </div>
              <label class="flex items-center gap-2"><input type="checkbox" class="checkbox checkbox-xs" checked={currentPattern.isPublic} onchange={(e) => updatePattern({ isPublic: e.currentTarget.checked })} /> Public</label>

            {:else if s.id === 'settings'}
              <label class="flex flex-col gap-0.5">Default length unit
                <select class="select select-bordered select-xs" value={currentPattern.lengthUnit} onchange={(e) => updatePattern({ lengthUnit: e.currentTarget.value as Pattern['lengthUnit'] })}>
                  <option value="cm">Centimeters</option><option value="mm">Millimeters</option><option value="inch">Inches</option></select></label>
              <label class="flex flex-col gap-0.5">Default seam allowance
                <span class="flex items-center gap-2"><input type="number" step="0.1" class="input input-bordered input-xs w-20" value={toUnit(currentPattern.seamAllowance).toFixed(2)} oninput={(e) => updatePattern({ seamAllowance: fromUnit(parseFloat(e.currentTarget.value) || 0) })} /><span class="opacity-60">{unitLabel}</span></span></label>
              <div class="flex items-end gap-2">
                <label class="flex flex-col gap-0.5 flex-1">Default point labeling
                  <select class="select select-bordered select-xs" value={currentPattern.pointLabeling} onchange={(e) => updatePattern({ pointLabeling: e.currentTarget.value })}>
                    <option value="numeric">Numeric (0, 1, 2...)</option><option value="alphabetic">Alphabetic (A, B, C...)</option></select></label>
                <label class="flex flex-col gap-0.5 w-16">Prefix
                  <input type="text" class="input input-bordered input-xs" value={currentPattern.pointPrefix} oninput={(e) => updatePattern({ pointPrefix: e.currentTarget.value })} /></label>
              </div>
              <label class="flex flex-col gap-0.5">Default notch size
                <span class="flex items-center gap-2"><input type="number" step="0.1" class="input input-bordered input-xs w-20" value={toUnit(currentPattern.defaultNotchSize).toFixed(2)} oninput={(e) => updatePattern({ defaultNotchSize: fromUnit(parseFloat(e.currentTarget.value) || 0) })} /><span class="opacity-60">{unitLabel}</span></span></label>
              <hr class="border-base-200" />
              <label class="flex items-center gap-2"><input type="checkbox" class="checkbox checkbox-xs" checked={currentPattern.showGrid} onchange={(e) => updatePattern({ showGrid: e.currentTarget.checked })} /> Show grid</label>
              <label class="flex items-center gap-2"><input type="checkbox" class="checkbox checkbox-xs" checked={currentPattern.snapToGrid} onchange={(e) => updatePattern({ snapToGrid: e.currentTarget.checked })} /> Snap to grid</label>
              <label class="flex items-center gap-2"><input type="checkbox" class="checkbox checkbox-xs" checked={currentPattern.showPieceNames} onchange={(e) => updatePattern({ showPieceNames: e.currentTarget.checked })} /> Show piece names</label>

            {:else if s.id === '3d'}
              <label class="flex items-center gap-2"><input type="checkbox" class="checkbox checkbox-xs" checked={currentPattern.enable3d} onchange={(e) => updatePattern({ enable3d: e.currentTarget.checked })} /> Enable 3D</label>
              <label class="flex items-center gap-2"><input type="checkbox" class="checkbox checkbox-xs" checked={currentPattern.settings3d.showAvatar} onchange={(e) => updateSettings3D({ showAvatar: e.currentTarget.checked })} /> Show avatar</label>
              <label class="flex items-center gap-2"><input type="checkbox" class="checkbox checkbox-xs" checked={currentPattern.settings3d.showSeams} onchange={(e) => updateSettings3D({ showSeams: e.currentTarget.checked })} /> Show seams (3D)</label>
              <label class="flex flex-col gap-0.5">Lighting
                <select class="select select-bordered select-xs" value={currentPattern.settings3d.lightingMode} onchange={(e) => updateSettings3D({ lightingMode: e.currentTarget.value })}>
                  {#each ['flat', 'hdri', 'studio1', 'studio2', 'sunset'] as m}<option value={m}>{m}</option>{/each}</select></label>
              {@render labelSetting()}

            {:else if s.id === 'sizes'}
              <!-- Sizes -->
              <h6 class="border-b-2 border-base-200 font-semibold pb-1">Sizes</h6>
              <div class="flex items-center gap-2">
                <select class="select select-bordered select-xs flex-1" value={currentPattern.currentSize} onchange={(e) => updatePattern({ currentSize: e.currentTarget.value })}>
                  <option value="">Custom</option>
                </select>
                <button class="btn btn-xs btn-primary" onclick={addVariable}>Create a size…</button>
              </div>

              <!-- Variables -->
              <h6 class="border-b-2 border-base-200 font-semibold pb-1 mt-3">Variables</h6>
              <div class="border border-base-200 rounded-md bg-base-100 max-h-40 overflow-y-auto">
                <ul>
                  {#each currentPattern.variables as v}
                    <li class="w-full flex items-center" class:bg-base-300={selectedVariableId === v.id}>
                      <span class="material-symbols-rounded px-1 opacity-40 cursor-grab text-base">drag_handle</span>
                      <button class="flex items-center gap-1 p-1 w-full text-left" onclick={() => (selectedVariableId = v.id)}>
                        <span class="material-symbols-rounded text-base">{VAR_TYPE_ICON[v.type] ?? 'tag'}</span>
                        <span class="truncate">{v.name || 'unnamed'}</span>
                      </button>
                    </li>
                  {:else}<li class="p-2 opacity-60">No variables.</li>{/each}
                </ul>
              </div>
              <div class="flex gap-2">
                <button class="btn btn-sm btn-error flex-1" disabled={!selectedVariable} onclick={() => { if (selectedVariableId) { deleteVariable(selectedVariableId); selectedVariableId = null; } }}>Remove</button>
                <button class="btn btn-sm btn-primary flex-1" onclick={addVariable}>Add</button>
              </div>

              {#if selectedVariable}
                {@const v = selectedVariable}
                <div class="border-t border-base-200 pt-2 mt-1 space-y-2">
                  <label class="flex flex-col gap-0.5">Name
                    <input class="input input-bordered input-sm" value={v.name} oninput={(e) => updateVariable(v.id, { name: e.currentTarget.value })} /></label>
                  <label class="flex flex-col gap-0.5">Description
                    <input class="input input-bordered input-sm" placeholder="Add notes about how this variable is used" value={v.description ?? ''} oninput={(e) => updateVariable(v.id, { description: e.currentTarget.value })} /></label>
                  <div class="flex flex-col gap-0.5">
                    <span>Behavior</span>
                    <label class="flex items-center gap-2"><input type="checkbox" class="checkbox checkbox-primary checkbox-sm" checked={v.isEditable} onchange={(e) => updateVariable(v.id, { isEditable: e.currentTarget.checked })} /> Is editable</label>
                    <label class="flex items-center gap-2"><input type="checkbox" class="checkbox checkbox-primary checkbox-sm" checked={v.isVisible} onchange={(e) => updateVariable(v.id, { isVisible: e.currentTarget.checked })} /> Is visible</label>
                  </div>
                  <label class="flex flex-col gap-0.5">Type
                    <select class="select select-bordered select-sm" value={v.type} onchange={(e) => updateVariable(v.id, { type: e.currentTarget.value })}>
                      <option value="number">Number</option><option value="boolean">Boolean</option><option value="enum">Enum</option><option value="string">String</option></select></label>
                  <label class="flex flex-col gap-0.5">Value
                    <span class="flex items-center gap-2">
                      <input type="number" class="input input-bordered input-sm flex-1" value={v.value ?? 0} oninput={(e) => updateVariable(v.id, { value: parseFloat(e.currentTarget.value) || 0, valueFormula: { ...v.valueFormula, formula: e.currentTarget.value } })} />
                      <select class="select select-bordered select-sm w-16" value={v.valueFormula?.unit ?? 'none'} onchange={(e) => updateVariable(v.id, { valueFormula: { ...v.valueFormula, unit: e.currentTarget.value } })}>
                        <option value="none">none</option><option value="cm">cm</option><option value="mm">mm</option><option value="inch">in</option><option value="percent">%</option><option value="degrees">°</option></select>
                    </span></label>
                </div>
              {/if}

            {:else if s.id === 'body'}
              <div class="grid grid-cols-2 gap-1">
                <label>Gender
                  <select class="select select-bordered select-xs w-full" value={currentPattern.body.gender} onchange={(e) => updateBody({ gender: e.currentTarget.value })}>
                    <option value="female">female</option><option value="male">male</option></select></label>
                <label>Units
                  <select class="select select-bordered select-xs w-full" value={currentPattern.body.unitType} onchange={(e) => updateBody({ unitType: e.currentTarget.value })}>
                    <option value="imperial">imperial</option><option value="metric">metric</option></select></label>
              </div>
              {#each Object.entries(currentPattern.body.fields) as [name, value]}
                <label class="flex items-center gap-2"><span class="flex-1 capitalize">{name}</span>
                  <input type="number" step="0.1" class="input input-bordered input-xs w-20" value={value} oninput={(e) => updateBodyField(name, parseFloat(e.currentTarget.value) || 0)} /></label>
              {/each}

            {:else if s.id === 'materials'}
              <div class="flex flex-col gap-2 w-full">
                {#each currentPattern.materials as m}
                  <div class="rounded-md border" class:border-accent={editingMaterialId === m.id} class:border-base-300={editingMaterialId !== m.id}>
                    <div class="flex items-center gap-3 p-2 hover:bg-base-200/50">
                      <div class="w-10 h-10 rounded border border-base-300 shrink-0" aria-label="Material preview" style={materialSwatch(m)}></div>
                      <div class="flex flex-col flex-1 leading-tight min-w-0">
                        <span class="font-medium truncate">{m.name}</span>
                        <span class="text-[11px] text-base-content/60 flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-base-300"></span> Local material</span>
                      </div>
                      <button class="btn btn-ghost btn-xs p-1" title="Edit material" aria-label="Edit material" onclick={() => (editingMaterialId = editingMaterialId === m.id ? null : m.id)}><span class="material-symbols-rounded text-base">{editingMaterialId === m.id ? 'expand_less' : 'edit'}</span></button>
                      <button class="btn btn-ghost btn-xs p-1 text-error" title="Delete material" aria-label="Delete material" onclick={() => deleteMaterial(m.id)}><span class="material-symbols-rounded text-base">delete</span></button>
                    </div>
                    {#if editingMaterialId === m.id}
                      {@render materialEditor(m)}
                    {/if}
                  </div>
                {:else}<p class="opacity-60">No materials yet.</p>{/each}
                <div class="grid grid-cols-2 gap-2 mt-1">
                  <button class="btn btn-sm btn-primary" onclick={createMaterial}><span class="material-symbols-rounded text-base">add</span> Create material</button>
                  <button class="btn btn-sm btn-secondary" title="Pick a material from your library"><span class="material-symbols-rounded text-base">library_add</span> Add from library</button>
                </div>
              </div>
            {/if}
          </div>
        {/if}
      </div>
    {/each}
  {/if}
</div>
