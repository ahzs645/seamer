# Seamer (rebuilt)

A parametric sewing‑pattern studio with a 3D garment‑drape renderer. The signature feature is the
**pattern → 3D model renderer**: it reconstructs a morphable human avatar from body measurements,
arranges the 2D pattern pieces around it, sews the seams, and runs an **XPBD cloth simulation on
WebGPU** to drape the garment.

This repo reimplements that renderer from scratch (the original was a compiled SvelteKit build).

## Quick start

```bash
npm install
npm run dev        # open http://localhost:5173/studio
npm run check      # type-check
npm run build      # production build
```

Open **/studio**, choose **Templates → Pencil Skirt**, then press **▶ Simulate** in the 3D pane to
drape the garment on the avatar. Switch poses (T / BentArm / Sitting) and edit body measurements in
the **Body** panel to re‑shape the avatar.

> **WebGPU is required for the live drape** (Chrome or Edge; recent Safari Technology Preview). The
> avatar and the arranged (un‑simulated) panels render everywhere via WebGL; only the cloth solve
> needs WebGPU. A clear banner is shown when WebGPU is unavailable.

## How the renderer works

```
body measurements ─▶ statistical model (MLR) ─▶ 17 shape coefficients
                                                      │
                            per‑vertex affine basis ──┘ ─▶ 12,302‑vertex mesh (meters)
                                                                   │
                            mixamo skeleton + linear‑blend skinning ┘ ─▶ posed avatar
                                                                              │
2D pattern pieces ─▶ boundary + triangulation ─▶ arrange on body "cylinders" ┘
                                                  │
                       XPBD cloth solve (WebGPU): stretch + bend + seams + body collision + gravity
                                                  │
                                                  ▼
                                          draped 3D garment
```

### Subsystems (`src/lib`)

| Area | Files | What it does |
|---|---|---|
| **Schema** | `types/pattern.ts` | The real Seamer data model (points, paths with béziers, pieces with `mainPaths`/`settings3d.arrangement`, materials, seams, body). |
| **2D geometry** | `utils/patternGeometry.ts` | Resolve pieces/paths into renderable polylines; stitch piece outlines. |
| **Avatar** | `model/assets.ts`, `matrix.ts`, `measurements.ts`, `avatar.ts`, `skinnedAvatar.ts`, `avatarController.ts`, `measurementDefs.ts` | Load model assets; complete measurements via conditional‑Gaussian regression; reconstruct vertices (`pos = Σ wᵢ·eᵢ + intercept`, X‑mirrored); build the mixamo skeleton (joints regressed from vertices) and CPU linear‑blend skinning; apply poses. |
| **Garment geometry** | `geometry/cylinders.ts`, `boundary.ts`, `triangulate.ts`, `arrangement.ts` | Fit tapered/elliptical body cylinders; resample piece boundaries; Delaunay‑triangulate with a grain‑aligned Steiner grid; arrange pieces on the body (curved/flat). |
| **Cloth sim** | `sim/config.ts`, `build.ts`, `bodyGrid.ts`, `simulator.ts`, `webgpu/{device,engine,shaders}.ts` | Assemble particles/edges/bend/seams with anisotropic compliance + mirror instancing; build the body‑collision grid; run the WebGPU XPBD solver. |
| **Scene** | `scene/scene3d.ts`, `materials.ts` | three.js WebGLRenderer, camera/controls, lighting, floor; PBR garment + skin materials; drives the avatar + cloth + sim loop. |
| **UI** | `components/*`, `routes/studio/+page.svelte` | The studio shell (2D canvas, panels, 3D pane). |

### Solver (faithful WebGPU XPBD port)

`subSteps = 40`, `dt = 0.016/40`, `gravity = (0,−9.8,0)`. Per substep: predict → stretch (anisotropic
XPBD distance, graph‑colored) → bend (distance) → seams (mass‑weighted attraction) → body collision
(grid query + closest‑point push‑out + Coulomb friction) → velocity update. Stretch/bend compliance
is mapped log‑linearly from the material's 0–100 UI values. Constants and per‑constraint formulas
were ported from the original WGSL compute shaders.

The model assets live in `static/models/` (`base_model.json`, `female_model.json`/`male_model.json`,
`indices.bin`, `skin_indices.bin`, `skin_weights.bin`, `female_coefficients.bin`, `male_coefficients.bin`).

## Verified behaviour

- Mean female body reconstructs to **1.626 m** tall; measurements complete sensibly from age/height/weight.
- Skeleton: 52 bones; rest skinning is identity to 1e‑17; T‑pose raises the arms.
- Cloth: edge coloring is conflict‑free; a real WebGPU run of the pencil skirt produces a centered,
  stable drape (waist → mid‑calf hem, wrapping the hips), no NaNs, ~10 ms/step.

## Limitations / follow‑ups

- **WebGPU‑only drape** (matches the original). No WebGL fallback solver.
- **Both genders** are supported (`female_coefficients.bin` + `male_coefficients.bin` are bundled).
  The avatar must match the body the garment's `savedPositions` were settled on, or the cloth will
  clip (e.g. a male-drafted pattern needs the male body).
- **Self‑collision** is not yet implemented (the original has it behind a toggle); cloth can
  self‑interpenetrate in deep folds. Body collision and seams are implemented.
- The **2D constraint/formula solver** is not rebuilt — the 2D canvas renders from already‑resolved
  point coordinates (sufficient to display and drape the shipped templates). Live 2D re‑drafting and
  geometry creation tools are out of scope.
- Mirror/seam correspondence uses 3D proximity matching, which is robust but can leave a small
  asymmetry on complex multi‑instance garments.
