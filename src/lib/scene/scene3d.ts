// 3D scene: WebGLRenderer + camera + OrbitControls + lighting + floor, the parametric avatar, and
// the garment cloth meshes. Rendering runs on requestAnimationFrame; the WebGPU cloth solve runs in
// a separate self-paced async loop and writes results back into the cloth geometry.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { OBJExporter } from 'three/examples/jsm/exporters/OBJExporter.js';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import type { Pattern, Material } from '$lib/types/pattern';
import { AvatarController } from '$lib/model/avatarController';
import { buildCylinders, type CylinderFrame } from '$lib/geometry/cylinders';
import { prepareCloth, ClothSimulation, type PreparedCloth } from '$lib/sim/simulator';
import { SIM_CONFIG, type SimConfig } from '$lib/sim/config';
import { cylinderRefit } from '$lib/sim/cylinderRefit';
import { requestClothDevice, isWebGPUAvailable } from '$lib/sim/webgpu/device';
import { createGarmentMaterial, createAvatarMaterial, hasSeparateBack, disposeGarmentMaterial } from './materials';
import { isDarkTheme, onThemeChange } from '$lib/utils/theme';

export type RendererStatus = 'idle' | 'loading' | 'ready' | 'simulating' | 'error';

interface ClothMeshEntry {
  pieceId: string;
  start: number;
  count: number;
  geometry: THREE.BufferGeometry;
  mesh: THREE.Mesh;
  backMesh?: THREE.Mesh; // optional separate back-face mesh (shares geometry); for distinct back textures
}

// One movable piece in the pre-simulation arrangement editor: its flat-on-body geometry is centred
// in a Group at its centroid; the Group is moved/rotated by the transform gizmo. The sim is later
// seeded from group.matrixWorld * baseLocal.
interface ArrangeEntry {
  pieceId: string;
  start: number;
  count: number;
  group: THREE.Group;
  mesh: THREE.Mesh;
  baseLocal: Float32Array; // per-particle position relative to the group origin (centroid)
}

export type SceneMode = 'view' | 'arrange';

export class PatternRenderer {
  private container: HTMLElement;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;
  private controls: OrbitControls;
  private clothGroup = new THREE.Group();
  private floor: THREE.Mesh | null = null;
  private grid: THREE.GridHelper | null = null;
  private themeUnsub: () => void = () => {};
  private lightRig: THREE.Object3D[] = [];
  private lightRigBase: number[] = []; // base intensities, scaled down when an HDRI env is active
  private pmrem: THREE.PMREMGenerator | null = null;
  private envCache = new Map<string, THREE.Texture>();
  private lightingMode = 'flat';
  // Post-processing: ground-truth ambient occlusion (soft contact darkening in folds/seams/leg-gap and
  // where the garment meets the body) + SMAA edge AA, matching the source's polished look. Guarded —
  // if the composer fails to build, we fall back to direct rendering.
  private composer: EffectComposer | null = null;
  private gtaoPass: GTAOPass | null = null;
  private postEnabled = true;

  private avatar: AvatarController | null = null;
  private cylinders: Map<string, CylinderFrame> = new Map();
  private baseCylinders: Map<string, CylinderFrame> | null = null; // frames the cached drape was authored on
  private prepared: PreparedCloth | null = null;
  private clothMeshes: ClothMeshEntry[] = [];
  private clothBackMeshes: THREE.Mesh[] = []; // optional back-face meshes (separate back texture)
  private pieceLabels: { pieceId: string; obj: THREE.Object3D; aspect: number }[] = [];
  private showLabels = true;
  private labelMode: 'billboard' | 'flat' = 'flat';

  private device: GPUDevice | null = null;
  private sim: ClothSimulation | null = null;
  private simulating = false;
  private userSimulating = false; // true while a sim the USER started (via Start) is running
  // Live "hold" strength. The original solver has NO per-frame anchor; ours softly guides saved
  // pieces toward the cached drape (the original solver's own equilibrium) so our approximate solve
  // doesn't drift/curl. 1.0 froze it to a still image; a gentle value lets physics breathe/settle
  // while staying faithful to the source's shape. The source itself has NO anchor — but a fully free
  // settle (scale 0) slides the garment ~18-30cm off equilibrium (our solver lacks the source's
  // implicit grip), so a small hold is load-bearing. A headless anchor sweep showed a sharp cliff:
  // every nonzero scale holds the drape within <0.2mm drift (plateaued), only scale 0 drifts; 0.08
  // even had the LOWEST over-stretch (1.58 vs 0.25's 1.69). So we relax to 0.08 — ~3x more give /
  // closer to the source's free feel, while staying comfortably on the held side of the cliff.
  private static readonly LIVE_ANCHOR = 0.08;
  private liveAnchorScale = 0; // restored after an interactive grab
  // "Anchor to saved drape" toggle: OFF (default) = source-parity free-run — the garment hangs by
  // its seams/stretch alone like the original, so a drag pulls the whole connected garment; ON =
  // the gentle LIVE_ANCHOR hold above for extra cached-drape stability.
  private anchorsEnabled = false;

  /** The live hold strength honouring the "Anchor to saved drape" toggle. */
  private holdAnchor(): number {
    return this.anchorsEnabled ? PatternRenderer.LIVE_ANCHOR : 0;
  }

  /** Enable/disable the saved-drape anchor. Applies live to a running user sim. */
  setAnchorsEnabled(on: boolean): void {
    if (this.anchorsEnabled === on) return;
    this.anchorsEnabled = on;
    this.liveAnchorScale = this.holdAnchor();
    if (this.userSimulating && !this.grabbing) this.sim?.setAnchorScale(this.liveAnchorScale);
  }

  private pattern: Pattern | null = null;
  private rafId = 0;
  private disposed = false;

  // body-change tracking: savedPositions are valid only for the body they were authored on, so a
  // measurement/gender edit means the cached drape is stale and simulation must re-drape.
  private patternId: string | null = null;
  private baseBodyKey: string | null = null;
  private lastBodyKey: string | null = null;
  private bodyDirty = false;
  private adaptFramesLeft = 0; // frames left in a body-change re-drape before re-pinning
  private showTriangles = false;

  // interactive cloth grab
  private raycaster = new THREE.Raycaster();
  private grabbing = false;
  private grabIndex = -1;
  private grabDistance = 0;

  // pre-simulation arrangement editor
  private mode: SceneMode = 'view';
  private transform: TransformControls | null = null;
  private arrangeGroup = new THREE.Group();
  private arrangeEntries: ArrangeEntry[] = [];
  private selectedArrange = -1;

  onStatus: (status: RendererStatus, message?: string) => void = () => {};
  // `kind` distinguishes the two piece-edit tools while mode === 'arrange': 'arrange' (flat layout)
  // vs 'manipulate' (drag the draped pieces in place). null in 'view'. Lets the UI sync its toolbar
  // state even when Move mode is entered by clicking a piece in the 3D view (not via the toolbar).
  onModeChange: (mode: SceneMode, selectedPieceId: string | null, kind: 'arrange' | 'manipulate' | null) => void = () => {};
  /** Fired when a user-run drape settles (sim stopped): the freshly-settled per-piece savedPositions
   *  (stride-5: x2d,y2d mm, x3d,y3d,z3d m), keyed by base piece id, so the app can persist them. */
  onDrapeSettled: (savedByPiece: Record<string, number[]>) => void = () => {};
  /** Fired when a piece is picked in the 3D view (click) so the 2D editor can sync. */
  onSelectPiece: (pieceId: string | null) => void = () => {};
  private highlightId: string | null = null;

