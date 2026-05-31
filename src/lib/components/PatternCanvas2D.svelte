<script lang="ts">
  import { onMount } from 'svelte';
  import type { Pattern, Piece } from '$lib/types/pattern';
  import { buildSilhouette, type Silhouette } from '$lib/model/silhouette';
  import { isDarkTheme, onThemeChange } from '$lib/utils/theme';
  import DrawingTools from '$lib/components/DrawingTools.svelte';
  import ContextMenu, { type MenuItem } from '$lib/components/ContextMenu.svelte';
  import { toast } from '$lib/stores/toast';
  import { selectedTool, zoom, panOffset, selectedPointIds, selectedPathIds, selectedPieceIds } from '$lib/stores/pattern';
  import {
    indexPoints,
    indexPaths,
    pathPolyline,
    pieceWorldOutline,
    pieceWorldInternalPolylines,
    pieceTransform,
    piecePathPolyline,
    placedPoints,
    allSeamGeometry,
    seamColor,
    polygonCentroid,
    pointInPolygon,
    type Vec2,
    type PlacedPoint
  } from '$lib/utils/patternGeometry';
  import { deletePiece as deletePieceCascade } from '$lib/utils/patternMutations';

  interface Props {
    currentPattern: Pattern;
    onchange: (p: Pattern) => void;
  }

  let { currentPattern, onchange }: Props = $props();

  let canvasEl: HTMLCanvasElement;
  let ctx: CanvasRenderingContext2D | null = $state(null);
  let isDark = $state(false); // follows the app theme (utils/theme); themes the canvas bg/grid
  let canvasW = $state(800);
  let canvasH = $state(600);
  let isPanning = $state(false);
  let isDragging = $state(false);
  let dragPointId: string | null = $state(null);
  let dragInvert: ((w: Vec2) => Vec2) | null = null;
  let dragStartWorld: Vec2 | null = null;
  let dragStartX = 0;
  let dragStartY = 0;
  let currentZoom = $state(1);
  let currentPanX = $state(0);
  let currentPanY = $state(0);
  let hoveredPointId: string | null = $state(null);
  let cursorPos = $state({ x: 0, y: 0 });
  let measureFrom: string | null = $state(null);
  let showSeams = $state(false); // manual "pin seams on" override; otherwise seams show with the seam tool
  let showBody = $state(true);
  const isSeamToolActive = () => $selectedTool === 'seam' || $selectedTool === 'seam-single' || $selectedTool === 'seam-multi';
  // pen / create-piece in-progress point ids
  let penDraft = $state<string[]>([]);
  let draftPathId: string | null = null;
  // seam tool: first picked piece-path edge (single) / accumulated edges (multi)
  let seamFirstEdge: string | null = $state(null);
  let seamMultiEdges: string[] = $state([]);
  let contextMenu = $state<{ x: number; y: number; items: MenuItem[] } | null>(null);
  // marquee (rubber-band) selection
  let isMarquee = $state(false);
  let marqueeStart = { x: 0, y: 0 };
  let marqueeCur = $state({ x: 0, y: 0 });
  // multi-point drag: original drafting-space positions + the primary point's transform
  let dragDraftStart: Vec2 | null = null;
  let multiDrag: { id: string; x: number; y: number }[] | null = null;
  // arc/circle tools: accumulated world-space clicks
  let arcClicks = $state<Vec2[]>([]);
  // pen drag-for-curve
  let penDragging = false;
  let penDragPointId: string | null = null;
  let silhouette: Silhouette | null = null;
  let silhouetteKey = '';
  // local view center (world point shown at canvas center); never mutate the pattern prop.
  let viewOffset = $state({ x: 0, y: 0 });

  const GRID_MM = 25.4; // 1 inch
  const POINT_RADIUS = 4;
  const HOVER_THRESHOLD = 12;
  const SELECT_BLUE = '#2563eb';
  const GRAIN_MAGENTA = '#e11d8f';
  const PATH_MAGENTA = '#ff50cf'; // sewn-edge colour, matching the source 2D editor

  // ---- fabric textures ------------------------------------------------------
  // Material front textures are remote media URLs; we serve a local copy by
  // basename under /textures and tile it in world-mm space on the piece fill.
  const texImages = new Map<string, HTMLImageElement>(); // url -> loaded image
  function textureFor(url: string | undefined | null): HTMLImageElement | null {
    if (!url) return null;
    if (texImages.has(url)) {
      const img = texImages.get(url)!;
      return img.complete && img.naturalWidth > 0 ? img : null;
    }
    const img = new Image();
    img.onload = () => render();
    if (url.startsWith('data:') || url.startsWith('blob:')) {
      img.src = url; // user-supplied image
    } else {
      // bundled media URLs are served from a local copy by basename
      const base = url.split('/').pop()?.split('?')[0] ?? '';
      img.src = `/textures/${base}`;
    }
    texImages.set(url, img);
    return null;
  }
  function materialOf(id: string) {
    const mats = currentPattern.materials ?? [];
    return mats.find((m) => m.id === id) ?? mats[0] ?? null;
  }

  // ---- layers: visibility / lock --------------------------------------------
  function layerOf(layerId?: string) {
    return (currentPattern.layers ?? []).find((l) => l.id === (layerId ?? 'default'));
  }
  const layerVisible = (layerId?: string) => layerOf(layerId)?.visible ?? true;
  const layerLocked = (layerId?: string) => layerOf(layerId)?.locked ?? false;

  /** A fabric-tiled CanvasPattern (aligned to world mm) or a flat color fallback. */
  function pieceFill(c: CanvasRenderingContext2D, material: ReturnType<typeof materialOf>): string | CanvasPattern {
    const tex = material?.frontTexture;
    const img = tex ? textureFor(tex.url) : null;
    if (img && tex) {
      const pat = c.createPattern(img, 'repeat');
      if (pat) {
        const mm = tex.scale && tex.scale > 0 ? tex.scale : 100;
        const f = (mm * baseScale()) / img.naturalWidth;
        const o = toCanvas({ x: 0, y: 0 });
        pat.setTransform(new DOMMatrix([f, 0, 0, f, o.x, o.y]));
        return pat;
      }
    }
    return tex?.color || 'rgba(148,163,184,0.16)';
  }

  function fmtLen(mm: number): string {
    const u = currentPattern.lengthUnit;
    const v = u === 'inch' ? mm / 25.4 : u === 'cm' ? mm / 10 : mm;
    return `${v.toFixed(1)} ${u}`;
  }

  function polyLen(poly: Vec2[]): number {
    let s = 0;
    for (let i = 1; i < poly.length; i++) s += Math.hypot(poly[i].x - poly[i - 1].x, poly[i].y - poly[i - 1].y);
    return s;
  }

  /** Rounded pill name tag for a piece (matches the source's centred badge). */
  function pieceNameChip(c: CanvasRenderingContext2D, text: string, x: number, y: number) {
    c.font = '600 12px "Noto Sans", sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    const w = c.measureText(text).width + 16;
    const h = 19;
    const rx = x - w / 2, ry = y - h / 2, r = 6;
    c.beginPath();
    c.moveTo(rx + r, ry);
    c.arcTo(rx + w, ry, rx + w, ry + h, r);
    c.arcTo(rx + w, ry + h, rx, ry + h, r);
    c.arcTo(rx, ry + h, rx, ry, r);
    c.arcTo(rx, ry, rx + w, ry, r);
    c.closePath();
    c.fillStyle = 'rgba(248,250,252,0.92)';
    c.fill();
    c.strokeStyle = 'rgba(100,116,139,0.35)';
    c.lineWidth = 1;
    c.stroke();
    c.fillStyle = '#334155';
    c.fillText(text, x, y + 0.5);
    c.textAlign = 'start';
    c.textBaseline = 'alphabetic';
  }

  function labelChip(c: CanvasRenderingContext2D, text: string, x: number, y: number, fg = '#be185d', bg = 'rgba(255,255,255,0.85)') {
    c.font = '10px sans-serif';
    c.textAlign = 'center';
    const w = c.measureText(text).width;
    c.fillStyle = bg;
    c.fillRect(x - w / 2 - 3, y - 7, w + 6, 13);
    c.fillStyle = fg;
    c.fillText(text, x, y + 2);
    c.textAlign = 'start';
  }

  /** Length label at the midpoint of each main edge of a (selected) piece. */
  /**
   * Draw the single selected boundary edge the way the source does when you click a line:
   * highlight it magenta with a direction arrow + length label, and show salmon bezier
   * tangent handles on its anchor points.
   */
  function drawSelectedEdge(
    c: CanvasRenderingContext2D,
    paths: ReturnType<typeof indexPaths>,
    points: ReturnType<typeof indexPoints>
  ) {
    // the selected edge = the (selected) piece's path matching the single selected ConstrainablePath
    if ($selectedPathIds.size !== 1) return;
    const pathId = [...$selectedPathIds][0];
    let owner: { piece: Piece; pp: import('$lib/types/pattern').PiecePath } | null = null;
    for (const piece of currentPattern.pieces) {
      if (piece.hidden) continue;
      if ($selectedPieceIds.size > 0 && !$selectedPieceIds.has(piece.id)) continue;
      const pp = [...piece.mainPaths, ...piece.internalPaths].find((x) => x.path === pathId);
      if (pp) { owner = { piece, pp }; break; }
    }
    if (!owner) return;
    const tf = pieceTransform(owner.piece, points);
    const poly = piecePathPolyline(owner.pp, paths, points, 4).map(tf);
    if (poly.length < 2) return;

    // highlighted edge
    c.strokeStyle = PATH_MAGENTA;
    c.lineWidth = 2.5;
    tracePoly(c, poly, false);
    c.stroke();

    // direction arrow at the midpoint
    const mi = Math.floor(poly.length / 2);
    const m0 = toCanvas(poly[Math.max(0, mi - 1)]);
    const m1 = toCanvas(poly[Math.min(poly.length - 1, mi + 1)]);
    const ang = Math.atan2(m1.y - m0.y, m1.x - m0.x);
    const mc = toCanvas(poly[mi]);
    c.fillStyle = PATH_MAGENTA;
    c.beginPath();
    c.moveTo(mc.x, mc.y);
    c.lineTo(mc.x - 8 * Math.cos(ang - 0.4), mc.y - 8 * Math.sin(ang - 0.4));
    c.lineTo(mc.x - 8 * Math.cos(ang + 0.4), mc.y - 8 * Math.sin(ang + 0.4));
    c.closePath(); c.fill();

    // length label
    labelChip(c, fmtLen(polyLen(poly)), mc.x + 12, mc.y);

    // green anchor endpoints + salmon bezier handles
    const path = paths.get(owner.pp.path);
    if (path) {
      const salmon = '#fb7185';
      for (const ap of path.pathPoints) {
        const anchor = points.get(ap.id);
        if (!anchor) continue;
        const aw = toCanvas(tf(anchor));
        c.beginPath(); c.arc(aw.x, aw.y, 4, 0, Math.PI * 2); c.fillStyle = '#22c55e'; c.fill();
        if (!ap.handle) continue;
        for (const v of [ap.handle.v1, ap.handle.v2]) {
          if (!v || (v.x === 0 && v.y === 0)) continue;
          const hw = toCanvas(tf({ x: anchor.x + v.x, y: anchor.y + v.y }));
          c.strokeStyle = salmon; c.lineWidth = 1;
          c.beginPath(); c.moveTo(aw.x, aw.y); c.lineTo(hw.x, hw.y); c.stroke();
          c.beginPath(); c.arc(hw.x, hw.y, 3.5, 0, Math.PI * 2); c.fillStyle = salmon; c.fill();
        }
      }
    }
  }

  /** (Re)build the real avatar silhouette raster when the body changes. */
  async function ensureSilhouette() {
    const b = currentPattern.body;
    const key = JSON.stringify({ g: b.gender, u: b.unitType, f: b.fields });
    if (key === silhouetteKey) return;
    silhouetteKey = key;
    try {
      const s = await buildSilhouette(b);
      if (s && silhouetteKey === key) { silhouette = s; render(); }
    } catch { /* assets unavailable — skip the silhouette */ }
  }

  /**
   * Blit the avatar silhouette behind the pieces. True scale, centred on the x=0 draft
   * axis, vertically centred on the spread of pieces (decorative reference, as in the source).
   */
  function drawSilhouette(c: CanvasRenderingContext2D, piecesMinY: number, piecesMaxY: number) {
    const s = silhouette;
    if (!s) return;
    const offY = (piecesMinY + piecesMaxY) / 2 - (s.minY + s.maxY) / 2;
    const tl = toCanvas({ x: s.minX, y: s.maxY + offY }); // world maxY -> canvas top
    const br = toCanvas({ x: s.maxX, y: s.minY + offY });
    const w = br.x - tl.x, h = br.y - tl.y;
    if (w <= 0 || h <= 0) return;
    c.save();
    c.globalAlpha = 0.35;
    c.drawImage(s.canvas, tl.x, tl.y, w, h);
    c.restore();
  }

  onMount(() => {
    ctx = canvasEl.getContext('2d');
    const observer = new ResizeObserver(() => {
      canvasW = canvasEl.clientWidth;
      canvasH = canvasEl.clientHeight;
      canvasEl.width = canvasW;
      canvasEl.height = canvasH;
      render();
    });
    if (canvasEl.parentElement) observer.observe(canvasEl.parentElement);
    const unsubZoom = zoom.subscribe((v) => { currentZoom = v; render(); });
    const unsubPan = panOffset.subscribe((v) => { currentPanX = v.x; currentPanY = v.y; render(); });
    // re-render when selection changes (e.g. driven from the 3D view)
    const unsubSelPc = selectedPieceIds.subscribe(() => render());
    const unsubSelPt = selectedPointIds.subscribe(() => render());
    const unsubSelPath = selectedPathIds.subscribe(() => render());
    const unsubTool = selectedTool.subscribe(() => render());
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const drawing = isDrawingTool($selectedTool);
      if (e.key === 'Enter') {
        if (penDraft.length > 0) { e.preventDefault(); finishDraft(); }
        else if (seamMultiEdges.length > 0) { e.preventDefault(); finishMultiSeam(); }
      } else if (e.key === 'Escape') {
        if (penDraft.length || seamFirstEdge || seamMultiEdges.length || drawing) { e.preventDefault(); cancelOperation(); }
      } else if ((e.key === 'v' || e.key === 'V') && drawing && !e.metaKey && !e.ctrlKey) {
        // 'V' returns to select and cancels the in-progress operation (like the source)
        e.preventDefault(); cancelOperation();
      }
    };
    window.addEventListener('keydown', onKey);
    isDark = isDarkTheme();
    const unsubTheme = onThemeChange(() => { isDark = isDarkTheme(); render(); });
    render();
    return () => { observer.disconnect(); unsubZoom(); unsubPan(); unsubSelPc(); unsubSelPt(); unsubSelPath(); unsubTool(); unsubTheme(); window.removeEventListener('keydown', onKey); };
  });

  let lastFitKey = '';
  $effect(() => {
    const key = `${currentPattern.id}:${currentPattern.points.length}`;
    if (key !== lastFitKey) { lastFitKey = key; if (ctx) fitView(); }
    void currentPattern.body; // rebuild silhouette when measurements/gender change
    ensureSilhouette();
    void currentPattern;
    render();
  });

  function baseScale(): number { return currentPattern.graphicsScale * currentZoom; }

  function toCanvas(pt: Vec2): Vec2 {
    const o = viewOffset;
    const s = baseScale();
    return {
      x: canvasW / 2 + (pt.x - o.x) * s + currentPanX,
      y: canvasH / 2 - (pt.y - o.y) * s + currentPanY
    };
  }

  function toPattern(cx: number, cy: number): Vec2 {
    const o = viewOffset;
    const s = baseScale();
    return {
      x: (cx - canvasW / 2 - currentPanX) / s + o.x,
      y: -(cy - canvasH / 2 - currentPanY) / s + o.y
    };
  }

  function fitView() {
    const placed = placedPoints(currentPattern);
    if (placed.length === 0) { zoom.set(1); panOffset.set({ x: 0, y: 0 }); return; }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const pp of placed) {
      const p = pp.world;
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    const w = Math.max(1, maxX - minX);
    const h = Math.max(1, maxY - minY);
    const pad = 1.2;
    const sx = canvasW / (w * pad * currentPattern.graphicsScale);
    const sy = canvasH / (h * pad * currentPattern.graphicsScale);
    zoom.set(Math.max(0.05, Math.min(20, Math.min(sx, sy))));
    viewOffset = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
    panOffset.set({ x: 0, y: 0 });
  }

  function hitTestPlaced(cx: number, cy: number, threshold = HOVER_THRESHOLD): PlacedPoint | null {
    const pt = toPattern(cx, cy);
    const t = threshold / baseScale();
    const pts = indexPoints(currentPattern);
    let best: PlacedPoint | null = null;
    let bestDist = Infinity;
    for (const pp of placedPoints(currentPattern, pts)) {
      const lid = pts.get(pp.pointId)?.layerId;
      if (!layerVisible(lid) || layerLocked(lid)) continue; // can't pick hidden/locked-layer points
      const d = Math.hypot(pt.x - pp.world.x, pt.y - pp.world.y);
      if (d < t && d < bestDist) { bestDist = d; best = pp; }
    }
    return best;
  }

  function hitTestPoint(cx: number, cy: number, threshold = HOVER_THRESHOLD): string | null {
    return hitTestPlaced(cx, cy, threshold)?.pointId ?? null;
  }

  function tracePoly(c: CanvasRenderingContext2D, poly: Vec2[], close: boolean) {
    if (poly.length < 2) return;
    c.beginPath();
    const a = toCanvas(poly[0]);
    c.moveTo(a.x, a.y);
    for (let i = 1; i < poly.length; i++) {
      const p = toCanvas(poly[i]);
      c.lineTo(p.x, p.y);
    }
    if (close) c.closePath();
  }

  function render() {
    if (!ctx) return;
    const c = ctx;
    c.clearRect(0, 0, canvasW, canvasH);
    c.fillStyle = isDark ? '#15191e' : '#fafafa';
    c.fillRect(0, 0, canvasW, canvasH);

    if (currentPattern.showGrid) {
      const step = GRID_MM * baseScale();
      if (step > 4) {
        const origin = toCanvas({ x: 0, y: 0 });
        const ox = ((origin.x % step) + step) % step;
        const oy = ((origin.y % step) + step) % step;
        c.strokeStyle = isDark ? '#252b33' : '#ececec';
        c.lineWidth = 0.5;
        for (let x = ox; x < canvasW; x += step) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, canvasH); c.stroke(); }
        for (let y = oy; y < canvasH; y += step) { c.beginPath(); c.moveTo(0, y); c.lineTo(canvasW, y); c.stroke(); }
      }
    }

    const paths = indexPaths(currentPattern);
    const points = indexPoints(currentPattern);
    const placed = placedPoints(currentPattern, points);
    const seamPP = new Set<string>();
    for (const s of currentPattern.seams) for (const r of [...s.fromPaths, ...s.toPaths]) seamPP.add(r.id);

    // avatar silhouette behind the pieces (real projected body, centred on the x=0 draft axis)
    if (showBody && placed.length > 0) {
      let minY = Infinity, maxY = -Infinity;
      for (const pp of placed) { minY = Math.min(minY, pp.world.y); maxY = Math.max(maxY, pp.world.y); }
      drawSilhouette(c, minY, maxY);
    }

    for (const piece of currentPattern.pieces) {
      if (piece.hidden || !layerVisible(piece.layerId)) continue; // hidden piece or hidden layer
      const isSelected = $selectedPieceIds.has(piece.id);
      const outline = pieceWorldOutline(currentPattern, piece, paths, points, 4);
      if (outline.length < 2) continue;

      const tf = pieceTransform(piece, points);

      if (isSelected) {
        // selected piece -> clean editable line-art (no fabric fill): each boundary edge
        // coloured by role — magenta = sewn edge, red dashed = mirror/fold line, black
        // dashed = free edge — matching the original 2D editor.
        c.fillStyle = 'rgba(255,255,255,0.55)';
        tracePoly(c, outline, true);
        c.fill();
        for (const pp of piece.mainPaths) {
          const edge = piecePathPolyline(pp, paths, points, 4).map(tf);
          if (edge.length < 2) continue;
          if (pp.isMirrorLine) { c.strokeStyle = '#ef4444'; c.lineWidth = 1.5; c.setLineDash([6, 4]); }
          else if (seamPP.has(pp.id)) { c.strokeStyle = PATH_MAGENTA; c.lineWidth = 2; c.setLineDash([]); }
          else { c.strokeStyle = 'rgba(15,23,42,0.9)'; c.lineWidth = 1.5; c.setLineDash([6, 4]); }
          tracePoly(c, edge, false);
          c.stroke();
        }
        c.setLineDash([]);
        c.strokeStyle = '#1d4ed8';
        c.lineWidth = 1;
        c.setLineDash([5, 4]);
        for (const ip of pieceWorldInternalPolylines(currentPattern, piece, paths, points, 4)) {
          tracePoly(c, ip, false); c.stroke();
        }
        c.setLineDash([]);
      } else {
        // unselected -> fabric-textured fill + dark boundary
        tracePoly(c, outline, true);
        c.fillStyle = pieceFill(c, materialOf(piece.materialId));
        c.fill();
        c.strokeStyle = 'rgba(30,41,59,0.85)';
        c.lineWidth = 1.5;
        tracePoly(c, outline, true);
        c.stroke();
        c.strokeStyle = 'rgba(30,41,59,0.55)';
        c.lineWidth = 1;
        c.setLineDash([4, 3]);
        for (const ip of pieceWorldInternalPolylines(currentPattern, piece, paths, points, 4)) {
          tracePoly(c, ip, false); c.stroke();
        }
        c.setLineDash([]);
      }

      // grain line through centroid (magenta, like the source)
      const cen = polygonCentroid(outline);
      const o0 = tf({ x: 0, y: 0 });
      const gv = piece.grainVector;
      const gd = { x: tf(gv).x - o0.x, y: tf(gv).y - o0.y };
      const glen = Math.hypot(gd.x, gd.y) || 1;
      const gl = 70;
      const g0 = toCanvas({ x: cen.x - (gd.x / glen) * gl, y: cen.y - (gd.y / glen) * gl });
      const g1 = toCanvas({ x: cen.x + (gd.x / glen) * gl, y: cen.y + (gd.y / glen) * gl });
      c.strokeStyle = GRAIN_MAGENTA;
      c.lineWidth = 1.5;
      c.beginPath(); c.moveTo(g0.x, g0.y); c.lineTo(g1.x, g1.y); c.stroke();
      // little arrow head at the top of the grain line
      const ah = 6, adx = (gd.x / glen), ady = (gd.y / glen);
      c.beginPath();
      c.moveTo(g1.x, g1.y);
      c.lineTo(g1.x - (adx * ah) + (ady * ah * 0.6), g1.y + (ady * ah) + (adx * ah * 0.6));
      c.moveTo(g1.x, g1.y);
      c.lineTo(g1.x - (adx * ah) - (ady * ah * 0.6), g1.y + (ady * ah) - (adx * ah * 0.6));
      c.stroke();

      // bbox only while actively dragging the piece
      if (isSelected && isDragging) {
        let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
        for (const p of outline) { const cp = toCanvas(p); bx0 = Math.min(bx0, cp.x); by0 = Math.min(by0, cp.y); bx1 = Math.max(bx1, cp.x); by1 = Math.max(by1, cp.y); }
        c.strokeStyle = 'rgba(37,99,235,0.6)';
        c.lineWidth = 1;
        c.setLineDash([6, 4]);
        c.strokeRect(bx0 - 8, by0 - 8, bx1 - bx0 + 16, by1 - by0 + 16);
        c.setLineDash([]);
      }

      if (currentPattern.showPieceNames) {
        const mid = toCanvas(cen);
        pieceNameChip(c, piece.name, mid.x, mid.y);
      }
    }

    // notches — short perpendicular ticks at their position along each main edge
    for (const piece of currentPattern.pieces) {
      if (piece.hidden) continue;
      const tf = pieceTransform(piece, points);
      for (const pp of piece.mainPaths) {
        if (!pp.notches?.length) continue;
        const poly = piecePathPolyline(pp, paths, points, 4).map(tf);
        if (poly.length < 2) continue;
        const cum = [0];
        for (let i = 1; i < poly.length; i++) cum.push(cum[i - 1] + Math.hypot(poly[i].x - poly[i - 1].x, poly[i].y - poly[i - 1].y));
        const total = cum[cum.length - 1] || 1;
        for (const notch of pp.notches) {
          const t = typeof notch.position === 'number' ? notch.position : 0.5;
          const target = t * total;
          let i = 1; while (i < poly.length - 1 && cum[i] < target) i++;
          const seg = cum[i] - cum[i - 1] || 1;
          const f = (target - cum[i - 1]) / seg;
          const px = poly[i - 1].x + (poly[i].x - poly[i - 1].x) * f;
          const py = poly[i - 1].y + (poly[i].y - poly[i - 1].y) * f;
          let tx = poly[i].x - poly[i - 1].x, ty = poly[i].y - poly[i - 1].y;
          const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
          const len = ((notch.size as number) || currentPattern.defaultNotchSize || 6.35);
          const a = toCanvas({ x: px - ty * len, y: py + tx * len });
          const b = toCanvas({ x: px + ty * len, y: py - tx * len });
          c.strokeStyle = isDark ? '#cbd5e1' : '#1e293b'; c.lineWidth = 1.5; c.setLineDash([]);
          c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke();
        }
      }
    }

    // seams — shown only while a seam tool is active (or pinned via the Seams toggle),
    // matching the source. Each seam's two sewn edges are stroked in the seam's own colour
    // (golden-angle hue spacing) so matching colours = same seam; faint dashed "rungs" link them.
    if (showSeams || isSeamToolActive()) {
      const sel = $selectedPieceIds;
      for (const sg of allSeamGeometry(currentPattern, paths, points, 4)) {
        const focused = sel.size > 0 && sg.pieceIds.some((id) => sel.has(id));
        const col = seamColor(sg.index);
        c.strokeStyle = col;
        c.globalAlpha = sel.size === 0 || focused ? 1 : 0.35;
        c.lineWidth = focused ? 4 : 3;
        c.setLineDash([]);
        tracePoly(c, sg.fromEdge, false); c.stroke();
        tracePoly(c, sg.toEdge, false); c.stroke();
        if (focused || sel.size === 0) {
          c.lineWidth = 0.8;
          c.globalAlpha = focused ? 0.5 : 0.18;
          c.setLineDash([5, 5]);
          for (const r of sg.rungs) {
            const a = toCanvas(r.a); const b = toCanvas(r.b);
            c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke();
          }
          c.setLineDash([]);
        }
        c.globalAlpha = 1;
      }
    }

    // loose paths not used by any piece
    const usedPaths = new Set<string>();
    for (const piece of currentPattern.pieces) {
      for (const pp of piece.mainPaths) usedPaths.add(pp.path);
      for (const pp of piece.internalPaths) usedPaths.add(pp.path);
    }
    for (const path of currentPattern.paths) {
      if (usedPaths.has(path.id) || !layerVisible(path.layerId)) continue;
      const isSelected = $selectedPathIds.has(path.id);
      c.strokeStyle = isSelected ? '#f97316' : '#cbd5e1';
      c.lineWidth = isSelected ? 2.5 : 1;
      tracePoly(c, pathPolyline(path, points, 4), false);
      c.stroke();
    }

    if (baseScale() > 0.12) {
      const selPieces = $selectedPieceIds;
      const showLabels = baseScale() > 0.18;
      for (const pp of placedPoints(currentPattern, points)) {
        if (!layerVisible(points.get(pp.pointId)?.layerId)) continue;
        const pt = pp.world;
        const cp = toCanvas(pt);
        const isHovered = hoveredPointId === pp.pointId;
        const isSelected = $selectedPointIds.has(pp.pointId);
        const onSelPiece = pp.pieceId !== '' && selPieces.has(pp.pieceId);
        const r = isHovered ? POINT_RADIUS + 2 : isSelected ? POINT_RADIUS + 1 : POINT_RADIUS;
        c.beginPath();
        c.arc(cp.x, cp.y, r, 0, Math.PI * 2);
        c.fillStyle = isSelected ? '#f97316' : isHovered ? '#fb923c' : (onSelPiece ? SELECT_BLUE : '#64748b');
        c.fill();
        c.strokeStyle = '#fff';
        c.lineWidth = 1.25;
        c.stroke();
        // point name label (A0, A1, ...) — like the source
        const nm = points.get(pp.pointId)?.name;
        if (showLabels && nm && (selPieces.size === 0 || onSelPiece || isSelected)) {
          c.font = '11px sans-serif';
          c.textAlign = 'left';
          c.fillStyle = 'rgba(255,255,255,0.85)';
          const tw = c.measureText(nm).width;
          c.fillRect(cp.x + 6, cp.y - 16, tw + 4, 13);
          c.fillStyle = '#334155';
          c.fillText(nm, cp.x + 8, cp.y - 6);
        }
      }
      // measurement + bezier handles ONLY for the clicked boundary edge (like the source)
      drawSelectedEdge(c, paths, points);
    }

    if ($selectedTool === 'measure' && measureFrom) {
      const placed = placedPoints(currentPattern, points);
      const a = placed.find((p) => p.pointId === measureFrom)?.world;
      const b = placed.find((p) => p.pointId === hoveredPointId)?.world;
      if (a) {
        const ca = toCanvas(a);
        const cb = b ? toCanvas(b) : cursorPos;
        c.strokeStyle = '#f97316';
        c.setLineDash([4, 3]);
        c.beginPath(); c.moveTo(ca.x, ca.y); c.lineTo(cb.x, cb.y); c.stroke();
        c.setLineDash([]);
        if (b) {
          const dmm = Math.hypot(b.x - a.x, b.y - a.y);
          const disp = currentPattern.lengthUnit === 'inch' ? dmm / 25.4 : currentPattern.lengthUnit === 'cm' ? dmm / 10 : dmm;
          c.fillStyle = '#f97316';
          c.font = 'bold 12px sans-serif';
          c.fillText(`${disp.toFixed(2)} ${currentPattern.lengthUnit}`, (ca.x + cb.x) / 2 + 6, (ca.y + cb.y) / 2 - 6);
        }
      }
    }

    // live drag readout (dX / dY / dL), like the source
    if (isDragging && dragStartWorld) {
      const cur = toPattern(cursorPos.x, cursorPos.y);
      const dx = cur.x - dragStartWorld.x;
      const dy = cur.y - dragStartWorld.y;
      const dl = Math.hypot(dx, dy);
      const conv = (mm: number) => currentPattern.lengthUnit === 'inch' ? mm / 25.4 : currentPattern.lengthUnit === 'cm' ? mm / 10 : mm;
      const u = currentPattern.lengthUnit;
      const lines = [
        `dX ${conv(dx) >= 0 ? '+' : ''}${conv(dx).toFixed(1)} ${u}`,
        `dY ${conv(dy) >= 0 ? '+' : ''}${conv(dy).toFixed(1)} ${u}`,
        `dL ${conv(dl).toFixed(1)} ${u}`
      ];
      const bx = cursorPos.x + 14, by = cursorPos.y + 14;
      c.font = '11px sans-serif';
      const w = Math.max(...lines.map((l) => c.measureText(l).width)) + 12;
      c.fillStyle = 'rgba(15,23,42,0.88)';
      c.fillRect(bx, by, w, lines.length * 14 + 6);
      c.fillStyle = '#fff';
      c.textAlign = 'left';
      lines.forEach((l, i) => c.fillText(l, bx + 6, by + 14 + i * 14));
    }

    // pen / create-piece draft preview
    if (penDraft.length > 0) {
      const pts = penDraft.map((id) => points.get(id)).filter(Boolean) as { x: number; y: number }[];
      c.strokeStyle = $selectedTool === 'piece' ? '#2563eb' : '#0ea5e9';
      c.lineWidth = 1.5;
      c.beginPath();
      const a0 = toCanvas(pts[0]);
      c.moveTo(a0.x, a0.y);
      for (let i = 1; i < pts.length; i++) { const p = toCanvas(pts[i]); c.lineTo(p.x, p.y); }
      const last = toCanvas(pts[pts.length - 1]);
      c.lineTo(last.x, last.y);
      c.setLineDash([4, 3]);
      c.lineTo(cursorPos.x, cursorPos.y); // rubber-band to cursor
      c.stroke();
      c.setLineDash([]);
      for (const p of pts) { const cp = toCanvas(p); c.beginPath(); c.arc(cp.x, cp.y, 4, 0, Math.PI * 2); c.fillStyle = '#0ea5e9'; c.fill(); c.strokeStyle = '#fff'; c.lineWidth = 1.25; c.stroke(); }
    }

    // seam tool: highlight the picked edge(s)
    for (const id of [...(seamFirstEdge ? [seamFirstEdge] : []), ...seamMultiEdges]) {
      const owners = pieceOwnerOf(id);
      if (!owners) continue;
      const tf = pieceTransform(owners.piece, points);
      const poly = piecePathPolyline(owners.pp, paths, points, 4).map(tf);
      c.strokeStyle = PATH_MAGENTA; c.lineWidth = 3; c.setLineDash([]);
      tracePoly(c, poly, false); c.stroke();
    }

    // arc/circle tool: placed clicks + a live preview to the cursor
    if (arcClicks.length > 0) {
      for (const w of arcClicks) { const cp = toCanvas(w); c.beginPath(); c.arc(cp.x, cp.y, 4, 0, Math.PI * 2); c.fillStyle = '#0ea5e9'; c.fill(); c.strokeStyle = '#fff'; c.lineWidth = 1.25; c.stroke(); }
      const cur = toPattern(cursorPos.x, cursorPos.y);
      c.strokeStyle = 'rgba(14,165,233,0.8)'; c.lineWidth = 1.25; c.setLineDash([4, 3]);
      if ($selectedTool === 'circle') {
        const ctr = toCanvas(arcClicks[0]);
        const r = Math.hypot(cursorPos.x - ctr.x, cursorPos.y - ctr.y);
        c.beginPath(); c.arc(ctr.x, ctr.y, r, 0, Math.PI * 2); c.stroke();
      } else {
        c.beginPath(); const a0 = toCanvas(arcClicks[0]); c.moveTo(a0.x, a0.y);
        for (const w of arcClicks.slice(1)) { const cp = toCanvas(w); c.lineTo(cp.x, cp.y); }
        c.lineTo(cursorPos.x, cursorPos.y); c.stroke();
      }
      c.setLineDash([]);
    }

    // marquee (rubber-band) selection rectangle
    if (isMarquee) {
      const x = Math.min(marqueeStart.x, marqueeCur.x), y = Math.min(marqueeStart.y, marqueeCur.y);
      const w = Math.abs(marqueeCur.x - marqueeStart.x), h = Math.abs(marqueeCur.y - marqueeStart.y);
      c.fillStyle = 'rgba(37,99,235,0.10)';
      c.fillRect(x, y, w, h);
      c.strokeStyle = 'rgba(37,99,235,0.7)';
      c.lineWidth = 1;
      c.setLineDash([4, 3]);
      c.strokeRect(x, y, w, h);
      c.setLineDash([]);
    }
  }

  function pieceOwnerOf(ppId: string): { piece: Piece; pp: import('$lib/types/pattern').PiecePath } | null {
    for (const piece of currentPattern.pieces) {
      for (const pp of piece.mainPaths) if (pp.id === ppId) return { piece, pp };
      for (const pp of piece.internalPaths) if (pp.id === ppId) return { piece, pp };
    }
    return null;
  }

  function getPos(e: MouseEvent): Vec2 {
    const rect = canvasEl.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  // ---- piece operations (context menu) --------------------------------------
  function pieceAt(pos: Vec2): Piece | null {
    const pat = toPattern(pos.x, pos.y);
    const paths = indexPaths(currentPattern);
    const points = indexPoints(currentPattern);
    for (const piece of currentPattern.pieces) {
      if (piece.hidden || !layerVisible(piece.layerId) || layerLocked(piece.layerId)) continue;
      if (pointInPolygon(pat, pieceWorldOutline(currentPattern, piece, paths, points, 6))) return piece;
    }
    return null;
  }
  function mutatePieces(fn: (pieces: Piece[]) => Piece[]) {
    onchange({ ...currentPattern, pieces: fn(currentPattern.pieces), hasChanged: true });
  }
  function duplicatePiece(piece: Piece) {
    const clone: Piece = structuredClone($state.snapshot(piece) as Piece);
    clone.id = uid('Piece');
    clone.name = `Copy of ${piece.name}`;
    clone.position = { x: piece.position.x + 50, y: piece.position.y - 50 };
    clone.origin = { ...piece.origin, id: uid('Point') };
    for (const pp of [...clone.mainPaths, ...clone.internalPaths]) pp.id = uid('PiecePath');
    mutatePieces((ps) => [...ps, clone]);
    selectedPieceIds.set(new Set([clone.id]));
    toast(`Duplicated "${piece.name}"`, 'success');
  }
  function deletePiece(piece: Piece) {
    // cascade: also drop seams that sewed this piece's edges
    onchange(deletePieceCascade(currentPattern, piece.id));
    selectedPieceIds.set(new Set());
    toast(`Deleted "${piece.name}"`);
  }
  function togglePieceHidden(piece: Piece) {
    mutatePieces((ps) => ps.map((p) => (p.id === piece.id ? { ...p, hidden: !p.hidden } : p)));
    toast(piece.hidden ? `Showing "${piece.name}"` : `Hid "${piece.name}"`);
  }
  function reorderPiece(piece: Piece, toFront: boolean) {
    mutatePieces((ps) => { const rest = ps.filter((p) => p.id !== piece.id); return toFront ? [...rest, piece] : [piece, ...rest]; });
    toast(toFront ? 'Brought to front' : 'Sent to back');
  }
  function mirrorPiece(piece: Piece, axis: 'X' | 'Y') {
    mutatePieces((ps) => ps.map((p) => (p.id === piece.id ? { ...p, [axis === 'X' ? 'mirrorX' : 'mirrorY']: !(axis === 'X' ? p.mirrorX : p.mirrorY) } : p)));
    toast(`Mirrored on ${axis} axis`);
  }

  // ---- path / point operations ---------------------------------------------
  /** Convert a ConstrainablePath between line and curve (adds/removes bezier handles). */
  function convertPath(pathId: string, toCurve: boolean) {
    const p = $state.snapshot(currentPattern) as Pattern;
    const pts = indexPoints(currentPattern);
    const paths = p.paths.map((path) => {
      if (path.id !== pathId) return path;
      if (!toCurve) {
        return { ...path, pathType: 'line', pathPoints: path.pathPoints.map((pp) => ({ id: pp.id })) };
      }
      const anchors = path.pathPoints.map((pp) => pts.get(pp.id)).filter(Boolean) as typeof currentPattern.points;
      const pathPoints = path.pathPoints.map((pp, i) => {
        const a = pts.get(pp.id); if (!a) return pp;
        const prev = anchors[i - 1] ?? a, next = anchors[i + 1] ?? a;
        const tx = (next.x - prev.x) / 3, ty = (next.y - prev.y) / 3;
        return { id: pp.id, handle: { v1: { x: -tx, y: -ty }, v2: { x: tx, y: ty }, sameLength: true, sameAngle: true, lengthFormula: { formula: '', unit: 'mm' }, angleFormula: { formula: '', unit: 'degrees' } } };
      });
      return { ...path, pathType: 'curve', pathPoints };
    });
    onchange({ ...p, paths, hasChanged: true });
    toast(toCurve ? 'Converted to curve' : 'Converted to line', 'success');
  }

  /** Rotate the selected construction points around their centre (degrees). */
  function rotateSelectedPoints(deg: number) {
    const ids = $selectedPointIds; if (ids.size === 0) return;
    const sel = currentPattern.points.filter((p) => ids.has(p.id));
    const cx = sel.reduce((s, p) => s + p.x, 0) / sel.length, cy = sel.reduce((s, p) => s + p.y, 0) / sel.length;
    const r = (deg * Math.PI) / 180, cos = Math.cos(r), sin = Math.sin(r);
    const points = currentPattern.points.map((p) => {
      if (!ids.has(p.id)) return p;
      const dx = p.x - cx, dy = p.y - cy;
      return { ...p, x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
    });
    onchange({ ...currentPattern, points, hasChanged: true });
    toast(`Rotated ${sel.length} point${sel.length === 1 ? '' : 's'} ${deg}°`, 'success');
  }

  /** Scale the selected construction points around their centre (percent). */
  function scaleSelectedPoints(pct: number) {
    const ids = $selectedPointIds; if (ids.size === 0) return;
    const sel = currentPattern.points.filter((p) => ids.has(p.id));
    const cx = sel.reduce((s, p) => s + p.x, 0) / sel.length, cy = sel.reduce((s, p) => s + p.y, 0) / sel.length;
    const f = pct / 100;
    const points = currentPattern.points.map((p) => (ids.has(p.id) ? { ...p, x: cx + (p.x - cx) * f, y: cy + (p.y - cy) * f } : p));
    onchange({ ...currentPattern, points, hasChanged: true });
    toast(`Scaled ${sel.length} point${sel.length === 1 ? '' : 's'} to ${pct}%`, 'success');
  }

  /** Arc-length parameter (0..1) of the closest point on a piece-path's WORLD polyline. */
  function edgeParamAt(pp: import('$lib/types/pattern').PiecePath, world: Vec2): number {
    const owner = pieceOwnerOf(pp.id); if (!owner) return 0.5;
    const tf = pieceTransform(owner.piece, indexPoints(currentPattern));
    const poly = piecePathPolyline(pp, indexPaths(currentPattern), indexPoints(currentPattern), 4).map(tf);
    if (poly.length < 2) return 0.5;
    const cum = [0];
    for (let i = 1; i < poly.length; i++) cum.push(cum[i - 1] + Math.hypot(poly[i].x - poly[i - 1].x, poly[i].y - poly[i - 1].y));
    const total = cum[cum.length - 1] || 1;
    let best = 0.5, bestD = Infinity;
    for (let i = 1; i < poly.length; i++) {
      const dx = poly[i].x - poly[i - 1].x, dy = poly[i].y - poly[i - 1].y;
      const l2 = dx * dx + dy * dy || 1;
      let t = ((world.x - poly[i - 1].x) * dx + (world.y - poly[i - 1].y) * dy) / l2;
      t = Math.max(0, Math.min(1, t));
      const px = poly[i - 1].x + t * dx, py = poly[i - 1].y + t * dy;
      const d = Math.hypot(world.x - px, world.y - py);
      if (d < bestD) { bestD = d; best = (cum[i - 1] + t * Math.sqrt(l2)) / total; }
    }
    return best;
  }
  function addNotch(piecePathId: string, position: number) {
    mutatePieces((ps) => ps.map((pc) => ({
      ...pc,
      mainPaths: pc.mainPaths.map((pp) => pp.id === piecePathId ? { ...pp, notches: [...(pp.notches ?? []), { id: uid('Notch'), position, size: currentPattern.defaultNotchSize }] } : pp)
    })));
    toast('Added notch', 'success');
  }
  function clearNotches(piecePathId: string) {
    mutatePieces((ps) => ps.map((pc) => ({ ...pc, mainPaths: pc.mainPaths.map((pp) => pp.id === piecePathId ? { ...pp, notches: [] } : pp) })));
    toast('Cleared notches');
  }

  function handleContextMenu(e: MouseEvent) {
    e.preventDefault();
    const pos = getPos(e);

    // right-click a point → point ops (incl. rotate/scale a multi-selection)
    const ptHit = hitTestPlaced(pos.x, pos.y);
    if (ptHit) {
      if (!$selectedPointIds.has(ptHit.pointId)) { selectedPointIds.set(new Set([ptHit.pointId])); selectedPieceIds.set(new Set()); selectedPathIds.set(new Set()); }
      render();
      const n = $selectedPointIds.size;
      const items: MenuItem[] = [];
      if (n > 1) {
        items.push({ label: `Rotate ${n} points…`, icon: 'rotate_right', onClick: () => { const d = prompt('Degrees to rotate selected points:', '90'); if (d) rotateSelectedPoints(parseFloat(d) || 0); } });
        items.push({ label: `Scale ${n} points…`, icon: 'open_in_full', onClick: () => { const s = prompt('Scale selected points by percent:', '100'); if (s) scaleSelectedPoints(parseFloat(s) || 100); } });
      }
      items.push({ label: `Delete point${n > 1 ? 's' : ''}`, icon: 'delete', danger: true, sep: items.length > 0, onClick: () => {
        const ids = $selectedPointIds;
        onchange({ ...currentPattern, points: currentPattern.points.filter((p) => !ids.has(p.id)), hasChanged: true });
        selectedPointIds.set(new Set()); toast('Deleted points');
      } });
      contextMenu = { x: e.clientX, y: e.clientY, items };
      return;
    }

    // right-click an edge → path conversions + delete
    const edgePP = hitTestEdge(pos);
    if (edgePP) {
      const owner = pieceOwnerOf(edgePP);
      const path = owner ? indexPaths(currentPattern).get(owner.pp.path) : null;
      if (owner && path) {
        selectedPieceIds.set(new Set([owner.piece.id])); selectedPathIds.set(new Set([path.id])); selectedPointIds.set(new Set());
        render();
        const isCurve = path.pathType === 'curve';
        const world = toPattern(pos.x, pos.y);
        const hasNotches = (owner.pp.notches?.length ?? 0) > 0;
        contextMenu = { x: e.clientX, y: e.clientY, items: [
          isCurve
            ? { label: 'Convert to line', icon: 'show_chart', onClick: () => convertPath(path.id, false) }
            : { label: 'Convert to curve', icon: 'gesture', onClick: () => convertPath(path.id, true) },
          { label: 'Add notch here', icon: 'content_cut', sep: true, onClick: () => addNotch(owner.pp.id, edgeParamAt(owner.pp, world)) },
          ...(hasNotches ? [{ label: 'Clear notches', icon: 'backspace', onClick: () => clearNotches(owner.pp.id) } as MenuItem] : []),
          { label: 'Remove edge from piece', icon: 'delete', danger: true, sep: true, onClick: () => { mutatePieces((ps) => ps.map((p) => p.id === owner.piece.id ? { ...p, mainPaths: p.mainPaths.filter((x) => x.id !== owner.pp.id) } : p)); toast('Removed edge'); } }
        ] };
        return;
      }
    }

    const piece = pieceAt(pos);
    if (!piece) { contextMenu = null; return; }
    selectedPieceIds.set(new Set([piece.id]));
    selectedPointIds.set(new Set());
    selectedPathIds.set(new Set());
    render();
    contextMenu = {
      x: e.clientX, y: e.clientY,
      items: [
        { label: 'Duplicate', icon: 'content_copy', onClick: () => duplicatePiece(piece) },
        { label: 'Mirror along X-axis', icon: 'flip', onClick: () => mirrorPiece(piece, 'X') },
        { label: 'Mirror along Y-axis', icon: 'flip', onClick: () => mirrorPiece(piece, 'Y') },
        { label: 'Bring to front', icon: 'flip_to_front', sep: true, onClick: () => reorderPiece(piece, true) },
        { label: 'Send to back', icon: 'flip_to_back', onClick: () => reorderPiece(piece, false) },
        ...currentPattern.layers
          .filter((l) => l.id !== (piece.layerId ?? 'default'))
          .map((l, i): MenuItem => ({ label: `Move to: ${l.name}`, icon: 'layers', sep: i === 0, onClick: () => moveToLayer(piece, l.id) })),
        { label: piece.hidden ? 'Show piece' : 'Hide piece', icon: piece.hidden ? 'visibility' : 'visibility_off', sep: true, onClick: () => togglePieceHidden(piece) },
        { label: 'Delete', icon: 'delete', danger: true, sep: true, onClick: () => deletePiece(piece) }
      ]
    };
  }

  function moveToLayer(piece: Piece, layerId: string) {
    mutatePieces((ps) => ps.map((p) => (p.id === piece.id ? { ...p, layerId } : p)));
    const name = currentPattern.layers.find((l) => l.id === layerId)?.name ?? layerId;
    toast(`Moved to ${name}`, 'success');
  }

  // ---- tool actions (new point / pen / create piece / seam / text) ----------
  const uid = (prefix: string) => `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 9)}`;
  function nextPointName(p: Pattern): string {
    const prefix = p.pointPrefix || 'A';
    let n = p.points.length;
    const names = new Set(p.points.map((q) => q.name));
    while (names.has(`${prefix}${n}`)) n++;
    return `${prefix}${n}`;
  }

  /** Name an edge from its endpoint points, like the source ("LineA0A1" / "CurveA4A5"). */
  function edgeName(p: Pattern, fromId: string, toId: string, curve = false): string {
    const nm = (id: string) => p.points.find((q) => q.id === id)?.name ?? id.slice(0, 4);
    return `${curve ? 'Curve' : 'Line'}${nm(fromId)}${nm(toId)}`;
  }

  /** Add a free ConstrainablePoint at a world position; returns the new pattern + id. */
  function withNewPoint(p: Pattern, world: Vec2): { p: Pattern; id: string } {
    const id = uid('ConstrainablePoint');
    const points = [...p.points, { id, name: nextPointName(p), x: world.x, y: world.y, layerId: p.currentLayerId }];
    return { p: { ...p, points }, id };
  }

  /** A straight ConstrainablePath through an ordered list of point ids. */
  function lineThrough(ids: string[]): import('$lib/types/pattern').ConstrainablePath {
    return { id: uid('ConstrainablePath'), name: '', pathType: 'line', pathPoints: ids.map((id) => ({ id })), version: 1 };
  }

  // ---- arc / circle tools ---------------------------------------------------
  type Anchor = { pos: Vec2; v1: Vec2; v2: Vec2 };
  const mkHandle = (v1: Vec2, v2: Vec2) => ({ v1, v2, sameLength: true, sameAngle: true, lengthFormula: { formula: '', unit: 'mm' }, angleFormula: { formula: '', unit: 'degrees' } });

  /** Cubic-bezier anchors approximating an arc of `r` around `c` from angle a0→a1 (radians, CCW). */
  function arcAnchors(c: Vec2, r: number, a0: number, a1: number): Anchor[] {
    const span = a1 - a0;
    const nSeg = Math.max(1, Math.ceil(Math.abs(span) / (Math.PI / 2)));
    const dθ = span / nSeg;
    const k = (4 / 3) * Math.tan(dθ / 4) * r;
    const out: Anchor[] = [];
    for (let i = 0; i <= nSeg; i++) {
      const θ = a0 + dθ * i;
      const tx = -Math.sin(θ), ty = Math.cos(θ);
      out.push({ pos: { x: c.x + r * Math.cos(θ), y: c.y + r * Math.sin(θ) }, v1: { x: -tx * k, y: -ty * k }, v2: { x: tx * k, y: ty * k } });
    }
    return out;
  }

  /** Materialise anchors into ConstrainablePoints + a curve ConstrainablePath. */
  function addCurveFromAnchors(anchors: Anchor[], closed: boolean) {
    let p = $state.snapshot(currentPattern) as Pattern;
    const ids: string[] = [];
    const newPoints = anchors.map((a, i) => {
      const id = uid('ConstrainablePoint');
      ids.push(id);
      return { id, name: `${p.pointPrefix || 'A'}${p.points.length + i}`, x: a.pos.x, y: a.pos.y };
    });
    const pathPoints = anchors.map((a, i) => ({ id: ids[i], handle: mkHandle(a.v1, a.v2) }));
    if (closed) pathPoints.push({ id: ids[0], handle: mkHandle(anchors[0].v1, anchors[0].v2) });
    const path = { id: uid('ConstrainablePath'), name: '', pathType: 'curve', pathPoints, version: 1 } as import('$lib/types/pattern').ConstrainablePath;
    onchange({ ...p, points: [...p.points, ...newPoints], paths: [...p.paths, path], hasChanged: true });
  }

  function circumcircle(a: Vec2, b: Vec2, c: Vec2): { c: Vec2; r: number } | null {
    const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
    if (Math.abs(d) < 1e-6) return null;
    const ux = ((a.x ** 2 + a.y ** 2) * (b.y - c.y) + (b.x ** 2 + b.y ** 2) * (c.y - a.y) + (c.x ** 2 + c.y ** 2) * (a.y - b.y)) / d;
    const uy = ((a.x ** 2 + a.y ** 2) * (c.x - b.x) + (b.x ** 2 + b.y ** 2) * (a.x - c.x) + (c.x ** 2 + c.y ** 2) * (b.x - a.x)) / d;
    const center = { x: ux, y: uy };
    return { c: center, r: Math.hypot(a.x - ux, a.y - uy) };
  }

  /** Handle a click for the active arc/circle tool; builds geometry once enough clicks land. */
  function arcClick(pos: Vec2) {
    const w = toPattern(pos.x, pos.y);
    const clicks = [...arcClicks, w];
    const tool = $selectedTool;
    if (tool === 'circle') {
      if (clicks.length < 2) { arcClicks = clicks; render(); return; }
      const r = Math.hypot(clicks[1].x - clicks[0].x, clicks[1].y - clicks[0].y);
      addCurveFromAnchors(arcAnchors(clicks[0], r, 0, Math.PI * 2), true);
      arcClicks = []; toast('Added circle', 'success');
    } else if (tool === 'arc-center') {
      if (clicks.length < 3) { arcClicks = clicks; render(); return; }
      const c0 = clicks[0];
      const r = Math.hypot(clicks[1].x - c0.x, clicks[1].y - c0.y);
      let a0 = Math.atan2(clicks[1].y - c0.y, clicks[1].x - c0.x);
      let a1 = Math.atan2(clicks[2].y - c0.y, clicks[2].x - c0.x);
      if (a1 <= a0) a1 += Math.PI * 2;
      addCurveFromAnchors(arcAnchors(c0, r, a0, a1), false);
      arcClicks = []; toast('Added arc', 'success');
    } else if (tool === 'arc-3pt') {
      if (clicks.length < 3) { arcClicks = clicks; render(); return; }
      const cc = circumcircle(clicks[0], clicks[1], clicks[2]);
      if (cc) {
        const ang = (pt: Vec2) => Math.atan2(pt.y - cc.c.y, pt.x - cc.c.x);
        let a0 = ang(clicks[0]), am = ang(clicks[1]), a1 = ang(clicks[2]);
        // choose the CCW direction a0→a1 that passes through the middle point
        const norm = (x: number) => { while (x < 0) x += Math.PI * 2; while (x >= Math.PI * 2) x -= Math.PI * 2; return x; };
        const dm = norm(am - a0), d1 = norm(a1 - a0);
        if (dm <= d1) addCurveFromAnchors(arcAnchors(cc.c, cc.r, a0, a0 + d1), false);
        else addCurveFromAnchors(arcAnchors(cc.c, cc.r, a0, a0 + d1 - Math.PI * 2), false);
        toast('Added arc', 'success');
      }
      arcClicks = [];
    }
    render();
  }

  function penOrPieceClick(pos: Vec2) {
    const world = toPattern(pos.x, pos.y);
    let p: Pattern = $state.snapshot(currentPattern) as Pattern;
    let pid = hitTestPoint(pos.x, pos.y);
    // close the loop (create-piece) when clicking the first point again
    if ($selectedTool === 'piece' && pid && penDraft.length >= 2 && pid === penDraft[0]) { finishDraft(); return; }
    if (!pid) { const r = withNewPoint(p, world); p = r.p; pid = r.id; }
    const draft = [...penDraft, pid];
    penDraft = draft;
    if ($selectedTool === 'pen') {
      // maintain one working line path through the placed points
      if (!draftPathId) { const path = lineThrough(draft); draftPathId = path.id; p = { ...p, paths: [...p.paths, path] }; }
      else p = { ...p, paths: p.paths.map((pa) => (pa.id === draftPathId ? { ...pa, pathPoints: draft.map((id) => ({ id })) } : pa)) };
    }
    onchange({ ...p, hasChanged: true });
    render();
  }

  function finishDraft() {
    const tool = $selectedTool;
    if (tool === 'piece' && penDraft.length >= 3) {
      let p: Pattern = $state.snapshot(currentPattern) as Pattern;
      const loop = penDraft;
      const newPaths: import('$lib/types/pattern').ConstrainablePath[] = [];
      const mainPaths: import('$lib/types/pattern').PiecePath[] = [];
      for (let i = 0; i < loop.length; i++) {
        const from = loop[i], to = loop[(i + 1) % loop.length];
        const path = lineThrough([from, to]);
        path.name = edgeName(p, from, to);
        newPaths.push(path);
        mainPaths.push({ id: uid('PiecePath'), name: edgeName(p, from, to), path: path.id, from, to, reversed: false, notches: [] });
      }
      const originPoint = loop[0];
      const op = p.points.find((q) => q.id === originPoint)!;
      const piece: Piece = {
        id: uid('Piece'), name: `Piece ${p.pieces.length + 1}`, type: 'dynamic',
        materialId: p.materials[0]?.id ?? '', origin: { id: uid('Point'), name: '', x: 0, y: 0 },
        originPoint, position: { x: op.x, y: op.y }, rotation: 0,
        grainVector: { id: uid('Point'), name: '', x: 0, y: 1 }, text: null,
        rightPieces: 0, leftPieces: 0, mirrorLeftPiecesAxis: 'X', mirrorX: false, mirrorY: false,
        seamAllowanceInside: false, mainPaths, internalPaths: [],
        settings3d: {
          arrangement: { mode: 'flat', cylinderName: '', uDegrees: 0, v: 0.5, uOffsetMm: 0, vOffsetMm: 0, radialOffsetMm: 0, use2DPosition: true, positionChanged: false, matrixWorld: [], position: [] },
          enable3d: true, frozen: false, flipNormals: false, filterExternalCollisionsByClothNormal: false, collisionLayer: 0, savedPositions: []
        }
      };
      onchange({ ...p, paths: [...p.paths, ...newPaths], pieces: [...p.pieces, piece], hasChanged: true });
    }
    penDraft = []; draftPathId = null; render();
  }

  function cancelDraft() { penDraft = []; draftPathId = null; render(); }

  const DRAWING_TOOLS = new Set(['pen', 'piece', 'point', 'text', 'seam', 'seam-single', 'seam-multi', 'circle', 'arc', 'arc-center', 'arc-3pt']);
  function isDrawingTool(t: string) { return DRAWING_TOOLS.has(t); }

  /** Reset any in-progress operation and return to the select tool (Esc / V / Cancel button). */
  function cancelOperation() {
    penDraft = []; draftPathId = null; seamFirstEdge = null; seamMultiEdges = []; arcClicks = [];
    selectedTool.set('select');
    render();
  }

  /** Bottom status-bar instruction for the active tool/operation (null = no bar). */
  const toolStatus = $derived.by(() => {
    switch ($selectedTool) {
      case 'text': return 'Click to place text';
      case 'point': return 'Click to add a point';
      case 'pen': return penDraft.length ? 'Click to add points · Enter to finish · Esc to cancel' : 'Click to start a path';
      case 'piece': return penDraft.length ? 'Click points to outline the piece · click the first point to close' : 'Click points to outline a new piece';
      case 'seam': case 'seam-single': return seamFirstEdge ? 'Click the matching edge to sew it' : 'Click an edge to start a seam';
      case 'seam-multi': return seamMultiEdges.length ? `Click more edges to join (${seamMultiEdges.length}) · Enter to finish` : 'Click the first edge of the seam';
      case 'circle': return arcClicks.length ? 'Click to set the radius' : 'Click to set the centre of the circle';
      case 'arc-center': return ['Click to set the centre of the arc', 'Click to set the radius / start', 'Click to set the end of the arc'][arcClicks.length] ?? '';
      case 'arc-3pt': return ['Click the first point of the arc', 'Click a point on the arc', 'Click the last point of the arc'][arcClicks.length] ?? '';
      case 'arc': return 'Arc/circle tools';
      default: return null;
    }
  });

  function insertTextAt(pos: Vec2) {
    const world = toPattern(pos.x, pos.y);
    const value = prompt('Text:');
    if (!value) return;
    const p = $state.snapshot(currentPattern) as Pattern;
    const text = { id: uid('Text'), value, x: world.x, y: world.y } as import('$lib/types/pattern').PatternText;
    onchange({ ...p, texts: [...p.texts, text], hasChanged: true });
  }

  /** Hit-test a piece boundary edge (returns the PiecePath id), for the seam tool. */
  function hitTestEdge(pos: Vec2): string | null {
    const paths = indexPaths(currentPattern);
    const points = indexPoints(currentPattern);
    const world = toPattern(pos.x, pos.y);
    const tol = 10 / baseScale();
    let best: string | null = null, bestD = tol;
    for (const piece of currentPattern.pieces) {
      if (piece.hidden || !layerVisible(piece.layerId) || layerLocked(piece.layerId)) continue;
      const tf = pieceTransform(piece, points);
      for (const pp of piece.mainPaths) {
        const poly = piecePathPolyline(pp, paths, points, 4).map(tf);
        for (let i = 1; i < poly.length; i++) {
          const d = distToSeg(world, poly[i - 1], poly[i]);
          if (d < bestD) { bestD = d; best = pp.id; }
        }
      }
    }
    return best;
  }
  function distToSeg(p: Vec2, a: Vec2, b: Vec2): number {
    const dx = b.x - a.x, dy = b.y - a.y;
    const l2 = dx * dx + dy * dy || 1;
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  }

  function seamClick(pos: Vec2) {
    const edge = hitTestEdge(pos);
    if (!edge) return;
    if (!seamFirstEdge) { seamFirstEdge = edge; render(); return; }
    if (edge === seamFirstEdge) { seamFirstEdge = null; render(); return; }
    const p = $state.snapshot(currentPattern) as Pattern;
    const seam = {
      id: uid('Seam'), name: '',
      fromPaths: [{ id: seamFirstEdge, mirrored: false, reversed: false }],
      toPaths: [{ id: edge, mirrored: false, reversed: false }]
    };
    onchange({ ...p, seams: [...p.seams, seam], hasChanged: true });
    seamFirstEdge = null; render();
  }

  /** Multi-seam: first edge is the "from" side, each later edge joins the "to" side. Enter finishes. */
  function seamMultiClick(pos: Vec2) {
    const edge = hitTestEdge(pos);
    if (!edge) return;
    if (seamMultiEdges.includes(edge)) { seamMultiEdges = seamMultiEdges.filter((e) => e !== edge); render(); return; }
    seamMultiEdges = [...seamMultiEdges, edge];
    render();
  }
  function finishMultiSeam() {
    if (seamMultiEdges.length >= 2) {
      const p = $state.snapshot(currentPattern) as Pattern;
      const seam = {
        id: uid('Seam'), name: '',
        fromPaths: [{ id: seamMultiEdges[0], mirrored: false, reversed: false }],
        toPaths: seamMultiEdges.slice(1).map((id) => ({ id, mirrored: false, reversed: false }))
      };
      onchange({ ...p, seams: [...p.seams, seam], hasChanged: true });
    }
    seamMultiEdges = []; render();
  }

  /** Snap a drafting-space coordinate to the grid and/or other points' guides. */
  function snapDraft(d: Vec2, excludeId?: string): Vec2 {
    let x = d.x, y = d.y;
    if (currentPattern.snapToGrid) {
      x = Math.round(x / GRID_MM) * GRID_MM;
      y = Math.round(y / GRID_MM) * GRID_MM;
    }
    if (currentPattern.snapToGuides) {
      const tol = 8 / baseScale();
      for (const p of currentPattern.points) {
        if (p.id === excludeId) continue;
        if (Math.abs(p.x - x) < tol) x = p.x;
        if (Math.abs(p.y - y) < tol) y = p.y;
      }
    }
    return { x, y };
  }

  function handleMouseDown(e: MouseEvent) {
    const pos = getPos(e);
    dragStartX = pos.x; dragStartY = pos.y;
    const tool = $selectedTool;
    if (tool === 'pan' || e.button === 1 || e.metaKey || e.ctrlKey || e.altKey) { isPanning = true; return; }
    if (tool === 'measure') { measureFrom = hitTestPoint(pos.x, pos.y); return; }
    if (tool === 'point') { const r = withNewPoint($state.snapshot(currentPattern) as Pattern, toPattern(pos.x, pos.y)); onchange({ ...r.p, hasChanged: true }); return; }
    if (tool === 'pen' || tool === 'piece') {
      penOrPieceClick(pos);
      // arm drag-for-curve on the just-placed pen point
      if (tool === 'pen') { penDragging = true; penDragPointId = penDraft[penDraft.length - 1] ?? null; dragStartX = pos.x; dragStartY = pos.y; }
      return;
    }
    if (tool === 'text') { insertTextAt(pos); return; }
    if (tool === 'seam' || tool === 'seam-single') { seamClick(pos); return; }
    if (tool === 'seam-multi') { seamMultiClick(pos); return; }
    if (tool === 'circle' || tool === 'arc-center' || tool === 'arc-3pt') { arcClick(pos); return; }
    if (tool === 'arc') return;

    const hit = hitTestPlaced(pos.x, pos.y);
    if (hit) {
      const cur = new Set($selectedPointIds);
      if (e.shiftKey) {
        // shift-click toggles the point in the selection
        if (cur.has(hit.pointId)) cur.delete(hit.pointId); else cur.add(hit.pointId);
        selectedPointIds.set(cur);
      } else if (!cur.has(hit.pointId)) {
        selectedPointIds.set(new Set([hit.pointId]));
        selectedPathIds.set(new Set());
        selectedPieceIds.set(new Set());
      }
      // begin dragging (single or the whole selected set)
      dragPointId = hit.pointId;
      dragInvert = hit.invert;
      dragStartWorld = { ...hit.world };
      dragDraftStart = hit.invert(toPattern(pos.x, pos.y));
      const sel = $selectedPointIds;
      multiDrag = sel.size > 1
        ? currentPattern.points.filter((p) => sel.has(p.id)).map((p) => ({ id: p.id, x: p.x, y: p.y }))
        : null;
      isDragging = true;
    } else {
      // prefer selecting a boundary edge (its path) so we can show that line's
      // measurement + handles only — matching the source ("press on the line").
      const edgePP = hitTestEdge(pos);
      if (edgePP) {
        const owner = pieceOwnerOf(edgePP);
        if (owner) {
          selectedPieceIds.set(new Set([owner.piece.id]));
          selectedPathIds.set(new Set([owner.pp.path]));
          selectedPointIds.set(new Set());
          render();
          return;
        }
      }
      const pat = toPattern(pos.x, pos.y);
      const paths = indexPaths(currentPattern);
      const points = indexPoints(currentPattern);
      let hitPiece: string | null = null;
      for (const piece of currentPattern.pieces) {
        if (piece.hidden || !layerVisible(piece.layerId) || layerLocked(piece.layerId)) continue;
        if (pointInPolygon(pat, pieceWorldOutline(currentPattern, piece, paths, points, 6))) { hitPiece = piece.id; break; }
      }
      if (hitPiece) {
        selectedPointIds.set(new Set());
        selectedPathIds.set(new Set());
        selectedPieceIds.set(new Set([hitPiece]));
      } else {
        // empty space → start a marquee (rubber-band) selection
        isMarquee = true;
        marqueeStart = { ...pos };
        marqueeCur = { ...pos };
        if (!e.shiftKey) { selectedPointIds.set(new Set()); selectedPathIds.set(new Set()); selectedPieceIds.set(new Set()); }
      }
    }
    render();
  }

  function handleMouseMove(e: MouseEvent) {
    const pos = getPos(e);
    cursorPos = pos;
    if (isPanning) {
      panOffset.set({ x: currentPanX + (pos.x - dragStartX), y: currentPanY + (pos.y - dragStartY) });
      dragStartX = pos.x; dragStartY = pos.y;
      return;
    }
    if (isMarquee) { marqueeCur = { ...pos }; render(); return; }
    if (penDragging && penDragPointId && draftPathId) {
      // drag out a bezier tangent on the just-placed pen point ("hold to create a curve")
      if (Math.hypot(pos.x - dragStartX, pos.y - dragStartY) > 3) {
        const world = toPattern(pos.x, pos.y);
        const anchor = currentPattern.points.find((p) => p.id === penDragPointId);
        if (anchor) {
          const v2 = { x: world.x - anchor.x, y: world.y - anchor.y };
          const v1 = { x: -v2.x, y: -v2.y };
          const paths = currentPattern.paths.map((pa) => pa.id === draftPathId
            ? { ...pa, pathType: 'curve', pathPoints: pa.pathPoints.map((pp) => pp.id === penDragPointId ? { id: pp.id, handle: mkHandle(v1, v2) } : pp) }
            : pa);
          onchange({ ...currentPattern, paths, hasChanged: true });
        }
      }
      return;
    }
    if (isDragging && dragPointId) {
      // map the cursor (world) back into the dragged point's drafting space
      const world = toPattern(pos.x, pos.y);
      const draft = snapDraft(dragInvert ? dragInvert(world) : world, dragPointId);
      if (multiDrag && dragDraftStart) {
        // move the whole selected set by the same drafting-space delta
        const dx = draft.x - dragDraftStart.x, dy = draft.y - dragDraftStart.y;
        const moved = new Map(multiDrag.map((m) => [m.id, { x: m.x + dx, y: m.y + dy }]));
        const points = currentPattern.points.map((p) => (moved.has(p.id) ? { ...p, ...moved.get(p.id)! } : p));
        onchange({ ...currentPattern, points, hasChanged: true });
      } else {
        const points = currentPattern.points.map((p) => (p.id === dragPointId ? { ...p, x: draft.x, y: draft.y } : p));
        onchange({ ...currentPattern, points, hasChanged: true });
      }
      return;
    }
    hoveredPointId = hitTestPoint(pos.x, pos.y);
    render();
  }

  function handleMouseUp() {
    if (isMarquee) {
      const x0 = Math.min(marqueeStart.x, marqueeCur.x), x1 = Math.max(marqueeStart.x, marqueeCur.x);
      const y0 = Math.min(marqueeStart.y, marqueeCur.y), y1 = Math.max(marqueeStart.y, marqueeCur.y);
      if (x1 - x0 > 3 || y1 - y0 > 3) {
        const sel = new Set($selectedPointIds); // shift-drag adds to the existing selection
        for (const pp of placedPoints(currentPattern)) {
          const cp = toCanvas(pp.world);
          if (cp.x >= x0 && cp.x <= x1 && cp.y >= y0 && cp.y <= y1) sel.add(pp.pointId);
        }
        selectedPointIds.set(sel);
        if (sel.size) { selectedPieceIds.set(new Set()); selectedPathIds.set(new Set()); }
      }
      isMarquee = false;
    }
    isDragging = false;
    dragPointId = null;
    dragInvert = null;
    dragStartWorld = null;
    dragDraftStart = null;
    multiDrag = null;
    penDragging = false;
    penDragPointId = null;
    isPanning = false;
    render();
  }

  function handleWheel(e: WheelEvent) {
    e.preventDefault();
    zoom.update((v) => Math.max(0.02, Math.min(20, v * (e.deltaY > 0 ? 0.9 : 1.1))));
  }
</script>

<canvas
  bind:this={canvasEl}
  width={canvasW}
  height={canvasH}
  class="w-full h-full block"
  onmousedown={handleMouseDown}
  onmousemove={handleMouseMove}
  onmouseup={handleMouseUp}
  onmouseleave={handleMouseUp}
  onwheel={handleWheel}
  oncontextmenu={handleContextMenu}
  style="cursor: {$selectedTool === 'pan' ? 'grab' : 'crosshair'}; touch-action: none;"
></canvas>

{#if contextMenu}
  <ContextMenu x={contextMenu.x} y={contextMenu.y} items={contextMenu.items} onclose={() => (contextMenu = null)} />
{/if}

<div class="absolute top-2 left-2 flex gap-1">
  <button
    class="btn btn-xs"
    class:btn-active={showSeams}
    title="Toggle seam connections — shows which piece edges are sewn together"
    onclick={() => { showSeams = !showSeams; render(); }}
  >Seams</button>
  <button
    class="btn btn-xs"
    class:btn-active={showBody}
    title="Toggle the avatar body silhouette"
    onclick={() => { showBody = !showBody; render(); }}
  >Body</button>
  <button class="btn btn-xs btn-ghost" title="Fit pieces to view" onclick={() => { fitView(); render(); }}>Fit</button>
</div>

<DrawingTools />

{#if toolStatus}
  <!-- active-tool status bar (matches the source's "Click to place text" popup) -->
  <div class="bg-base-100 w-full absolute bottom-0 left-0 z-10 p-2 text-sm flex flex-col gap-2 border-t border-base-300 md:flex-row md:items-center md:px-4" role="status" aria-live="polite">
    <span class="w-auto min-w-0">{toolStatus}</span>
    <button class="btn btn-sm btn-error self-start md:ml-auto" onclick={cancelOperation}>Cancel operation (Esc or V)</button>
  </div>
{/if}
