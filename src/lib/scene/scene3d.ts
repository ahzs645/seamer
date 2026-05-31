// 3D scene: WebGLRenderer + camera + OrbitControls + lighting + floor, the parametric avatar, and
// the garment cloth meshes. Rendering runs on requestAnimationFrame; the WebGPU cloth solve runs in
// a separate self-paced async loop and writes results back into the cloth geometry.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { OBJExporter } from 'three/examples/jsm/exporters/OBJExporter.js';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import type { Pattern, Material } from '$lib/types/pattern';
import { AvatarController } from '$lib/model/avatarController';
import { buildCylinders, type CylinderFrame } from '$lib/geometry/cylinders';
import { prepareCloth, ClothSimulation, type PreparedCloth } from '$lib/sim/simulator';
import { cylinderRefit } from '$lib/sim/cylinderRefit';
import { requestClothDevice, isWebGPUAvailable } from '$lib/sim/webgpu/device';
import { createGarmentMaterial, createAvatarMaterial, hasSeparateBack } from './materials';

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
  private lightRig: THREE.Object3D[] = [];
  private lightRigBase: number[] = []; // base intensities, scaled down when an HDRI env is active
  private pmrem: THREE.PMREMGenerator | null = null;
  private envCache = new Map<string, THREE.Texture>();
  private lightingMode = 'flat';

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
  // while staying faithful to the source's shape. (Verified: 0.25 keeps the waistband within ~5mm of
  // the source drape vs ~24mm fully free, while moving far more than the old rigid 1.0.)
  private static readonly LIVE_ANCHOR = 0.25;
  private liveAnchorScale = PatternRenderer.LIVE_ANCHOR; // restored after an interactive grab

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
  onModeChange: (mode: SceneMode, selectedPieceId: string | null) => void = () => {};
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
      this.selectArrange(idx);
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

    this.renderLoop();
    window.addEventListener('resize', this.onResize);
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
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(20, 20),
      new THREE.MeshStandardMaterial({ color: '#c8ccd2', roughness: 0.9, metalness: 0, depthWrite: true })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor);
    const grid = new THREE.GridHelper(8, 32, 0xb0b4ba, 0xc4c8ce);
    grid.position.y = 0.002;
    (grid.material as THREE.Material).opacity = 0.4;
    (grid.material as THREE.Material).transparent = true;
    this.scene.add(grid);
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
        if (this.transform && this.transform.axis) return; // clicking a gizmo handle -> let it drag
        setNdc(ev);
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
      // selecting/highlighting the picked piece so the 2D editor stays in sync
      this.setHighlightedPiece(entry.pieceId);
      this.onSelectPiece(entry.pieceId);
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
    // Free the WHOLE garment during a drag so it moves as one connected piece (panels held together
    // by their seams) and follows the cursor — not pinned, so seams don't pull open. Self-collision
    // off during the drag: it's what curls a free garment, and the trousers don't self-intersect in
    // normal dragging; seams + near-damping keep it coherent.
    sim.setAnchorScale(0);
    sim.setSelfCollision(false);
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
  };

  private renderLoop = () => {
    if (this.disposed) return;
    this.rafId = requestAnimationFrame(this.renderLoop);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  /** Build or update the avatar + cloth for a pattern. */
  async setPattern(pattern: Pattern): Promise<void> {
    this.pattern = pattern;
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
      this.rebuildCloth(pattern);
      this.onStatus('ready');
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

  /** Triangulate + arrange the garment and (re)build the static cloth meshes. */
  private rebuildCloth(pattern: Pattern) {
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
    this.prepared = prepareCloth({ pattern, avatarVertices: verts, avatarIndices: indices, cylinders: this.cylinders });
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
      // Our cloth triangles wind with their geometric front face pointing INWARD, so the outward
      // surface the camera sees is the BackSide. For a separate back texture we therefore render the
      // FACE (front) texture on a BackSide mesh (shows outward) and the back texture on a FrontSide
      // mesh (shows inward). With a single double-sided material this doesn't matter (both sides same).
      const mat = createGarmentMaterial(pieceMat, flat, separateBack ? { side: THREE.BackSide } : {});
      mat.wireframe = this.showTriangles;
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      const srcPiece = pattern.pieces.find((p) => p.id === piece.pieceId);
      const hidden = !!srcPiece?.hidden; // object-browser visibility toggle
      mesh.visible = !hidden;
      this.clothGroup.add(mesh);
      // separate back side: a second mesh on the same (deforming) geometry, back faces only
      let backMesh: THREE.Mesh | undefined;
      if (separateBack) {
        const backMat = createGarmentMaterial(pieceMat, flat, { side: THREE.FrontSide, back: true });
        backMat.wireframe = this.showTriangles;
        backMesh = new THREE.Mesh(geo, backMat);
        backMesh.castShadow = true; backMesh.receiveShadow = true; backMesh.frustumCulled = false;
        backMesh.visible = !hidden;
        this.clothGroup.add(backMesh);
        this.clothBackMeshes.push(backMesh);
      }
      this.clothMeshes.push({ pieceId: piece.pieceId, start: piece.start, count: piece.count, geometry: geo, mesh, backMesh });

      const name = srcPiece?.name ?? 'Piece';
      const { obj, aspect } = this.makeLabel(`${name} face side`);
      obj.visible = this.showLabels && !hidden;
      this.clothGroup.add(obj);
      this.pieceLabels.push({ pieceId: piece.pieceId, obj, aspect });
    }
    this.applyClothPositions(this.prepared.simData.positions);
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

      // park the piece's label at its (live) centroid
      const label = this.pieceLabels.find((l) => l.pieceId === entry.pieceId);
      if (!label || entry.count === 0) continue;
      const cen = new THREE.Vector3(cx / entry.count, cy / entry.count, cz / entry.count);
      if (this.labelMode === 'flat' && label.obj instanceof THREE.Mesh) {
        // orient the plane flat on the fabric using the surface normal nearest the centroid
        // (local orientation at the label's spot), lifted slightly off the cloth.
        const nattr = entry.geometry.getAttribute('normal') as THREE.BufferAttribute;
        let nearest = 0, nbest = Infinity;
        for (let i = 0; i < entry.count; i++) {
          const dx = arr[i * 3] - cen.x, dy = arr[i * 3 + 1] - cen.y, dz = arr[i * 3 + 2] - cen.z;
          const d = dx * dx + dy * dy + dz * dz;
          if (d < nbest) { nbest = d; nearest = i; }
        }
        const n = new THREE.Vector3(nattr.getX(nearest), nattr.getY(nearest), nattr.getZ(nearest));
        if (n.lengthSq() < 1e-9) n.set(0, 0, 1);
        n.normalize();
        // sit the label on the local surface vertex, lifted 3mm along its normal
        label.obj.position.set(arr[nearest * 3], arr[nearest * 3 + 1], arr[nearest * 3 + 2]).addScaledVector(n, 0.003);
        const up = Math.abs(n.y) > 0.95 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
        const x = new THREE.Vector3().crossVectors(up, n).normalize();
        const y = new THREE.Vector3().crossVectors(n, x).normalize();
        label.obj.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, n));
      } else {
        label.obj.position.copy(cen);
      }
    }
  }

  private clearClothMeshes() {
    for (const e of this.clothMeshes) {
      this.clothGroup.remove(e.mesh);
      e.geometry.dispose();
      (e.mesh.material as THREE.Material).dispose();
    }
    this.clothMeshes = [];
    for (const b of this.clothBackMeshes) { this.clothGroup.remove(b); (b.material as THREE.Material).dispose(); }
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

  /** A piece label as either a camera-facing billboard sprite or a flat plane on the fabric. */
  private makeLabel(text: string): { obj: THREE.Object3D; aspect: number } {
    const { tex, aspect } = this.makeLabelTexture(text);
    const H = 0.05; // world height of the label (meters)
    if (this.labelMode === 'flat') {
      const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(H * aspect, H), mat);
      mesh.renderOrder = 999;
      return { obj: mesh, aspect };
    }
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: true });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(H * aspect, H, 1);
    return { obj: sprite, aspect };
  }

  /** Toggle the garment piece labels. */
  setShowLabels(on: boolean): void {
    this.showLabels = on;
    for (const l of this.pieceLabels) {
      const mesh = this.clothMeshes.find((e) => e.pieceId === l.pieceId)?.mesh;
      l.obj.visible = on && (mesh ? mesh.visible : true);
    }
  }

  /** Switch label style between camera-facing (billboard) and pinned-to-fabric (flat). */
  setLabelMode(mode: 'billboard' | 'flat'): void {
    if (mode === this.labelMode) return;
    this.labelMode = mode;
    if (this.pattern) this.rebuildLabels(this.pattern);
  }

  private rebuildLabels(pattern: Pattern): void {
    for (const l of this.pieceLabels) {
      this.clothGroup.remove(l.obj);
      const m = (l.obj as THREE.Sprite | THREE.Mesh).material as THREE.SpriteMaterial | THREE.MeshBasicMaterial;
      (m.map as THREE.Texture | null)?.dispose();
      m.dispose();
      if (l.obj instanceof THREE.Mesh) l.obj.geometry.dispose();
    }
    this.pieceLabels = [];
    for (const entry of this.clothMeshes) {
      const name = pattern.pieces.find((p) => p.id === entry.pieceId)?.name ?? 'Piece';
      const { obj, aspect } = this.makeLabel(`${name} face side`);
      obj.visible = this.showLabels && entry.mesh.visible;
      this.clothGroup.add(obj);
      this.pieceLabels.push({ pieceId: entry.pieceId, obj, aspect });
    }
    if (this.prepared) this.applyClothPositions(this.lastClothPositions ?? this.prepared.simData.positions);
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
        sim.seedAndHold(refit, PatternRenderer.LIVE_ANCHOR);
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
        sim.setAnchorScale(PatternRenderer.LIVE_ANCHOR);
        this.adaptFramesLeft = 0;
      }
      this.liveAnchorScale = this.bodyDirty ? 0.3 : PatternRenderer.LIVE_ANCHOR; // restore after a grab
      this.userSimulating = true; // user-started: keep running across grab/release
      this.simulating = true;
      this.onStatus('simulating');
      void this.runSimLoop();
    } catch (e) {
      this.simulating = false;
      this.onStatus('error', e instanceof Error ? e.message : String(e));
    }
  }

  private async runSimLoop() {
    while (this.simulating && this.sim && !this.disposed) {
      try {
        const positions = await this.sim.step();
        if (positions.length) this.applyClothPositions(positions);
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

  /** Enter arrange mode: show pieces flat-on-body, each individually selectable + movable. */
  enterArrangeMode(): void {
    if (this.mode === 'arrange' || !this.prepared || !this.pattern) return;
    this.stopSimulation();
    this.mode = 'arrange';
    this.clothGroup.visible = false; // hide the draped meshes
    this.scene.add(this.arrangeGroup);

    const arranged = this.prepared.simData.arrangedPositions; // stride-4 world (flat-on-body)
    const flat = this.pattern.settings3d.lightingMode === 'flat';
    const matById = new Map<string, Material>();
    for (const m of this.pattern.materials) matById.set(m.id, m);

    for (const piece of this.prepared.simData.pieces) {
      const c = new THREE.Vector3();
      for (let i = 0; i < piece.count; i++) {
        const g = piece.start + i;
        c.x += arranged[g * 4]; c.y += arranged[g * 4 + 1]; c.z += arranged[g * 4 + 2];
      }
      c.multiplyScalar(1 / Math.max(1, piece.count));
      const baseLocal = new Float32Array(piece.count * 3);
      const pos = new Float32Array(piece.count * 3);
      for (let i = 0; i < piece.count; i++) {
        const g = piece.start + i;
        const lx = arranged[g * 4] - c.x, ly = arranged[g * 4 + 1] - c.y, lz = arranged[g * 4 + 2] - c.z;
        baseLocal[i * 3] = lx; baseLocal[i * 3 + 1] = ly; baseLocal[i * 3 + 2] = lz;
        pos[i * 3] = lx; pos[i * 3 + 1] = ly; pos[i * 3 + 2] = lz;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(piece.uv.slice(), 2));
      geo.setIndex(piece.triangles.map((g) => g - piece.start));
      geo.computeVertexNormals();
      const mat = createGarmentMaterial(matById.get(piece.materialId), flat);
      mat.wireframe = this.showTriangles;
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      const group = new THREE.Group();
      group.position.copy(c);
      group.add(mesh);
      group.visible = !this.pattern.pieces.find((p) => p.id === piece.pieceId)?.hidden;
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
    this.onModeChange('arrange', null);
  }

  /** Select an arrange piece by index (-1 clears). Highlights it and attaches the gizmo. */
  private selectArrange(idx: number): void {
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
      this.onModeChange('arrange', e.pieceId);
      this.onSelectPiece(e.pieceId);
    } else {
      this.transform?.detach();
      this.onModeChange('arrange', null);
    }
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
      (e.mesh.material as THREE.Material).dispose();
    }
    this.arrangeEntries = [];
    this.scene.remove(this.arrangeGroup);
    this.clothGroup.visible = true;
    this.mode = 'view';
    this.onModeChange('view', null);
  }

  /** Drape from the current arrangement: seed the sim with the moved pieces and free-simulate. */
  async simulateFromArrangement(): Promise<void> {
    if (this.mode !== 'arrange' || !this.prepared) return;
    const seed = this.arrangedSeed();
    this.exitArrangeMode();
    const sim = await this.ensureSim();
    if (!sim) { this.applyClothPositions(seed); return; }
    sim.resetTo(seed);
    this.applyClothPositions(seed);
    // Drape freely from the user's arrangement (no cached drape applies); self-collision off avoids
    // the free-settle curl, matching the interactive-drag behaviour.
    sim.setAnchorScale(0);
    sim.setSelfCollision(false);
    this.bodyDirty = false;
    this.adaptFramesLeft = 0;
    this.userSimulating = false; // arrangement drape is a one-shot settle: grab→freeze on release
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

  /** Export the avatar + draped garment as an OBJ download. */
  exportOBJ(): string {
    const group = new THREE.Group();
    if (this.avatar?.mesh) group.add(this.avatar.mesh.clone());
    for (const e of this.clothMeshes) group.add(e.mesh.clone());
    const exporter = new OBJExporter();
    return exporter.parse(group);
  }

  dispose() {
    this.disposed = true;
    this.simulating = false;
    cancelAnimationFrame(this.rafId);
    window.removeEventListener('resize', this.onResize);
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
    this.renderer.dispose();
    if (this.renderer.domElement.parentElement === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
  }
}
