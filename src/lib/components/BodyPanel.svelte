<script lang="ts">
  import type { Pattern } from '$lib/types/pattern';
  import { BODY_FIELDS, unitSuffix, COLUMN_NAMES, type MeasurementDef } from '$lib/model/measurementDefs';
  import { loadGenderModel } from '$lib/model/assets';
  import { toMetricKnown, completeMeasurements } from '$lib/model/measurements';

  interface Props {
    currentPattern: Pattern;
    onchange: (p: Pattern) => void;
  }

  let { currentPattern, onchange }: Props = $props();

  const imperial = $derived(currentPattern.body.unitType !== 'metric');

  // Estimated measurements (from the statistical model), in DISPLAY units, used as the value when
  // the user hasn't entered one — so steppers start from the current value, not 0.
  let estimates = $state<Record<string, number>>({});

  $effect(() => {
    const body = currentPattern.body;
    const imp = body.unitType !== 'metric';
    loadGenderModel(body.gender)
      .then((model) => {
        const full = completeMeasurements(model, toMetricKnown(body)); // metric, COLUMN_NAMES order
        const out: Record<string, number> = {};
        for (const f of BODY_FIELDS) {
          let metric: number;
          if (f.name === 'weight') metric = Math.pow(full[COLUMN_NAMES.indexOf('weightCbrt')] || 0, 3);
          else if (f.name === 'age') metric = full[COLUMN_NAMES.indexOf('age')] || 0;
          else metric = full[COLUMN_NAMES.indexOf(f.name)] || 0;
          out[f.name] = toDisplay(metric, f, imp);
        }
        estimates = out;
      })
      .catch(() => {});
  });

  function toDisplay(metric: number, f: MeasurementDef, imp: boolean): number {
    if (f.kind === 'age') return Math.round(metric);
    if (f.kind === 'weight') return imp ? metric * 2.20462 : metric;
    return imp ? metric / 2.54 : metric; // length cm -> in
  }

  function displayValue(f: MeasurementDef): number {
    const set = currentPattern.body.fields[f.name];
    if (set != null && !Number.isNaN(set)) return set;
    return estimates[f.name] ?? 0;
  }

  function stepSize(f: MeasurementDef): number {
    if (f.kind === 'age') return 1;
    if (f.kind === 'weight') return imperial ? 2 : 1;
    return imperial ? 0.5 : 1;
  }

  function setGender(gender: 'male' | 'female') {
    onchange({ ...currentPattern, body: { ...currentPattern.body, gender }, hasChanged: true });
  }
  function setUnit(unitType: 'imperial' | 'metric') {
    onchange({ ...currentPattern, body: { ...currentPattern.body, unitType }, hasChanged: true });
  }
  function updateField(name: string, value: number) {
    const fields = { ...currentPattern.body.fields, [name]: Math.round(value * 10) / 10 };
    onchange({ ...currentPattern, body: { ...currentPattern.body, fields }, hasChanged: true });
  }
  function bump(f: MeasurementDef, dir: number) {
    updateField(f.name, displayValue(f) + dir * stepSize(f));
  }
  function clearField(name: string) {
    const fields = { ...currentPattern.body.fields };
    delete fields[name];
    onchange({ ...currentPattern, body: { ...currentPattern.body, fields }, hasChanged: true });
  }
  function updateBodyColor(color: string) {
    onchange({ ...currentPattern, body: { ...currentPattern.body, bodyColor: color }, hasChanged: true });
  }

  let showAll = $state(false);
  const visibleFields = $derived(showAll ? BODY_FIELDS : BODY_FIELDS.filter((f) => f.primary));
</script>

<div class="text-xs">
  <h3 class="font-bold mb-2">Body</h3>

  <div class="mb-2">
    <span class="text-xs opacity-70">Gender</span>
    <div class="join join-horizontal w-full mt-0.5">
      <button class="join-item btn btn-xs flex-1" class:btn-active={currentPattern.body.gender === 'female'} onclick={() => setGender('female')}>Female</button>
      <button class="join-item btn btn-xs flex-1" class:btn-active={currentPattern.body.gender === 'male'} onclick={() => setGender('male')}>Male</button>
    </div>
  </div>

  <div class="mb-2">
    <span class="text-xs opacity-70">Units</span>
    <div class="join join-horizontal w-full mt-0.5">
      <button class="join-item btn btn-xs flex-1" class:btn-active={imperial} onclick={() => setUnit('imperial')}>Imperial</button>
      <button class="join-item btn btn-xs flex-1" class:btn-active={!imperial} onclick={() => setUnit('metric')}>Metric</button>
    </div>
  </div>

  <div class="mb-2">
    <span class="text-xs opacity-70">Skin Tone</span>
    <input type="color" class="w-full h-6 cursor-pointer rounded" value={currentPattern.body.bodyColor} oninput={(e) => updateBodyColor(e.currentTarget.value)} aria-label="Skin tone" />
  </div>

  <div class="mb-2">
    <span class="text-xs opacity-70">Measurements</span>
    <div class="space-y-1 mt-1">
      {#each visibleFields as f (f.name)}
        {@const isEstimate = currentPattern.body.fields[f.name] == null}
        <div class="flex items-center gap-1">
          <span class="truncate flex-1" title={f.label}>{f.label}</span>
          <div class="join">
            <button class="join-item btn btn-xs px-1.5" aria-label="decrease" onclick={() => bump(f, -1)}>−</button>
            <input
              type="number"
              class="join-item input input-bordered input-xs w-12 text-right tabular-nums px-1"
              class:opacity-50={isEstimate}
              value={displayValue(f).toFixed(f.kind === 'age' ? 0 : 1)}
              step={stepSize(f)}
              oninput={(e) => { const v = parseFloat(e.currentTarget.value); if (!Number.isNaN(v)) updateField(f.name, v); }}
            />
            <button class="join-item btn btn-xs px-1.5" aria-label="increase" onclick={() => bump(f, 1)}>+</button>
          </div>
          <span class="text-[10px] opacity-50 w-5">{unitSuffix(f.kind, imperial)}</span>
          {#if !isEstimate}
            <button class="btn btn-xs btn-ghost px-0.5 text-error" title="Reset to estimate" onclick={() => clearField(f.name)}>×</button>
          {:else}
            <span class="w-4"></span>
          {/if}
        </div>
      {/each}
    </div>
  </div>

  <button class="btn btn-xs btn-ghost w-full" onclick={() => (showAll = !showAll)}>
    {showAll ? 'Show key measurements' : 'Show all measurements'}
  </button>
  <p class="text-[10px] opacity-50 mt-1">Faded values are estimated from the body model; edit to override.</p>
</div>
