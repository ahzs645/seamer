<script lang="ts">
  import type { Pattern, ConstrainablePoint, ConstrainablePath, Piece, PieceArrangement, PiecePath, GradeSize, PointConstraint } from '$lib/types/pattern';
  import { selectedPointIds, selectedPathIds, selectedPieceIds } from '$lib/stores/pattern';
  import FormulaDialog from '$lib/components/FormulaDialog.svelte';
  import { toastSuccess, toastError } from '$lib/stores/toast';

  interface Props {
    currentPattern: Pattern;
    onchange: (p: Pattern) => void;
    onclose?: () => void;
    labelDisplay?: 'off' | 'billboard' | 'flat';
    onlabeldisplaychange?: (v: 'off' | 'billboard' | 'flat') => void;
    ongrading?: () => void;
    onalterations?: () => void;
  }

  let { currentPattern, onchange, onclose, labelDisplay = 'flat', onlabeldisplaychange, ongrading, onalterations }: Props = $props();

  const editingPoint = $derived<ConstrainablePoint | null>(
    $selectedPointIds.size === 1 ? currentPattern.points.find((p) => p.id === [...$selectedPointIds][0]) ?? null : null
  );
  const editingPiece = $derived<Piece | null>(
    $selectedPieceIds.size === 1 ? currentPattern.pieces.find((p) => p.id === [...$selectedPieceIds][0]) ?? null : null
  );

  // A single selected boundary edge (its ConstrainablePath + two endpoints). Clicking a line in the
  // 2D view selects it; this lets you retype the edge's length/angle (moves the `to` point in
  // drafting space so the edge takes the requested length/angle relative to `from`).
  const editingEdge = $derived.by<{ path: ConstrainablePath; from: ConstrainablePoint; to: ConstrainablePoint } | null>(() => {
    if ($selectedPathIds.size !== 1) return null;
    const pathId = [...$selectedPathIds][0];
    const path = currentPattern.paths.find((p) => p.id === pathId);
    if (!path) return null;
    const byId = (id: string) => currentPattern.points.find((q) => q.id === id) ?? null;
    for (const piece of currentPattern.pieces) {
      if ($selectedPieceIds.size > 0 && !$selectedPieceIds.has(piece.id)) continue;
      const pp = [...piece.mainPaths, ...piece.internalPaths].find((x) => x.path === pathId);
      if (pp) { const from = byId(pp.from), to = byId(pp.to); if (from && to) return { path, from, to }; }
    }
    const pts = path.pathPoints;
    if (pts.length >= 2) { const from = byId(pts[0].id), to = byId(pts[pts.length - 1].id); if (from && to) return { path, from, to }; }
    return null;
  });
  const edgeLenMm = $derived(editingEdge ? Math.hypot(editingEdge.to.x - editingEdge.from.x, editingEdge.to.y - editingEdge.from.y) : 0);
  const edgeAngleDeg = $derived(editingEdge ? (Math.atan2(editingEdge.to.y - editingEdge.from.y, editingEdge.to.x - editingEdge.from.x) * 180) / Math.PI : 0);
  const edgeUnit = $derived(currentPattern.lengthUnit);
  const edgeToDisp = (mm: number) => (edgeUnit === 'inch' ? mm / 25.4 : edgeUnit === 'cm' ? mm / 10 : mm);
  const edgeToMm = (v: number) => (edgeUnit === 'inch' ? v * 25.4 : edgeUnit === 'cm' ? v * 10 : v);
  // Which endpoint stays fixed while editing. 'from' (default) moves `to`; 'to' moves `from`.
  // The displayed length/angle always describe the from→to vector, so the angle field reads the
  // same regardless of pivot — flipping the pivot just chooses which end the edit rotates around.
  let edgePivot = $state<'from' | 'to'>('from');
  function edgeMove(lenMm: number, angDeg: number) {
    if (!editingEdge || !(lenMm > 0)) return;
    const rad = (angDeg * Math.PI) / 180;
    const dx = Math.cos(rad) * lenMm, dy = Math.sin(rad) * lenMm;
    let moveId: string, nx: number, ny: number;
    if (edgePivot === 'from') {
      moveId = editingEdge.to.id; nx = editingEdge.from.x + dx; ny = editingEdge.from.y + dy;
    } else {
      moveId = editingEdge.from.id; nx = editingEdge.to.x - dx; ny = editingEdge.to.y - dy;
    }
    const points = currentPattern.points.map((p) => (p.id === moveId ? { ...p, x: nx, y: ny } : p));
    onchange({ ...currentPattern, points, hasChanged: true });
  }

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
  function setConstraint(c: PointConstraint | undefined) {
    if (!editingPoint) return;
    const points = currentPattern.points.map((p) => (p.id === editingPoint.id ? { ...p, constraint: c } : p));
    onchange({ ...currentPattern, points, hasChanged: true });
  }
  function changeConstraintType(type: string) {
    const others = currentPattern.points.filter((p) => p.id !== editingPoint?.id);
    const from = others[0]?.id ?? '';
    const path = currentPattern.paths[0]?.id ?? '';
    if (type === 'fixed') setConstraint(undefined);
    else if (type === 'offset') setConstraint({ type: 'offset', from, dxFormula: '0', dyFormula: '0' });
    else if (type === 'lengthAngle') setConstraint({ type: 'lengthAngle', from, lengthFormula: '0', angleFormula: '0' });
    else if (type === 'sliding') setConstraint({ type: 'sliding', path, positionFormula: '0' });
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
  // Mark a boundary edge as the piece's mirror/fold line: the cloth is reflected across it for a
  // symmetric whole (drafted as a half). One mirror line per piece, so enabling clears the others.
  function toggleMirrorLine(pp: PiecePath) {
    const enabling = !pp.isMirrorLine;
    updatePiece((p) => ({ ...p, mainPaths: p.mainPaths.map((x) =>
      x.id === pp.id ? { ...x, isMirrorLine: enabling } : (enabling ? { ...x, isMirrorLine: false } : x)) }));
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

  // ---- Edge symmetry: mirror the selected edge across a chosen axis path ----
  let mirrorAxisId = $state('');
  // candidate axes: any other path with at least two points
  const axisCandidates = $derived(
    !editingEdge ? [] : currentPattern.paths.filter((p) => p.id !== editingEdge.path.id && p.pathPoints.length >= 2)
  );
  function reflectPt(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy || 1;
    const t = ((px - ax) * dx + (py - ay) * dy) / len2;
    const projx = ax + t * dx, projy = ay + t * dy;
    return { x: 2 * projx - px, y: 2 * projy - py };
  }
  function createMirror() {
    if (!editingEdge) return;
    const src = editingEdge.path;
    const axis = currentPattern.paths.find((p) => p.id === mirrorAxisId);
    if (!axis || axis.pathPoints.length < 2) { toastError('Pick an axis path with at least two points'); return; }
    const ptById = new Map(currentPattern.points.map((p) => [p.id, p]));
    const a = ptById.get(axis.pathPoints[0].id);
    const b = ptById.get(axis.pathPoints[axis.pathPoints.length - 1].id);
    if (!a || !b) { toastError('Axis endpoints not found'); return; }
    const newPoints: ConstrainablePoint[] = [];
    const newPathPoints: ConstrainablePath['pathPoints'] = [];
    for (const pp of src.pathPoints) {
      const sp = ptById.get(pp.id);
      if (!sp) continue;
      const r = reflectPt(sp.x, sp.y, a.x, a.y, b.x, b.y);
      const id = uid('Point');
      // explicit mirror constraint → solvePoints resolves it as reflect(source, axis ends) parametrically
      newPoints.push({ id, name: `${sp.name}'`, x: r.x, y: r.y, layerId: sp.layerId, constraint: { type: 'mirror', source: sp.id, axisPath: axis.id } });
      // reflect bezier handles too (a reflection reverses orientation → swap in/out tangents)
      let handle = pp.handle;
      if (pp.handle) {
        const h = pp.handle;
        const m1 = reflectPt(sp.x + h.v2.x, sp.y + h.v2.y, a.x, a.y, b.x, b.y);
        const m2 = reflectPt(sp.x + h.v1.x, sp.y + h.v1.y, a.x, a.y, b.x, b.y);
        handle = { ...h, v1: { x: m1.x - r.x, y: m1.y - r.y }, v2: { x: m2.x - r.x, y: m2.y - r.y } };
      }
      newPathPoints.push({ id, handle });
    }
    if (newPathPoints.length < 2) { toastError('Edge has too few points to mirror'); return; }
    const newPath: ConstrainablePath = {
      id: uid('Path'), name: `${src.name || 'Edge'} (mirror)`, layerId: src.layerId,
      pathType: 'referenced', pathPoints: newPathPoints, version: 1,
      referencedPath: src.id, mirrorLine: axis.id,
      referencedFromPoint: src.pathPoints[0]?.id, referencedToPoint: src.pathPoints[src.pathPoints.length - 1]?.id
    };
    onchange({ ...currentPattern, points: [...currentPattern.points, ...newPoints], paths: [...currentPattern.paths, newPath], hasChanged: true });
    toastSuccess(`Mirrored "${src.name || 'edge'}" across "${axis.name || 'axis'}"`);
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
  let formulaVarId = $state<string | null>(null);
  // scope offered to the formula editor: other variables + body measurements
  const formulaScope = $derived([
    ...currentPattern.variables.filter((v) => v.id !== formulaVarId).map((v) => ({ name: v.name, value: v.value ?? 0 })),
    ...Object.entries(currentPattern.body.fields).map(([name, value]) => ({ name, value }))
  ]);
  const selectedVariable = $derived(currentPattern.variables.find((v) => v.id === selectedVariableId) ?? null);
  const VAR_TYPE_ICON: Record<string, string> = { number: 'tag', boolean: 'check', enum: 'list', string: 'text_fields', length: 'straighten', angle: 'rotate_right' };

  // ---- graded sizes ---------------------------------------------------------
  const SIZE_COLORS = ['#c91d1d', '#1d4ed8', '#15803d', '#a21caf', '#ea580c', '#0891b2'];
  const sizes = $derived(currentPattern.gradingProfile?.sizes ?? []);
  // Merge into the existing profile so alteration tracks / anchors aren't dropped.
  function setSizes(next: Partial<Pattern['gradingProfile'] & object>) {
    updatePattern({ gradingProfile: { ...(currentPattern.gradingProfile ?? { sizes: [] }), ...next } });
  }
  function addSize() {
    const list = sizes;
    const size = { id: uid('size'), name: `Size ${list.length + 1}`, scale: 1 + list.length * 0.05, color: SIZE_COLORS[list.length % SIZE_COLORS.length] };
    setSizes({ sizes: [...list, size] });
  }
  function updateSize(id: string, partial: Partial<GradeSize>) {
    setSizes({ sizes: sizes.map((s) => (s.id === id ? { ...s, ...partial } : s)) });
  }
  function removeSize(id: string) { setSizes({ sizes: sizes.filter((s) => s.id !== id) }); }

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
    <span>Properties{editingEdge ? ' for Edge' : editingPiece ? ' for Piece' : editingPoint ? ' for Point' : ' for Pattern'}</span>
    {#if onclose}
      <button class="ml-auto pt-1" type="button" title="Close properties" aria-label="Close properties" onclick={onclose}>
        <span class="material-symbols-rounded">close</span>
      </button>
    {/if}
  </div>

  {#if editingEdge}
    {@const ed = editingEdge}
    <div class="bg-base-100 border-b-2 border-accent p-3 space-y-2 text-sm">
      <h4 class="font-semibold text-accent flex items-center gap-1">
        <span class="material-symbols-rounded text-base">straighten</span>
        Edge: {ed.path.name || ed.path.id.slice(0, 8)}
      </h4>
      <p class="text-xs opacity-60">{ed.from.name} → {ed.to.name}{ed.path.pathType === 'curve' ? ' · curve (edits the chord)' : ''}</p>
      <div class="flex flex-col gap-0.5">
        <span class="text-xs opacity-70">Pivot (this end stays fixed)</span>
        <div class="join" data-testid="edge-pivot">
          <button class="join-item btn btn-xs flex-1" class:btn-active={edgePivot === 'from'} onclick={() => (edgePivot = 'from')}>{ed.from.name}</button>
          <button class="join-item btn btn-xs flex-1" class:btn-active={edgePivot === 'to'} onclick={() => (edgePivot = 'to')}>{ed.to.name}</button>
        </div>
      </div>
      <label class="flex flex-col gap-0.5">Length ({edgeUnit})
        <input type="number" step="0.1" class="input input-bordered input-xs"
          value={edgeToDisp(edgeLenMm).toFixed(2)}
          onchange={(e) => edgeMove(edgeToMm(parseFloat(e.currentTarget.value) || 0), edgeAngleDeg)} /></label>
      <label class="flex flex-col gap-0.5">Angle (°)
        <input type="number" step="0.5" class="input input-bordered input-xs"
          value={edgeAngleDeg.toFixed(2)}
          onchange={(e) => edgeMove(edgeLenMm, parseFloat(e.currentTarget.value) || 0)} /></label>
      <div class="flex gap-1">
        <button class="btn btn-xs flex-1" title="Rotate -1°" onclick={() => edgeMove(edgeLenMm, edgeAngleDeg - 1)}>−1°</button>
        <button class="btn btn-xs flex-1" title="Rotate -0.1°" onclick={() => edgeMove(edgeLenMm, edgeAngleDeg - 0.1)}>−0.1°</button>
        <button class="btn btn-xs flex-1" title="Rotate +0.1°" onclick={() => edgeMove(edgeLenMm, edgeAngleDeg + 0.1)}>+0.1°</button>
        <button class="btn btn-xs flex-1" title="Rotate +1°" onclick={() => edgeMove(edgeLenMm, edgeAngleDeg + 1)}>+1°</button>
      </div>
      <p class="text-[11px] opacity-50">Edits move <b>{edgePivot === 'from' ? ed.to.name : ed.from.name}</b> around the pivot <b>{edgePivot === 'from' ? ed.from.name : ed.to.name}</b>. Shared points reshape the adjoining edge too.</p>

      <div class="border-t border-base-200 pt-2 space-y-1">
        <span class="text-xs font-semibold flex items-center gap-1"><span class="material-symbols-rounded text-sm">flip</span>Mirror across an axis</span>
        {#if axisCandidates.length === 0}
          <p class="text-[11px] opacity-50">Draw another line to use as the mirror axis, then select this edge again.</p>
        {:else}
          <select class="select select-bordered select-xs w-full" value={mirrorAxisId} onchange={(e) => (mirrorAxisId = e.currentTarget.value)}>
            <option value="">Choose axis line…</option>
            {#each axisCandidates as ax}<option value={ax.id}>{ax.name || ax.id.slice(0, 8)}</option>{/each}
          </select>
          <button class="btn btn-xs btn-primary btn-block" disabled={!mirrorAxisId} onclick={createMirror}>Create mirrored edge</button>
          <p class="text-[11px] opacity-50">Adds a referenced edge whose points stay reflected across the axis (a parametric symmetry constraint).</p>
        {/if}
      </div>
    </div>
  {/if}

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
                      {#if s.id === 'seam'}
                        <button class="material-symbols-rounded text-base" class:text-error={pp.isMirrorLine} class:opacity-60={!pp.isMirrorLine}
                          title={pp.isMirrorLine ? 'Mirror/fold line (on) — cloth reflects across this edge' : 'Mark as mirror/fold line'}
                          onclick={() => toggleMirrorLine(pp)}>flip</button>
                      {/if}
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
              <label class="flex items-center gap-2"><input type="checkbox" class="checkbox checkbox-xs" checked={piece.settings3d.flipNormals}
                onchange={(e) => updatePiece((p) => ({ ...p, settings3d: { ...p.settings3d, flipNormals: e.currentTarget.checked } }))} /> Flip cloth normals</label>
              <label class="flex items-center gap-2"><input type="checkbox" class="checkbox checkbox-xs" checked={piece.settings3d.filterExternalCollisionsByClothNormal}
                onchange={(e) => updatePiece((p) => ({ ...p, settings3d: { ...p.settings3d, filterExternalCollisionsByClothNormal: e.currentTarget.checked } }))} /> Body collision by normal</label>
              <label class="flex items-center justify-between gap-2">Collision layer
                <input type="number" min="0" step="1" class="input input-bordered input-xs w-16" value={piece.settings3d.collisionLayer}
                  oninput={(e) => updatePiece((p) => ({ ...p, settings3d: { ...p.settings3d, collisionLayer: Math.max(0, parseInt(e.currentTarget.value) || 0) } }))} /></label>
              <hr class="border-base-200" />
              {@render labelSetting()}
            {/if}
          </div>
        {/if}
      </div>
    {/each}

  {:else if editingPoint}
    {@const ep = editingPoint}
    {@const cn = ep.constraint}
    <div class="p-3 space-y-2 text-sm">
      <h4 class="font-semibold text-accent">Point: {ep.name}</h4>
      <label class="flex flex-col gap-0.5">Name
        <input type="text" class="input input-bordered input-xs" value={ep.name} oninput={(e) => updatePoint('name', e.currentTarget.value)} /></label>
      <div class="grid grid-cols-2 gap-1">
        <label>X (mm)<input type="number" class="input input-bordered input-xs w-full" value={ep.x.toFixed(1)} disabled={!!cn} oninput={(e) => updatePoint('x', parseFloat(e.currentTarget.value) || 0)} step="0.1" /></label>
        <label>Y (mm)<input type="number" class="input input-bordered input-xs w-full" value={ep.y.toFixed(1)} disabled={!!cn} oninput={(e) => updatePoint('y', parseFloat(e.currentTarget.value) || 0)} step="0.1" /></label>
      </div>

      <hr class="border-base-200" />
      <h5 class="font-semibold">Construction</h5>
      <label class="flex flex-col gap-0.5">Type
        <select class="select select-bordered select-xs" value={cn?.type ?? 'fixed'} onchange={(e) => changeConstraintType(e.currentTarget.value)}>
          <option value="fixed">Fixed (x, y)</option>
          <option value="offset">Offset from point (dx, dy)</option>
          <option value="lengthAngle">Length &amp; angle from point</option>
          <option value="sliding">Sliding along path</option>
        </select></label>

      {#if cn?.type === 'offset' || cn?.type === 'lengthAngle'}
        <label class="flex flex-col gap-0.5">From point
          <select class="select select-bordered select-xs" value={cn.from} onchange={(e) => setConstraint({ ...cn, from: e.currentTarget.value })}>
            {#each currentPattern.points.filter((p) => p.id !== ep.id) as op}<option value={op.id}>{op.name}</option>{/each}
          </select></label>
      {/if}
      {#if cn?.type === 'offset'}
        <label class="flex flex-col gap-0.5">dx (formula, mm)<input class="input input-bordered input-xs font-mono" value={cn.dxFormula} oninput={(e) => setConstraint({ ...cn, dxFormula: e.currentTarget.value })} /></label>
        <label class="flex flex-col gap-0.5">dy (formula, mm)<input class="input input-bordered input-xs font-mono" value={cn.dyFormula} oninput={(e) => setConstraint({ ...cn, dyFormula: e.currentTarget.value })} /></label>
      {:else if cn?.type === 'lengthAngle'}
        <label class="flex flex-col gap-0.5">Length (formula, mm)<input class="input input-bordered input-xs font-mono" value={cn.lengthFormula} oninput={(e) => setConstraint({ ...cn, lengthFormula: e.currentTarget.value })} /></label>
        <label class="flex flex-col gap-0.5">Angle (formula, °)<input class="input input-bordered input-xs font-mono" value={cn.angleFormula} oninput={(e) => setConstraint({ ...cn, angleFormula: e.currentTarget.value })} /></label>
      {:else if cn?.type === 'sliding'}
        <label class="flex flex-col gap-0.5">Along path
          <select class="select select-bordered select-xs" value={cn.path} onchange={(e) => setConstraint({ ...cn, path: e.currentTarget.value })}>
            {#each currentPattern.paths as pa}<option value={pa.id}>{pa.name || pa.id.slice(0, 8)}</option>{/each}
          </select></label>
        <label class="flex flex-col gap-0.5">Distance along (formula, mm)<input class="input input-bordered input-xs font-mono" value={cn.positionFormula} oninput={(e) => setConstraint({ ...cn, positionFormula: e.currentTarget.value })} /></label>
      {/if}
      {#if cn}<p class="text-xs opacity-60">Position is computed from the formula(s). Reference variables and body measurements by name.</p>{/if}
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
              <div class="flex gap-2">
                <label class="flex flex-col gap-0.5 flex-1">Default notch size
                  <span class="flex items-center gap-2"><input type="number" step="0.1" class="input input-bordered input-xs w-20" value={toUnit(currentPattern.defaultNotchSize).toFixed(2)} oninput={(e) => updatePattern({ defaultNotchSize: fromUnit(parseFloat(e.currentTarget.value) || 0) })} /><span class="opacity-60">{unitLabel}</span></span></label>
                <label class="flex flex-col gap-0.5">Notch type
                  <select class="select select-bordered select-xs" value={currentPattern.defaultNotchType ?? 'single'} onchange={(e) => updatePattern({ defaultNotchType: e.currentTarget.value as 'single' | 'double' | 'tee' | 'slit' })}>
                    <option value="single">Single</option><option value="double">Double (balance)</option><option value="tee">Tee</option><option value="slit">Slit</option></select></label>
              </div>
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
                  <option value="">Custom (base)</option>
                  {#each sizes as sz}<option value={sz.name}>{sz.name}</option>{/each}
                </select>
                <button class="btn btn-xs btn-primary" onclick={addSize}>Create a size…</button>
              </div>
              {#if sizes.length}
                <div class="flex flex-col gap-1">
                  {#each sizes as sz}
                    <div class="flex items-center gap-1">
                      <span class="inline-block w-3 h-3 rounded-full shrink-0" style="background:{sz.color}"></span>
                      <input class="input input-bordered input-xs flex-1 min-w-0" value={sz.name} oninput={(e) => updateSize(sz.id, { name: e.currentTarget.value })} />
                      <input type="number" step="0.01" class="input input-bordered input-xs w-16" title="Grade scale" value={sz.scale} oninput={(e) => updateSize(sz.id, { scale: parseFloat(e.currentTarget.value) || 1 })} />
                      <button class="btn btn-ghost btn-xs p-1 text-error" title="Remove size" aria-label="Remove size" onclick={() => removeSize(sz.id)}><span class="material-symbols-rounded text-base">delete</span></button>
                    </div>
                  {/each}
                </div>
              {/if}
              {#if ongrading}<button class="btn btn-xs btn-outline w-full" onclick={ongrading}><span class="material-symbols-rounded text-base">table_chart</span> Sizes &amp; grading overlay…</button>{/if}
              {#if onalterations}<button class="btn btn-xs btn-outline w-full mt-1" onclick={onalterations}><span class="material-symbols-rounded text-base">tune</span> Alterations (grade by example)…</button>{/if}

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
                      <button class="btn btn-primary btn-sm w-8 h-8 p-1" title="Formula editor" aria-label="Formula editor" onclick={() => (formulaVarId = v.id)}><span class="material-symbols-rounded">function</span></button>
                    </span>
                    {#if v.valueFormula?.formula && v.valueFormula.formula !== String(v.value)}<span class="text-xs opacity-60 font-mono">= {v.valueFormula.formula}</span>{/if}</label>
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

{#if formulaVarId}
  {@const fv = currentPattern.variables.find((v) => v.id === formulaVarId)}
  <FormulaDialog
    formula={fv?.valueFormula?.formula ?? String(fv?.value ?? '')}
    variables={formulaScope}
    onsave={(f, val) => { if (formulaVarId) updateVariable(formulaVarId, { valueFormula: { ...(fv?.valueFormula ?? { formula: '', unit: 'none' }), formula: f }, value: val ?? fv?.value ?? 0 }); formulaVarId = null; }}
    oncancel={() => (formulaVarId = null)}
  />
{/if}