  /**
   * Highlight a piece from an external (2D) selection. Tints the matching draped cloth
   * mesh and/or arrange mesh blue; in arrange mode also attaches the gizmo. id=null clears.
   */
  setHighlightedPiece(id: string | null): void {
    this.highlightId = id;
    const HI = 0x1d4ed8;
    for (const e of this.clothMeshes) {
      const m = e.mesh.material as THREE.MeshPhysicalMaterial;
      if (!m.emissive) continue;
      m.emissive.setHex(e.pieceId === id ? HI : 0x000000);
      m.emissiveIntensity = e.pieceId === id ? 0.45 : 1;
      if (e.backMesh) {
        const bm = e.backMesh.material as THREE.MeshPhysicalMaterial;
        bm.emissive.setHex(e.pieceId === id ? HI : 0x000000);
        bm.emissiveIntensity = e.pieceId === id ? 0.45 : 1;
      }
    }
    if (this.mode === 'arrange') {
      const idx = this.arrangeEntries.findIndex((e) => e.pieceId === id);
      // applying an EXTERNAL selection: don't echo onSelectPiece back out, or the
      // 2D-store -> effect -> setHighlightedPiece -> onSelectPiece cycle never terminates
      this.selectArrange(idx, false);
    } else {
      for (const e of this.arrangeEntries) {
        const m = e.mesh.material as THREE.MeshPhysicalMaterial;
        if (m.emissive) m.emissive.setHex(e.pieceId === id ? HI : 0x000000);
      }
    }
  }

  constructor(container: HTMLElement, opts: { preserveDrawingBuffer?: boolean } = {}) {
    this.container = container;
    const w = Math.max(1, container.clientWidth);
    const h = Math.max(1, container.clientHeight);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: opts.preserveDrawingBuffer ?? false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color('#dfe3e8');
    this.camera = new THREE.PerspectiveCamera(54, w / h, 0.01, 100);
    this.camera.position.set(0.5, 0.9, 1.6);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 0.9, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.1;
    this.controls.minDistance = 0.3;
    this.controls.maxDistance = 6;
    this.controls.update();

    this.scene.add(this.clothGroup);
    this.setupLights();
    this.setupFloor();
    this.setupGrab();
    this.setupComposer(w, h);
    this.applySceneTheme(isDarkTheme());
    this.themeUnsub = onThemeChange(() => this.applySceneTheme(isDarkTheme()));

    this.renderLoop();
    window.addEventListener('resize', this.onResize);
  }

  // Build the post-processing chain: RenderPass -> GTAO (ambient occlusion) -> SMAA (edge AA) ->
  // OutputPass (tone map + sRGB). Fully guarded: any failure leaves composer null -> direct render.
  private setupComposer(w: number, h: number) {
    try {
      const composer = new EffectComposer(this.renderer);
      composer.addPass(new RenderPass(this.scene, this.camera));
      const gtao = new GTAOPass(this.scene, this.camera, w, h);
      gtao.output = GTAOPass.OUTPUT.Default; // beauty × AO
      gtao.blendIntensity = 0.9;
      // World-space radii tuned for human/garment scale (metres): subtle contact darkening.
      gtao.updateGtaoMaterial({ radius: 0.12, distanceExponent: 1.0, thickness: 0.1, scale: 1.0, samples: 16 });
      composer.addPass(gtao);
      composer.addPass(new SMAAPass(w, h));
      composer.addPass(new OutputPass());
      this.composer = composer;
      this.gtaoPass = gtao;
    } catch (e) {
      this.composer = null; this.gtaoPass = null;
      console.warn('Post-processing unavailable, using direct render:', e);
    }
  }

  /** Toggle GTAO/SMAA post-processing (falls back to direct render when off). */
  setPostProcessing(on: boolean) {
    this.postEnabled = on;
  }

  private setupLights() {
    const key = new THREE.DirectionalLight(0xffffff, 2.35);
    key.position.set(5, 15, 10);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    const cam = key.shadow.camera as THREE.OrthographicCamera;
    cam.near = 0.1; cam.far = 50; cam.left = -2; cam.right = 2; cam.top = 3; cam.bottom = -1;
    key.shadow.bias = -5e-4;
    key.shadow.normalBias = 0.03;
    const fill = new THREE.DirectionalLight(0xfff3a6, 1.05);
    fill.position.set(-5, 10, -5);
    const rim = new THREE.DirectionalLight(0xffffff, 0.85);
    rim.position.set(0, 10, -10);
    const ambient = new THREE.AmbientLight(0xffffff, 1.25);
    this.lightRig = [key, fill, rim, ambient];
    this.lightRigBase = this.lightRig.map((l) => (l as THREE.Light).intensity);
    for (const l of this.lightRig) this.scene.add(l);
  }

  // Lighting modes mirror the source's tabs: Flat (the bare light rig, no environment) plus three
  // image-based-lighting presets backed by the HDRIs already in static/3d/hdri/. An HDRI env provides
  // realistic soft lighting + reflections, so we dim the directional rig (keep some for crisp shadows).
  private static readonly HDRI: Record<string, string> = {
    studio1: '/3d/hdri/studio_small_08_1k.hdr',
    studio2: '/3d/hdri/photo_studio_london_hall_1k.hdr',
    sunset: '/3d/hdri/cedar_bridge_sunset_1_1k.hdr'
  };

  /** Switch lighting mode: 'flat' | 'studio1' | 'studio2' | 'sunset'. */
  setLightingMode(mode: string): void {
    this.lightingMode = mode;
    const url = PatternRenderer.HDRI[mode];
    if (!url) {
      // Flat: bare rig at full intensity, no environment.
      this.scene.environment = null;
      this.renderer.toneMappingExposure = 1.0;
      this.lightRig.forEach((l, i) => { (l as THREE.Light).intensity = this.lightRigBase[i]; });
      return;
    }
    // HDRI: dim the rig (env carries the lighting) and apply the equirect env as a PMREM cubemap.
    this.renderer.toneMappingExposure = 1.0;
    this.lightRig.forEach((l, i) => { (l as THREE.Light).intensity = this.lightRigBase[i] * (l instanceof THREE.AmbientLight ? 0.0 : 0.35); });
    const cached = this.envCache.get(url);
    if (cached) { this.scene.environment = cached; return; }
    if (!this.pmrem) { this.pmrem = new THREE.PMREMGenerator(this.renderer); this.pmrem.compileEquirectangularShader(); }
    new RGBELoader().load(url, (hdr) => {
      if (this.disposed || !this.pmrem) { hdr.dispose(); return; }
      hdr.mapping = THREE.EquirectangularReflectionMapping;
      const env = this.pmrem.fromEquirectangular(hdr).texture;
      hdr.dispose();
      this.envCache.set(url, env);
      if (this.lightingMode === mode) this.scene.environment = env; // still the active mode
    }, undefined, () => { /* HDRI unavailable -> keep the dimmed rig */ });
  }

  private setupFloor() {
    this.floor = new THREE.Mesh(
      new THREE.PlaneGeometry(20, 20),
      new THREE.MeshStandardMaterial({ color: '#c8ccd2', roughness: 0.9, metalness: 0, depthWrite: true })
    );
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.receiveShadow = true;
    this.scene.add(this.floor);
    this.grid = new THREE.GridHelper(8, 32, 0xb0b4ba, 0xc4c8ce);
    this.grid.position.y = 0.002;
    (this.grid.material as THREE.Material).opacity = 0.4;
    (this.grid.material as THREE.Material).transparent = true;
    this.scene.add(this.grid);
  }

  // Light/dark theme for the 3D canvas: scene background + floor + grid. HDRI modes set
  // scene.environment (lighting) but leave background = the theme colour, so dark mode reads as a
  // dark studio. Driven by the app's data-theme (see utils/theme).
  private applySceneTheme(dark: boolean) {
    const bg = dark ? '#171b21' : '#dfe3e8';
    (this.scene.background as THREE.Color)?.set?.(bg) ?? (this.scene.background = new THREE.Color(bg));
    if (this.floor) (this.floor.material as THREE.MeshStandardMaterial).color.set(dark ? '#1c2128' : '#c8ccd2');
    if (this.grid) {
      const g = this.grid as unknown as { material: THREE.LineBasicMaterial[] | THREE.LineBasicMaterial };
      const mats = Array.isArray(g.material) ? g.material : [g.material];
      for (const m of mats) m.color.set(dark ? '#39424e' : '#b8bcc2');
    }
  }

