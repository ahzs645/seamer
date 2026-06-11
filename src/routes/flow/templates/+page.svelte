<script lang="ts">
  // Mirrors the studio's built-in template library (static/templates/*.json).
  const templates: { name: string; description: string; file: string }[] = [
    { name: 'Parametric Skirt', description: 'Truly parametric: waist/hip/length variables re-draft the geometry; grades by size', file: 'parametric-skirt.json' },
    { name: 'Trousers', description: 'Simple pants in 3D (full 3D data)', file: 'simple-pants-3d.json' },
    { name: 'Fit & Flare Dress', description: 'Sleeveless fit and flare dress — converted from a 2D export', file: 'flare-dress.raw.json' },
    { name: 'Pencil Skirt (3D)', description: 'Pencil skirt with waistband, multi-seam (full 3D data)', file: 'pencil-skirt.json' },
    { name: 'Pencil Skirt (2D)', description: '2D skirt block that updates with the body', file: 'pencil-skirt-2d-bodydouble.json' },
    { name: 'Pencil Skirt (2D, tutorial)', description: '2D pencil skirt from the video tutorial', file: 'pencil-skirt-2d-tutorial.json' },
    { name: 'Skirt Block', description: 'Basic skirt block (Grundschnitt Rock)', file: 'grundschnitt-rock.json' },
    { name: 'Panty Block', description: 'Basic highwaisted panty block', file: 'panty-block.json' },
    { name: 'Russ Pants', description: "Norwegian 'russ' party pants", file: 'russ-pants.json' },
    { name: 'T-Shirt (Basic)', description: 'Front and back pieces with many variables', file: 'tshirt-basic.json' },
    { name: 'Long Sleeve Shirt', description: 'Long sleeve shirt with collar and cuffs', file: 'long-sleeve-shirt.json' },
    { name: 'Parametric Shirt', description: 'Long sleeve shirt controlled by measurements', file: 'parametric-shirt.json' },
    { name: 'Shirt with Pocket', description: 'Shirt with a front chest pocket', file: 'shirt-with-pocket.json' },
    { name: 'Test Shirt (3D)', description: 'Demo shirt in 3D', file: 'test-shirt-3d.json' },
    { name: 'Tailored Shirt', description: 'Classic tailored shirt drafted from a drafting book', file: 'tailored-shirt.json' },
    { name: "Women's Jacket", description: "Ladies' basic jacket with two-piece sleeves", file: 'womens-jacket.json' },
    { name: 'Oversized Blazer', description: 'Oversized longline blazer base (work in progress)', file: 'oversized-blazer.json' },
    { name: 'Black Dress', description: 'Little black dress, simple', file: 'black-dress.json' },
    { name: 'Flared Midi Dress', description: 'Snug at bust and waist with maxi flared lower part', file: 'flared-midi-dress.json' },
    { name: 'Nightwing Logo', description: 'Chest logo applique', file: 'nightwing-logo.json' }
  ];
</script>

<svelte:head>
  <title>Templates — Seamer</title>
</svelte:head>

<div class="px-4 py-8 max-w-6xl mx-auto">
  <h1 class="text-3xl font-bold font-lexend mb-6">Built-in Pattern Templates</h1>
  <p class="text-lg mb-8 max-w-3xl">
    Every Seamer install ships with these templates — open the
    <a href="/studio" class="link link-primary">studio</a> and pick one from the new-pattern
    dialog, or download the raw JSON and inspect it in the
    <a href="/pattern-viewer" class="link link-primary">pattern viewer</a>.
  </p>

  <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
    {#each templates as tpl}
      <div class="card bg-base-200 shadow-sm hover:shadow-md transition-shadow">
        <div class="card-body">
          <h2 class="card-title text-lg">{tpl.name}</h2>
          <p class="text-sm opacity-70">{tpl.description}</p>
          <div class="card-actions justify-end mt-2">
            <a href="/templates/{tpl.file}" class="btn btn-sm btn-ghost" download>JSON</a>
            <a href="/studio" class="btn btn-sm btn-accent">Open Studio</a>
          </div>
        </div>
      </div>
    {/each}
  </div>
</div>