  /** Mouse interaction: grab a cloth particle and drag it (pulls the fabric, like the reference). */
  private setupGrab() {
    const dom = this.renderer.domElement;
    const ndc = new THREE.Vector2();
    const setNdc = (ev: PointerEvent) => {
      const r = dom.getBoundingClientRect();
      ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    };

    dom.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return;
      // Arrange mode: click a piece to select it (the gizmo handles its own drags). Don't grab/pull.
      if (this.mode === 'arrange') {
        if (this.transform && (this.transform.dragging || this.transform.axis)) return; // gizmo handle -> let it drag
        setNdc(ev);
        // A piece just moved by the gizmo only has its world matrix updated at render time; force it
        // current (and refresh bounds) so the raycast hits the piece at its NEW location.
        this.arrangeGroup.updateMatrixWorld(true);
        for (const e of this.arrangeEntries) e.mesh.geometry.computeBoundingSphere();
        this.raycaster.setFromCamera(ndc, this.camera);
        const hits = this.raycaster.intersectObjects(this.arrangeEntries.map((e) => e.mesh), false);
        const idx = hits[0] ? this.arrangeEntries.findIndex((e) => e.mesh === hits[0].object) : -1;
        this.selectArrange(idx);
        return;
      }
      if (this.clothMeshes.length === 0) return;
      setNdc(ev);
      // refresh bounding spheres so raycasting matches the current (draped) geometry
      for (const e of this.clothMeshes) e.geometry.computeBoundingSphere();
      this.raycaster.setFromCamera(ndc, this.camera);
      const hits = this.raycaster.intersectObjects(this.clothMeshes.map((e) => e.mesh), false);
      const hit = hits[0];
      const face = hit?.face;
      if (!hit || !face) return; // not on cloth -> let OrbitControls orbit
      const entry = this.clothMeshes.find((e) => e.mesh === hit.object);
      if (!entry) return;
      // selecting/highlighting the picked piece so the 2D editor stays in sync — but only while
      // IDLE: with the sim running the source grabs without selecting (no highlight mid-sim)
      if (!this.userSimulating) {
        this.setHighlightedPiece(entry.pieceId);
        this.onSelectPiece(entry.pieceId);
      }

      if (!ev.shiftKey && !this.userSimulating) {
        // Clicking a piece while IDLE enters in-place "Move pieces" mode and selects it, showing the
        // transform gizmo — i.e. arrange/drag, NOT a simulation.
        // While the simulation is RUNNING, a plain drag falls through to the grab below instead —
        // matching the source, where dragging live fabric pulls it (no modifier needed).
        this.enterManipulateMode();
        const idx = this.arrangeEntries.findIndex((e) => e.pieceId === entry.pieceId);
        if (idx >= 0) this.selectArrange(idx);
        return;
      }

      // Shift+drag: grab and pull the live fabric (soft-body); starts the sim if not already running.
      const pos = entry.geometry.getAttribute('position') as THREE.BufferAttribute;
      let bestL = face.a;
      let bd = Infinity;
      for (const l of [face.a, face.b, face.c]) {
        const dx = pos.getX(l) - hit.point.x, dy = pos.getY(l) - hit.point.y, dz = pos.getZ(l) - hit.point.z;
        const d = dx * dx + dy * dy + dz * dz;
        if (d < bd) { bd = d; bestL = l; }
      }
      this.grabIndex = entry.start + bestL;
      this.grabDistance = hit.distance;
      this.grabbing = true;
      this.controls.enabled = false; // don't orbit while dragging fabric
      void this.beginGrab(hit.point);
    });

    dom.addEventListener('pointermove', (ev) => {
      if (!this.grabbing || !this.sim) return;
      setNdc(ev);
      this.raycaster.setFromCamera(ndc, this.camera);
      // fixed-depth slide along the eye ray (matches the reference)
      const ray = this.raycaster.ray;
      const p = ray.origin.clone().addScaledVector(ray.direction, this.grabDistance);
      this.sim.setGrab(true, this.grabIndex, [p.x, p.y, p.z]);
    });

    const end = () => {
      if (!this.grabbing) return;
      this.grabbing = false;
      this.controls.enabled = true;
      this.sim?.setGrab(false, this.grabIndex, [0, 0, 0]);
      if (this.userSimulating && this.sim) {
        // The user explicitly started the simulation — keep it RUNNING after the drag. Re-engage the
        // hold + self-collision so the released fabric eases back to its draped shape and the live sim
        // continues (it does not stop/freeze).
        this.sim.setAnchorScale(this.liveAnchorScale);
        this.sim.setSelfCollision(true);
      } else {
        // Grab started from idle: leave the cloth exactly where you dropped it (freeze in place; no
        // snap-back, no slow droop). Use "Arrange"/"Reset" to return it to the settled drape.
        this.stopSimulation();
      }
    };
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  }

  private async beginGrab(point: THREE.Vector3) {
    const sim = await this.ensureSim();
    if (!sim || !this.grabbing) return;
    if (this.userSimulating) {
      // LIVE sim drag (source behavior): just grab — the integrate shader already releases the
      // anchor hold within the grab influence, so the fabric near the cursor follows while the
      // rest of the garment keeps simulating with self-collision on.
      sim.setSelfCollision(true);
    } else {
      // Idle drag (repo repositioning gesture): free the WHOLE garment so it moves as one
      // connected piece (panels held together by their seams) and follows the cursor — not
      // pinned, so seams don't pull open. Self-collision off during the drag: it's what curls a
      // free garment, and the trousers don't self-intersect in normal dragging; seams +
      // near-damping keep it coherent.
      sim.setAnchorScale(0);
      sim.setSelfCollision(false);
    }
    sim.setGrab(true, this.grabIndex, [point.x, point.y, point.z]);
    if (!this.simulating) {
      this.simulating = true;
      this.onStatus('simulating');
      void this.runSimLoop();
    }
  }

  private onResize = () => {
    if (this.disposed) return;
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer?.setSize(w, h);
  };

  private renderLoop = () => {
    if (this.disposed) return;
    this.rafId = requestAnimationFrame(this.renderLoop);
    this.controls.update();
    if (this.composer && this.postEnabled) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  };

  /** Build or update the avatar + cloth for a pattern. */
  async setPattern(pattern: Pattern, changedPieces?: Set<string>): Promise<void> {
    this.pattern = pattern;
    // Source parity (transferToScene's `wasSimulatorRunning`): capture whether a user-run sim was live
    // BEFORE we stop+rebuild, so we can restart it afterwards. The source re-settles an edited piece
    // ONLY if the sim was already running; a cold edit stays manual (press Simulate) — which we match.
    const wasRunning = this.userSimulating;
    this.stopSimulation();
    // Track whether the body changed vs the one the cached drape was authored on.
    const bodyKey = JSON.stringify(pattern.body);
    this.lastBodyKey = bodyKey;
    if (pattern.id !== this.patternId) {
      this.patternId = pattern.id;
      this.baseBodyKey = bodyKey;
      this.bodyDirty = false;
    } else {
      this.bodyDirty = bodyKey !== this.baseBodyKey;
    }
    this.onStatus('loading');
    try {
      if (!this.avatar) {
        this.avatar = await AvatarController.create(pattern.body, createAvatarMaterial(pattern.body.bodyColor));
        const mesh = this.avatar.mesh;
        if (mesh) this.scene.add(mesh);
      } else {
        await this.avatar.setBody(pattern.body);
        this.avatar.setMaterial(createAvatarMaterial(pattern.body.bodyColor));
      }
      this.applyCameraFromSettings(pattern);
      this.setLightingMode(pattern.settings3d.lightingMode || 'flat');
      this.rebuildCloth(pattern, changedPieces);
      this.onStatus('ready');
      // If the sim was live when the edit landed, re-settle the rebuilt cloth (the edited region drapes
      // instead of sitting at its seed). ~100 ms after the rebuild, matching the source's deferred
      // restart. simulate() recreates the sim from the fresh `prepared` via ensureSim().
      if (wasRunning && !this.disposed) {
        setTimeout(() => { if (!this.disposed && !this.simulating) void this.simulate(); }, 100);
      }
    } catch (e) {
      this.onStatus('error', e instanceof Error ? e.message : String(e));
    }
  }

  private applyCameraFromSettings(pattern: Pattern) {
    const s = pattern.settings3d;
    if (s.cameraPosition) this.camera.position.set(s.cameraPosition[0], s.cameraPosition[1], s.cameraPosition[2]);
    if (s.controlsTarget) this.controls.target.set(s.controlsTarget[0], s.controlsTarget[1], s.controlsTarget[2]);
    if (s.cameraFov) { this.camera.fov = s.cameraFov; this.camera.updateProjectionMatrix(); }
    this.controls.update();
  }

  /** Triangulate + arrange the garment and (re)build the static cloth meshes.
   *  `changedPieces` (pieces whose 2D shape was just edited) re-triangulate from live geometry. */
  private rebuildCloth(pattern: Pattern, changedPieces?: Set<string>) {
    if (this.mode === 'arrange') this.exitArrangeMode(); // stale arrange meshes reference old pieces
    this.clearClothMeshes();
    this.sim?.dispose();
    this.sim = null;
    if (!this.avatar) return;
    const verts = this.avatar.vertexPositions;
    const indices = this.avatar.indices;
    this.cylinders = buildCylinders(
      this.avatar.cylinderDefs,
      (name) => this.avatar!.bonePosition(name, new THREE.Vector3()),
      (i) => new THREE.Vector3(verts[i * 3], verts[i * 3 + 1], verts[i * 3 + 2])
    );
    // Capture the cylinder frames the cached drape is authored on (a fresh, non-dirty load). On a
    // later body edit these are the OLD frames the cylinder re-fit projects from. (Keep them across a
    // dirty rebuild — don't overwrite with the new-body frames.)
    if (!this.bodyDirty || !this.baseCylinders) this.baseCylinders = this.cylinders;
    this.prepared = prepareCloth({ pattern, avatarVertices: verts, avatarIndices: indices, cylinders: this.cylinders }, { changedPieces });
    if (!this.prepared) return;

    const flat = pattern.settings3d.lightingMode === 'flat';
    const matById = new Map<string, Material>();
    for (const m of pattern.materials) matById.set(m.id, m);

    for (const piece of this.prepared.simData.pieces) {
      const geo = new THREE.BufferGeometry();
      const positions = new Float32Array(piece.count * 3);
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(piece.uv, 2));
      const localIndex = piece.triangles.map((g) => g - piece.start);
      geo.setIndex(localIndex);
      const pieceMat = matById.get(piece.materialId);
      const separateBack = hasSeparateBack(pieceMat);
      const srcPiece = pattern.pieces.find((p) => p.id === piece.pieceId);
      const name = srcPiece?.name ?? 'Piece';
      const hidden = !!srcPiece?.hidden; // object-browser visibility toggle

      // Build a `uvLabel` attribute (0..1 across the piece's pattern bbox) and per-piece canvas
      // badges, composited into the lit surface by the material shader — this is the default
      // 'flat' look (deforms + shades with the cloth). The shader picks the "face side" badge on the
      // outward face and the "back side" badge on the reverse. Built unconditionally so toggling
      // label mode is a cheap uniform flip rather than a full cloth rebuild (which would re-drape).
      const { face: faceLabelTex, back: backLabelTex } = this.buildPieceLabelTextures(geo, piece.uv, piece.count, piece.pieceId, name);
      // mirror instances have reversed winding; flipNormals also inverts the outward face — XOR them.
      const labelFlipFace = piece.pieceId.includes('#M') !== !!srcPiece?.settings3d.flipNormals;
      const labelOpacity = this.showLabels && !hidden && this.labelMode === 'flat' ? 1 : 0;

      // Our cloth triangles wind with their geometric front face pointing INWARD, so the outward
      // surface the camera sees is the BackSide. For a separate back texture we therefore render the
      // FACE (front) texture on a BackSide mesh (shows outward) and the back texture on a FrontSide
      // mesh (shows inward). With a single double-sided material this doesn't matter (both sides same).
      const mat = createGarmentMaterial(pieceMat, flat, { side: separateBack ? THREE.BackSide : THREE.DoubleSide, labelTexture: faceLabelTex, labelTextureBack: backLabelTex, labelOpacity, labelFlipFace });
      mat.wireframe = this.showTriangles;
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      mesh.visible = !hidden;
      this.clothGroup.add(mesh);
      // separate back side: a second mesh on the same (deforming) geometry, back faces only
      let backMesh: THREE.Mesh | undefined;
      if (separateBack) {
        const backMat = createGarmentMaterial(pieceMat, flat, { side: THREE.FrontSide, back: true, labelTexture: faceLabelTex, labelTextureBack: backLabelTex, labelOpacity, labelFlipFace });
        backMat.wireframe = this.showTriangles;
        backMesh = new THREE.Mesh(geo, backMat);
        backMesh.castShadow = true; backMesh.receiveShadow = true; backMesh.frustumCulled = false;
        backMesh.visible = !hidden;
        this.clothGroup.add(backMesh);
        this.clothBackMeshes.push(backMesh);
      }
      this.clothMeshes.push({ pieceId: piece.pieceId, start: piece.start, count: piece.count, geometry: geo, mesh, backMesh });

      // Camera-facing sprite badge for 'billboard' mode (hidden unless that mode is active).
      const { obj, aspect } = this.makeLabel(`${name} face side`);
      obj.visible = this.showLabels && !hidden && this.labelMode === 'billboard';
      this.clothGroup.add(obj);
      this.pieceLabels.push({ pieceId: piece.pieceId, obj, aspect });
    }
    this.applyClothPositions(this.prepared.simData.positions);
  }

  /** Add a per-piece `uvLabel` attribute (0..1 across the piece's pattern bbox); returns bbox size in mm. */
  private addLabelUVs(geo: THREE.BufferGeometry, uv: Float32Array, count: number): { wMM: number; hMM: number } {
    let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
    for (let i = 0; i < count; i++) {
      const u = uv[i * 2], v = uv[i * 2 + 1];
      if (u < uMin) uMin = u; if (u > uMax) uMax = u;
      if (v < vMin) vMin = v; if (v > vMax) vMax = v;
    }
    const wMM = Math.max(1, uMax - uMin), hMM = Math.max(1, vMax - vMin);
    const uvLabel = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      uvLabel[i * 2] = (uv[i * 2] - uMin) / wMM;
      uvLabel[i * 2 + 1] = (uv[i * 2 + 1] - vMin) / hMM;
    }
    geo.setAttribute('uvLabel', new THREE.BufferAttribute(uvLabel, 2));
    return { wMM, hMM };
  }

  /** Set up uvLabel on `geo` and build the face/back name badges for a piece (back text is flipped
   *  the opposite way so it reads correctly when viewed from the reverse face). */
  private buildPieceLabelTextures(geo: THREE.BufferGeometry, uv: Float32Array, count: number, pieceId: string, name: string): { face: THREE.CanvasTexture; back: THREE.CanvasTexture } {
    const { wMM, hMM } = this.addLabelUVs(geo, uv, count);
    const mirror = pieceId.includes('#M'); // mirror instances have a negated U
    return {
      face: this.makeBakedLabelTexture(`${name}\nface side`, wMM, hMM, mirror),
      back: this.makeBakedLabelTexture(`${name}\nback side`, wMM, hMM, !mirror)
    };
  }

  private applyClothPositions(global: Float32Array) {
    this.lastClothPositions = global;
    for (const entry of this.clothMeshes) {
      const attr = entry.geometry.getAttribute('position') as THREE.BufferAttribute;
      const arr = attr.array as Float32Array;
      let cx = 0, cy = 0, cz = 0;
      for (let i = 0; i < entry.count; i++) {
        const g = entry.start + i;
        const x = global[g * 4], y = global[g * 4 + 1], z = global[g * 4 + 2];
        arr[i * 3] = x; arr[i * 3 + 1] = y; arr[i * 3 + 2] = z;
        cx += x; cy += y; cz += z;
      }
      attr.needsUpdate = true;
      entry.geometry.computeVertexNormals();
      // bounding sphere not recomputed per frame: cloth meshes have frustumCulled = false.

      // Flat (default) badges are baked into the material and need no per-frame work. Billboard
      // sprites, if present, get parked at the piece's (live) centroid to face the camera.
      const label = this.pieceLabels.find((l) => l.pieceId === entry.pieceId);
      if (!label || entry.count === 0) continue;
      label.obj.position.set(cx / entry.count, cy / entry.count, cz / entry.count);
    }
    this.updateSeamLines(global);
  }

  private clearClothMeshes() {
    this.clearSnapshot(); // a ghost from the old drape would be stale once pieces rebuild
    this.clearSeamLines();
    for (const e of this.clothMeshes) {
      this.clothGroup.remove(e.mesh);
      e.geometry.dispose();
      disposeGarmentMaterial(e.mesh.material as THREE.Material);
    }
    this.clothMeshes = [];
    for (const b of this.clothBackMeshes) { this.clothGroup.remove(b); disposeGarmentMaterial(b.material as THREE.Material); }
    this.clothBackMeshes = [];
    for (const l of this.pieceLabels) {
      this.clothGroup.remove(l.obj);
      const m = (l.obj as THREE.Sprite | THREE.Mesh).material as THREE.SpriteMaterial | THREE.MeshBasicMaterial;
      (m.map as THREE.Texture | null)?.dispose();
      m.dispose();
      if (l.obj instanceof THREE.Mesh) l.obj.geometry.dispose();
    }
    this.pieceLabels = [];
  }

  /** Render a rounded "Name face side" badge to a canvas texture (+ its aspect ratio). */
  private makeLabelTexture(text: string): { tex: THREE.CanvasTexture; aspect: number } {
    const pad = 16, fontPx = 28;
    const c = document.createElement('canvas');
    const probe = c.getContext('2d')!;
    probe.font = `600 ${fontPx}px "Noto Sans", sans-serif`;
    c.width = Math.ceil(probe.measureText(text).width) + pad * 2;
    c.height = fontPx + pad * 2;
    const ctx = c.getContext('2d')!;
    ctx.font = `600 ${fontPx}px "Noto Sans", sans-serif`;
    const r = 14;
    ctx.beginPath();
    ctx.moveTo(r, 0);
    ctx.arcTo(c.width, 0, c.width, c.height, r);
    ctx.arcTo(c.width, c.height, 0, c.height, r);
    ctx.arcTo(0, c.height, 0, 0, r);
    ctx.arcTo(0, 0, c.width, 0, r);
    ctx.closePath();
    ctx.fillStyle = 'rgba(245,245,245,0.92)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(100,100,100,0.4)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#222';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, c.width / 2, c.height / 2 + 1);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return { tex, aspect: c.width / c.height };
  }

  /** A camera-facing billboard sprite badge (used only in 'billboard' label mode). */
  private makeLabel(text: string): { obj: THREE.Object3D; aspect: number } {
    const { tex, aspect } = this.makeLabelTexture(text);
    const H = 0.035; // world height of the label (meters) — kept subtle, like the source
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: true });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(H * aspect, H, 1);
    return { obj: sprite, aspect };
  }

  /**
   * Per-piece badge baked into the cloth surface, mirroring the original renderer's drawCenteredLabel:
   * ~10mm text shrunk to fit within 90%×60% of the piece, two stacked lines on a translucent rounded
   * plate. Drawn in the piece's pattern-bbox UV space (0..1); mirror instances pre-flip horizontally.
   */
  private makeBakedLabelTexture(text: string, wMM: number, hMM: number, mirror: boolean): THREE.CanvasTexture {
    const lines = text.split('\n').map((s) => s.trim()).filter(Boolean);
    const pxPerMM = Math.min(Math.max(1536 / Math.max(wMM, hMM), 1), 8);
    const W = Math.max(8, Math.round(wMM * pxPerMM));
    const H = Math.max(8, Math.round(hMM * pxPerMM));
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    if (mirror) { ctx.translate(W, 0); ctx.scale(-1, 1); } // cancel the mirror instance's negated U

    const font = 'Noto Sans, sans-serif';
    const maxW = W * 0.9, maxH = H * 0.6;
    let w = Math.max(10, 10 * pxPerMM); // ~10mm cap-height text, like the source
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const measure = () => { ctx.font = `300 ${w}px ${font}`; let m = 0; for (const ln of lines) m = Math.max(m, ctx.measureText(ln).width); return m; };
    let textW = measure();
    let lineH = w * 1.2;
    let blockH = lineH * lines.length;
    const k = Math.min(1, textW > 0 ? maxW / textW : 1, blockH > 0 ? maxH / blockH : 1);
    if (k < 1) { w = Math.max(8, w * k); textW = measure(); lineH = w * 1.2; blockH = lineH * lines.length; }

    const pad = Math.max(6, w * 0.35);
    const bw = textW + pad * 2, bh = blockH + pad * 1.4;
    const r = Math.max(4, Math.min(bw, bh) * 0.12);
    const cx = W / 2, cy = H / 2;
    this.roundRectPath(ctx, cx - bw / 2, cy - bh / 2, bw, bh, r);
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.fill();
    ctx.lineWidth = Math.max(1, Math.round(Math.max(1, w * 0.06)));
    ctx.strokeStyle = '#000000';
    ctx.stroke();
    ctx.fillStyle = '#000000';
    ctx.font = `300 ${w}px ${font}`;
    let y = cy - blockH / 2 + lineH / 2;
    for (const ln of lines) { ctx.fillText(ln, cx, y); y += lineH; }

    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    tex.needsUpdate = true;
    return tex;
  }

  private roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
    const rr = Math.min(r, w / 2, h / 2);
    if (typeof ctx.roundRect === 'function') { ctx.beginPath(); ctx.roundRect(x, y, w, h, rr); return; }
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  /** Toggle the garment piece labels on/off. */
  setShowLabels(on: boolean): void {
    this.showLabels = on;
    this.applyLabelVisibility();
  }

  /** Switch label style between camera-facing (billboard) and baked-into-fabric (flat). */
  setLabelMode(mode: 'billboard' | 'flat'): void {
    if (mode === this.labelMode) return;
    this.labelMode = mode;
    this.applyLabelVisibility();
  }

  /**
   * Show the right badge per mode without rebuilding: baked badges live in the material shader
   * (toggled via the uLabelOpacity uniform), billboard badges are sprites (toggled via visibility).
   */
  private applyLabelVisibility(): void {
    const flat = this.labelMode === 'flat';
    for (const e of this.clothMeshes) {
      const opacity = this.showLabels && e.mesh.visible && flat ? 1 : 0;
      for (const m of [e.mesh.material, e.backMesh?.material]) {
        const u = (m as THREE.Material | undefined)?.userData?.labelUniforms as { uLabelOpacity: { value: number } } | undefined;
        if (u) u.uLabelOpacity.value = opacity;
      }
    }
    for (const l of this.pieceLabels) {
      const mesh = this.clothMeshes.find((e) => e.pieceId === l.pieceId)?.mesh;
      l.obj.visible = this.showLabels && !flat && (mesh ? mesh.visible : true);
    }
  }

  private lastClothPositions: Float32Array | null = null;

  setPose(name: string | null) {
    this.avatar?.setPose(name);
    // body moved: refresh cylinders + collision grid (cloth keeps current positions)
    if (this.avatar && this.sim) {
      this.sim.rebuildBodyGrid(this.avatar.vertexPositions, this.avatar.indices);
    }
  }

  poseNames(): string[] {
    return this.avatar?.poseNames() ?? [];
  }

  webgpuAvailable(): boolean {
    return isWebGPUAvailable();
  }

  private async ensureSim(): Promise<ClothSimulation | null> {
    if (this.sim) return this.sim;
    if (!this.prepared) return null;
    if (!this.device) this.device = await requestClothDevice();
    this.sim = new ClothSimulation(this.device, this.prepared);
    return this.sim;
  }

  /** The body-cylinder name a sim piece is arranged on (strips the mirror-instance suffix). */
  private cylinderNameForPiece(pieceId: string): string | null {
    const baseId = pieceId.replace(/#M$/, '');
    const piece = this.pattern?.pieces.find((p) => p.id === baseId);
    const name = piece?.settings3d.arrangement.cylinderName;
    return name && !piece?.settings3d.arrangement.use2DPosition ? name : null;
  }

  /** Run the live cloth simulation from the current state (requires WebGPU). */
  async simulate(): Promise<void> {
    if (this.simulating) return;
    try {
      const sim = await this.ensureSim();
      if (!sim) return;
      if (this.bodyDirty && this.baseCylinders && this.pattern) {
        // Body changed: re-fit the cached drape onto the new body via CYLINDER COORDINATES — decompose
        // each particle into (u, v, radial standoff) on the OLD body's cylinder and re-project onto the
        // NEW body's cylinder. This deforms the drape coherently with the body (tracks size/pose), with
        // no physics re-settle, so it can't splay/curl the way per-piece rigid fit or free settling did.
        const cylName = this.cylinderNameForPiece.bind(this);
        const refit = cylinderRefit(sim.positions, this.prepared!.simData.pieces, cylName, this.baseCylinders, this.cylinders);
        sim.seedAndHold(refit, this.holdAnchor());
        this.applyClothPositions(refit);
        sim.setSelfCollision(true);
        this.adaptFramesLeft = 0;
        this.bodyDirty = false;
        this.baseBodyKey = this.lastBodyKey;
        this.baseCylinders = this.cylinders; // the new body is now the base for future edits
      } else if (this.bodyDirty) {
        // Fallback (no base cylinders captured): soft-anchor adaptation.
        sim.setSelfCollision(false);
        sim.setAnchorScale(0.3);
        this.adaptFramesLeft = 90;
      } else {
        // No change: softly hold the cached (settled) drape with self-collision on. A gentle hold
        // (not a rigid pin) lets the cloth settle/respond like a live sim while staying faithful to
        // the source's drape and not curling the free waistband edge.
        sim.setSelfCollision(true);
        sim.setAnchorScale(this.holdAnchor());
        this.adaptFramesLeft = 0;
      }
      this.liveAnchorScale = this.bodyDirty ? 0.3 : this.holdAnchor(); // restore after a grab
      this.userSimulating = true; // user-started: keep running across grab/release
      this.simulating = true;
      this.onStatus('simulating');
      void this.runSimLoop();
    } catch (e) {
      this.simulating = false;
      this.onStatus('error', e instanceof Error ? e.message : String(e));
    }
  }

  private simLoopActive = false;
  private async runSimLoop() {
    if (this.simLoopActive) return; // exactly one loop at a time — two would fight over step()/inFlight
    this.simLoopActive = true;
    const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
    try {
      while (this.simulating && this.sim && !this.disposed) {
        try {
          const positions = await this.sim.step();
          if (positions.length === 0) {
            // step() skipped (a prior step still in flight, or a transient). YIELD a frame instead of
            // tight-looping — a busy await-resolved loop starves rendering/input and freezes the tab.
            await nextFrame();
            continue;
          }
          this.applyClothPositions(positions);
          // Body-change adapt finished: pin to the new settled drape and re-enable self-collision.
          if (this.adaptFramesLeft > 0 && --this.adaptFramesLeft === 0) {
            this.sim.reanchorToSettled();
            this.sim.setSelfCollision(true);
            this.bodyDirty = false;
            this.baseBodyKey = this.lastBodyKey;
          }
        } catch (e) {
          this.simulating = false;
          this.onStatus('error', e instanceof Error ? e.message : String(e));
          return;
        }
      }
    } finally {
      this.simLoopActive = false;
    }
  }

  stopSimulation() {
    const wasUser = this.userSimulating;
    this.simulating = false;
    this.userSimulating = false;
    if (this.pattern) this.onStatus('ready');
    // Bake the settled drape so it can be persisted (re-open shows the new drape instantly, and
    // body re-fits chain off the latest result rather than the stale authored blob).
    if (wasUser) { try { this.onDrapeSettled(this.extractSavedPositions()); } catch { /* ignore */ } }
  }

  /** Per-piece settled positions in the savedPositions format (stride-5: x2d,y2d in mm; x3d,y3d,z3d
   *  in m), keyed by base piece id. 2D comes from positions2d (meters→mm); 3D from the live drape.
   *  Mirror instances (#M) are skipped — savedPositions belongs to the base piece. */
  extractSavedPositions(): Record<string, number[]> {
    const out: Record<string, number[]> = {};
    if (!this.prepared) return out;
    const sd = this.prepared.simData;
    const pos = this.sim?.positions ?? sd.positions;
    for (const piece of sd.pieces) {
      if (piece.pieceId.endsWith('#M')) continue;
      const arr = new Array(piece.count * 5);
      for (let i = 0; i < piece.count; i++) {
        const g = piece.start + i;
        arr[i * 5] = sd.positions2d[g * 4] * 1000;
        arr[i * 5 + 1] = sd.positions2d[g * 4 + 1] * 1000;
        arr[i * 5 + 2] = pos[g * 4];
        arr[i * 5 + 3] = pos[g * 4 + 1];
        arr[i * 5 + 4] = pos[g * 4 + 2];
      }
      out[piece.pieceId] = arr;
    }
    return out;
  }

  /** Reset particles to the cached/settled drape. */
  resetSimulation() {
    this.stopSimulation();
    if (this.sim) { this.sim.resetToSaved(); this.applyClothPositions(this.sim.positions); }
    else if (this.prepared) this.applyClothPositions(this.prepared.simData.positions);
  }

  /** "Arrange" — return the garment to its settled drape on the body. */
  arrange() {
    this.resetSimulation();
  }

  // ---- Pre-simulation arrangement editor -----------------------------------------------------
  // Enter a mode where each garment piece is shown in its flat-on-body layout and can be selected
  // and moved/rotated with a transform gizmo (on or off the body) before draping.

  getMode(): SceneMode {
    return this.mode;
  }

  /** true while the piece-edit groups were seeded from the live drape (Move mode) vs the flat layout. */
  private arrangeFromDrape = false;

  /** Enter arrange mode: show pieces flat-on-body, each individually selectable + movable. */
  enterArrangeMode(): void {
    if (this.mode === 'arrange' || !this.prepared || !this.pattern) return;
    this.stopSimulation();
    this.arrangeFromDrape = false;
    this.buildPieceEditGroups(this.prepared.simData.arrangedPositions); // stride-4 world (flat-on-body)
  }

  /**
   * Enter "Move pieces" mode: each *draped* piece becomes an individually selectable rigid solid you
   * can translate/rotate with the gizmo, in place on the body. Pressing Play (Drape) eases the moved
   * pieces back to the settled drape — they "fly back" because the sim's anchors stay at that drape.
   */
  enterManipulateMode(): void {
    if (this.mode === 'arrange' || !this.prepared || !this.pattern) return;
    this.stopSimulation();
    this.arrangeFromDrape = true;
    // Seed from the freshest drape: the live sim if any, else the last applied positions, else cached.
    const base = this.sim?.positions ?? this.lastClothPositions ?? this.prepared.simData.positions;
    this.buildPieceEditGroups(base);
  }

  /** Build the per-piece movable groups (centroid origin + local geometry) from stride-4 `base`. */
  private buildPieceEditGroups(base: Float32Array): void {
    this.mode = 'arrange';
    this.clothGroup.visible = false; // hide the live (single) draped meshes while editing per-piece
    this.scene.add(this.arrangeGroup);

    const flat = this.pattern!.settings3d.lightingMode === 'flat';
    const matById = new Map<string, Material>();
    for (const m of this.pattern!.materials) matById.set(m.id, m);

    for (const piece of this.prepared!.simData.pieces) {
      const c = new THREE.Vector3();
      for (let i = 0; i < piece.count; i++) {
        const g = piece.start + i;
        c.x += base[g * 4]; c.y += base[g * 4 + 1]; c.z += base[g * 4 + 2];
      }
      c.multiplyScalar(1 / Math.max(1, piece.count));
      const baseLocal = new Float32Array(piece.count * 3);
      const pos = new Float32Array(piece.count * 3);
      for (let i = 0; i < piece.count; i++) {
        const g = piece.start + i;
        const lx = base[g * 4] - c.x, ly = base[g * 4 + 1] - c.y, lz = base[g * 4 + 2] - c.z;
        baseLocal[i * 3] = lx; baseLocal[i * 3 + 1] = ly; baseLocal[i * 3 + 2] = lz;
        pos[i * 3] = lx; pos[i * 3 + 1] = ly; pos[i * 3 + 2] = lz;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(piece.uv.slice(), 2));
      geo.setIndex(piece.triangles.map((g) => g - piece.start));
      geo.computeVertexNormals();
      // Bake the same name badges as the drape view so pieces keep their labels while being moved.
      const srcPiece = this.pattern!.pieces.find((p) => p.id === piece.pieceId);
      const name = srcPiece?.name ?? 'Piece';
      const { face, back } = this.buildPieceLabelTextures(geo, piece.uv, piece.count, piece.pieceId, name);
      const labelOpacity = this.showLabels && this.labelMode === 'flat' ? 1 : 0;
      const labelFlipFace = piece.pieceId.includes('#M') !== !!srcPiece?.settings3d.flipNormals;
      const mat = createGarmentMaterial(matById.get(piece.materialId), flat, { labelTexture: face, labelTextureBack: back, labelOpacity, labelFlipFace });
      mat.wireframe = this.showTriangles;
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      const group = new THREE.Group();
      group.position.copy(c);
      group.add(mesh);
      group.visible = !this.pattern!.pieces.find((p) => p.id === piece.pieceId)?.hidden;
      this.arrangeGroup.add(group);
      this.arrangeEntries.push({ pieceId: piece.pieceId, start: piece.start, count: piece.count, group, mesh, baseLocal });
    }

    if (!this.transform) {
      this.transform = new TransformControls(this.camera, this.renderer.domElement);
      this.transform.setMode('translate');
      this.transform.setSpace('local');
      // disable orbit while dragging the gizmo
      this.transform.addEventListener('dragging-changed', (e) => { this.controls.enabled = !(e as unknown as { value: boolean }).value; });
      this.scene.add(this.transform.getHelper());
    }
    this.selectArrange(-1);
  }

  /** Select an arrange piece by index (-1 clears). Highlights it and attaches the gizmo. */
  private selectArrange(idx: number, emit = true): void {
    if (this.selectedArrange >= 0 && this.selectedArrange < this.arrangeEntries.length) {
      const prev = this.arrangeEntries[this.selectedArrange].mesh.material as THREE.MeshPhysicalMaterial;
      prev.emissive.setHex(0x000000);
    }
    this.selectedArrange = idx;
    if (idx >= 0 && idx < this.arrangeEntries.length) {
      const e = this.arrangeEntries[idx];
      const m = e.mesh.material as THREE.MeshPhysicalMaterial;
      m.emissive.setHex(0x1d4ed8); // blue selection tint
      m.emissiveIntensity = 0.4;
      this.transform?.attach(e.group);
      this.highlightId = e.pieceId;
      this.emitModeChange(e.pieceId);
      if (emit) this.onSelectPiece(e.pieceId);
    } else {
      this.transform?.detach();
      this.emitModeChange(null);
    }
  }

  /** Fire onModeChange with the current mode + edit kind (arrange vs in-place manipulate). */
  private emitModeChange(selectedPieceId: string | null): void {
    const kind = this.mode === 'arrange' ? (this.arrangeFromDrape ? 'manipulate' : 'arrange') : null;
    this.onModeChange(this.mode, selectedPieceId, kind);
  }

  /** Gizmo mode while arranging. */
  setArrangeTransformMode(m: 'translate' | 'rotate'): void {
    this.transform?.setMode(m);
  }

  /** Global stride-4 seed positions = each piece's flat-on-body base transformed by its gizmo. */
  private arrangedSeed(): Float32Array {
    const out = this.prepared!.simData.positions.slice(); // keep invMass in .w
    const v = new THREE.Vector3();
    for (const e of this.arrangeEntries) {
      e.group.updateMatrixWorld(true);
      for (let i = 0; i < e.count; i++) {
        v.set(e.baseLocal[i * 3], e.baseLocal[i * 3 + 1], e.baseLocal[i * 3 + 2]).applyMatrix4(e.group.matrixWorld);
        const g = e.start + i;
        out[g * 4] = v.x; out[g * 4 + 1] = v.y; out[g * 4 + 2] = v.z;
      }
    }
    return out;
  }

  /** Leave arrange mode without draping; restore the previous drape view. */
  exitArrangeMode(): void {
    if (this.mode !== 'arrange') return;
    this.selectArrange(-1);
    this.transform?.detach();
    for (const e of this.arrangeEntries) {
      this.arrangeGroup.remove(e.group);
      e.mesh.geometry.dispose();
      disposeGarmentMaterial(e.mesh.material as THREE.Material);
    }
    this.arrangeEntries = [];
    this.scene.remove(this.arrangeGroup);
    this.clothGroup.visible = true;
    this.mode = 'view';
    this.arrangeFromDrape = false;
    this.emitModeChange(null);
  }

  /** Drape from the current arrangement: seed the sim with the moved pieces and simulate. */
  async simulateFromArrangement(): Promise<void> {
    if (this.mode !== 'arrange' || !this.prepared) return;
    const fromDrape = this.arrangeFromDrape;
    const seed = this.arrangedSeed();
    this.exitArrangeMode();
    const sim = await this.ensureSim();
    if (!sim) { this.applyClothPositions(seed); return; }
    sim.resetTo(seed);
    this.applyClothPositions(seed);
    if (fromDrape) {
      // Move mode: the anchors still target the settled drape, so a soft hold eases the displaced
      // pieces back into place — they "fly back" — then the live sim keeps running until stopped.
      sim.setSelfCollision(true);
      sim.setAnchorScale(this.holdAnchor());
      this.liveAnchorScale = this.holdAnchor();
      this.userSimulating = true; // stays live across grabs; Stop bakes the result
    } else {
      // Flat-arrangement drape: free settle from the user's layout (no cached drape applies);
      // self-collision off avoids the free-settle curl, matching the interactive-drag behaviour.
      sim.setAnchorScale(0);
      sim.setSelfCollision(false);
      this.userSimulating = false; // one-shot settle: grab→freeze on release
    }
    this.bodyDirty = false;
    this.adaptFramesLeft = 0;
    this.simulating = true;
    this.onStatus('simulating');
    void this.runSimLoop();
  }

  setAvatarVisible(v: boolean) {
    if (this.avatar?.mesh) this.avatar.mesh.visible = v;
  }

  setClothVisible(v: boolean) {
    this.clothGroup.visible = v;
  }

  /** Overlay the cloth triangle mesh (wireframe). */
  setShowTriangles(v: boolean) {
    this.showTriangles = v;
    for (const e of this.clothMeshes) {
      (e.mesh.material as THREE.MeshPhysicalMaterial).wireframe = v;
      if (e.backMesh) (e.backMesh.material as THREE.MeshPhysicalMaterial).wireframe = v;
    }
  }

  /** Live snapshot of the solver config (the panel reads this to seed its controls). */
  getSimConfig(): SimConfig {
    return { ...SIM_CONFIG };
  }

  /**
   * Update solver parameters. Anchor/self-collision are uniform writes (apply live); the rest are
   * baked into the compute shaders at build time, so we rebuild the sim from the current drape and
   * resume — the cloth keeps its shape and the new params take effect immediately.
   */
  async setSimConfig(partial: Partial<SimConfig>): Promise<void> {
    Object.assign(SIM_CONFIG, partial);
    // deltaT is derived from timeStep/subSteps (the shaders bake it), so keep it in sync.
    if ('timeStep' in partial || 'subSteps' in partial) {
      SIM_CONFIG.deltaT = SIM_CONFIG.timeStep / Math.max(1, SIM_CONFIG.subSteps);
    }
    if (this.sim) this.sim.setSelfCollision(SIM_CONFIG.handleSelfCollisions);
    // Params that change shader code need a rebuilt engine; preserve the live positions across it.
    // (timeStep/subSteps/max/minVelocity are baked as WGSL constants; useBending gates the bend pass.)
    const bakedKeys: (keyof SimConfig)[] = ['gravity', 'globalDamping', 'localDamping', 'nearDamping', 'simulationThickness', 'edgeThickness', 'seamStrength', 'selfCollisionFriction', 'externalCollisionFriction', 'seamIterations', 'handleExternalCollisions', 'timeStep', 'subSteps', 'maxVelocity', 'minVelocity', 'useBending'];
    if (!this.sim || !bakedKeys.some((k) => k in partial)) return;
    const pos = this.sim.positions.slice();
    const wasSim = this.simulating;
    this.simulating = false; // halt the loop without firing onDrapeSettled
    await Promise.resolve();
    this.sim.dispose();
    this.sim = null;
    const sim = await this.ensureSim();
    if (!sim) return;
    sim.resetTo(pos);
    this.applyClothPositions(pos);
    sim.setSelfCollision(SIM_CONFIG.handleSelfCollisions);
    if (wasSim) {
      sim.setAnchorScale(this.liveAnchorScale);
      this.simulating = true;
      this.userSimulating = true;
      this.onStatus('simulating');
      void this.runSimLoop();
    }
  }

  // ---- Frozen snapshot: a translucent "ghost" of the drape at a moment, as a reference overlay ----
  private snapshotGroup: THREE.Group | null = null;

  /** Freeze the current drape as a translucent ghost reference (replaces any previous one). */
  freezeSnapshot(opacity = 0.35): void {
    this.clearSnapshot();
    if (!this.clothMeshes.length) return;
    const group = new THREE.Group();
    for (const e of this.clothMeshes) {
      const src = e.geometry.getAttribute('position') as THREE.BufferAttribute;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute((src.array as Float32Array).slice(), 3));
      if (e.geometry.index) geo.setIndex(Array.from(e.geometry.index.array as ArrayLike<number>));
      geo.computeVertexNormals();
      const mat = new THREE.MeshStandardMaterial({ color: 0x4f9cff, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide, roughness: 0.85, metalness: 0 });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      mesh.renderOrder = 2;
      group.add(mesh);
    }
    this.scene.add(group);
    this.snapshotGroup = group;
  }

  clearSnapshot(): void {
    if (!this.snapshotGroup) return;
    this.scene.remove(this.snapshotGroup);
    for (const c of this.snapshotGroup.children) {
      const m = c as THREE.Mesh;
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    this.snapshotGroup = null;
  }

  setSnapshotOpacity(o: number): void {
    if (!this.snapshotGroup) return;
    for (const c of this.snapshotGroup.children) ((c as THREE.Mesh).material as THREE.MeshStandardMaterial).opacity = o;
  }

  hasSnapshot(): boolean {
    return !!this.snapshotGroup;
  }

  // ---- 3D seam lines: thin segments connecting sewn particle pairs, toggled by "Show seams" ----
  private seamLines: THREE.LineSegments | null = null;
  private seamPairs: number[] = []; // flat [a0,b0,a1,b1,...] global particle indices
  private showSeams3d = false;

  private buildSeamLines(): void {
    if (!this.prepared) return;
    const s = this.prepared.simData.seams;
    const n = this.prepared.simData.particleCount;
    this.seamPairs = [];
    for (let i = 0; i < n; i++) for (let j = 0; j < 4; j++) {
      const p = s[i * 4 + j];
      if (p > i) this.seamPairs.push(i, p); // partner > i dedupes the symmetric entry
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.seamPairs.length * 3), 3));
    const mat = new THREE.LineBasicMaterial({ color: 0xff3b6b, transparent: true, opacity: 0.9 });
    this.seamLines = new THREE.LineSegments(geo, mat);
    this.seamLines.frustumCulled = false;
    this.seamLines.renderOrder = 3;
    this.clothGroup.add(this.seamLines);
  }

  private updateSeamLines(global: Float32Array): void {
    if (!this.seamLines || !this.seamLines.visible) return;
    const attr = this.seamLines.geometry.getAttribute('position') as THREE.BufferAttribute;
    const arr = attr.array as Float32Array;
    for (let k = 0; k < this.seamPairs.length; k++) {
      const g = this.seamPairs[k];
      arr[k * 3] = global[g * 4]; arr[k * 3 + 1] = global[g * 4 + 1]; arr[k * 3 + 2] = global[g * 4 + 2];
    }
    attr.needsUpdate = true;
  }

  private clearSeamLines(): void {
    if (!this.seamLines) return;
    this.clothGroup.remove(this.seamLines);
    this.seamLines.geometry.dispose();
    (this.seamLines.material as THREE.Material).dispose();
    this.seamLines = null;
    this.seamPairs = [];
  }

  /** Toggle the 3D seam overlay (lines between sewn edges). */
  setShowSeams(on: boolean): void {
    this.showSeams3d = on;
    if (on && !this.seamLines) this.buildSeamLines();
    if (this.seamLines) {
      this.seamLines.visible = on;
      if (on) this.updateSeamLines(this.lastClothPositions ?? this.prepared?.simData.positions ?? new Float32Array());
    }
  }

  /** Snap the camera to an orthographic-style preset around the current target. */
  setCameraView(view: 'front' | 'back' | 'left' | 'right' | 'top' | 'reset'): void {
    if (view === 'reset') {
      this.camera.position.set(0.5, 0.9, 1.6);
      this.controls.target.set(0, 0.9, 0);
      this.controls.update();
      return;
    }
    const t = this.controls.target;
    const dist = this.camera.position.distanceTo(t) || 1.8;
    const off = new THREE.Vector3();
    if (view === 'front') off.set(0, 0, dist);
    else if (view === 'back') off.set(0, 0, -dist);
    else if (view === 'left') off.set(-dist, 0, 0);
    else if (view === 'right') off.set(dist, 0, 0);
    else off.set(0, dist, 0.001); // top (tiny z avoids a degenerate up vector)
    this.camera.position.copy(t).add(off);
    this.camera.lookAt(t);
    this.controls.update();
  }

  /** Camera field of view (degrees). */
  getCameraFov(): number {
    return this.camera.fov;
  }
  setCameraFov(deg: number): void {
    this.camera.fov = Math.max(10, Math.min(120, deg));
    this.camera.updateProjectionMatrix();
  }

  /** Capture the current 3D view as a PNG data URL. Renders a fresh frame first, then reads the
   *  canvas in the same tick (so it works without preserveDrawingBuffer). */
  captureImage(): string {
    if (this.composer && this.postEnabled) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL('image/png');
  }

  /** Export the avatar + draped garment as an OBJ download. */
  exportOBJ(): string {
    const exporter = new OBJExporter();
    return exporter.parse(this.buildExportGroup());
  }

  /** Export the avatar + draped garment as binary STL (e.g. for 3D printing/CAD). */
  async exportSTL(): Promise<DataView> {
    const { STLExporter } = await import('three/examples/jsm/exporters/STLExporter.js');
    const exporter = new STLExporter();
    return exporter.parse(this.buildExportGroup(), { binary: true }) as DataView;
  }

  /** Avatar + visible cloth meshes cloned into a detached group with current world matrices. */
  private buildExportGroup(): THREE.Group {
    const group = new THREE.Group();
    if (this.avatar?.mesh && this.avatar.mesh.visible) group.add(this.avatar.mesh.clone());
    for (const e of this.clothMeshes) if (e.mesh.visible) group.add(e.mesh.clone());
    group.updateMatrixWorld(true);
    return group;
  }

  dispose() {
    this.disposed = true;
    this.simulating = false;
    cancelAnimationFrame(this.rafId);
    window.removeEventListener('resize', this.onResize);
    this.themeUnsub();
    if (this.mode === 'arrange') this.exitArrangeMode();
    this.transform?.detach();
    this.transform?.dispose();
    this.sim?.dispose();
    this.clearClothMeshes();
    this.avatar?.dispose();
    this.scene.environment = null;
    for (const t of this.envCache.values()) t.dispose();
    this.envCache.clear();
    this.pmrem?.dispose();
    try { this.composer?.dispose(); } catch { /* ignore */ }
    this.renderer.dispose();
    if (this.renderer.domElement.parentElement === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
  }
}
