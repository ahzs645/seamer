import { writable, derived } from 'svelte/store';
import { browser } from '$app/environment';
import type { Pattern, Piece, ConstrainablePoint, ConstrainablePath } from '$lib/types/pattern';
import { EMPTY_PATTERN } from '$lib/types/pattern';
import { saveHistory, loadHistory, deleteHistory } from '$lib/stores/localDB';
import { EMPTY_SEAM_TOOL, type SeamToolState } from '$lib/utils/seamTool';

export const pattern = writable<Pattern>(structuredClone(EMPTY_PATTERN));

export const selectedTool = writable<string>('select');

export const zoom = writable<number>(1);

export const panOffset = writable<{ x: number; y: number }>({ x: 0, y: 0 });

export const selectedPointIds = writable<Set<string>>(new Set());

export const selectedPathIds = writable<Set<string>>(new Set());

export const selectedPieceIds = writable<Set<string>>(new Set());

export const showGrid = writable<boolean>(true);

export const snapToGrid = writable<boolean>(false);

/** Live cursor position in drafting millimetres (set by the 2D canvas), for the status bar. Null when
 *  the pointer is outside the canvas. */
export const cursorMm = writable<{ x: number; y: number } | null>(null);

/** Clipboard payload awaiting click-placement on the 2D canvas (the source's PasteTool flow). A
 *  Ctrl+V arms this; the canvas ghosts the content under the cursor and commits on click.
 *  Paths paste with their points: plain paste REUSES existing anchor points where they still
 *  exist (a referencing copy); `asCopy` (Ctrl+Shift+V, "Paste as copy") duplicates everything. */
export type PendingPaste =
  | { kind: 'pieces'; items: Piece[] }
  | { kind: 'points'; items: ConstrainablePoint[] }
  | { kind: 'paths'; items: { path: ConstrainablePath; points: ConstrainablePoint[] }[]; asCopy?: boolean };
export const pendingPaste = writable<PendingPaste | null>(null);

/** One-shot request to open a PropertyPanel pattern section (e.g. Shift+V → 'sizes' for variables).
 *  The panel consumes it and resets the store to null. */
export const panelRequest = writable<{ section: string } | null>(null);

/** The seam highlighted across views (SeamPanel/ObjectBrowser row → 2D emphasis + direction arrows,
 *  3D display even when "Show seams" is off — the original's shouldDisplaySeams behavior). */
export const selectedSeamId = writable<string | null>(null);

/** In-progress seam tool selection, shared by the 2D canvas and the 3D viewport (both can pick
 *  edges for the same seam, like the original's 2D/3D seam tools). */
export const seamTool = writable<SeamToolState>(EMPTY_SEAM_TOOL);

/** One-shot request to fly the 3D camera to a body measurement (BodyPanel → PatternScene3D). */
export const bodyZoomRequest = writable<string | null>(null);

/** Modal "click a path on the canvas" request (the original's SelectPathTool): the 2D canvas
 *  resolves the next path click into onPick and clears the request; Esc cancels. */
export const pathPickRequest = writable<{ label: string; onPick: (pathId: string) => void } | null>(null);

/** Writable store mirrored to localStorage (browser only) — shared persistence helper. */
export function persisted<T>(key: string, initial: T) {
  let start = initial;
  // Browser-only: guard with SvelteKit's `browser` AND a try/catch, since some SSR runtimes expose a
  // `localStorage` global whose methods throw.
  if (browser) {
    try { const raw = localStorage.getItem(key); if (raw != null) start = JSON.parse(raw) as T; } catch { /* ignore */ }
  }
  const store = writable<T>(start);
  if (browser) store.subscribe((v) => { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* ignore */ } });
  return store;
}
export const autoSaveSeconds = persisted<number>('seamer.autosaveSeconds', 5);
export const show3dStats = persisted<boolean>('seamer.show3dStats', false);
/** Pointer interaction mode: 'safe' = a drag only moves already-selected items (click selects first);
 *  'fast' = dragging an element moves it immediately. */
export const interactionMode = persisted<'fast' | 'safe'>('seamer.interactionMode', 'fast');
/** Opacity of the frozen-snapshot ghost rendered under the live pattern in the 2D canvas. */
export const frozenSnapshotOpacity = persisted<number>('seamer.frozenSnapshotOpacity', 0.35);
/** Show the live cursor / selection coordinate readout in the status bar. */
export const showCoordinates = persisted<boolean>('seamer.showCoordinates', true);
/** "Anchor to saved drape": OFF (default) is the source-parity free-run — while simulating, the
 *  garment is held together only by seams/stretch like the original, so dragging pulls the whole
 *  connected garment. ON softly holds the cached drape (anchor scale 0.08) for extra stability.
 *  Key is versioned: the old 'seamer.simAnchors' default (true) was already persisted in browsers. */
export const simAnchors = persisted<boolean>('seamer.simAnchors.v2', false);

// --- Labeled undo/redo history ------------------------------------------------
// Faithful in spirit to the original application's named editor.execute() commands: each
// history entry carries a human label so the toolbar can show "Undo Add seam" / "Redo Move
// point", and the full history can be surfaced. A snapshot model (whole-pattern entries) is
// kept — it's simple and robust — but the prior implementation never populated the redo stack,
// so redo silently did nothing. undo()/redo() now take the current pattern and shuttle it onto
// the opposite stack, making redo work and keeping labels in sync.
const HISTORY_LIMIT = 100;
export interface UndoEntry {
  pattern: Pattern;
  label: string;
}

let undoStack: UndoEntry[] = [];
let redoStack: UndoEntry[] = [];

/** Label of the edit the next Ctrl+Z will undo (null = nothing to undo). */
export const undoLabel = writable<string | null>(null);
/** Label of the edit the next Ctrl+Shift+Z will redo (null = nothing to redo). */
export const redoLabel = writable<string | null>(null);
/** Recent history labels, newest last, for an optional history dropdown. */
export const historyLabels = writable<string[]>([]);

function refresh() {
  undoLabel.set(undoStack.length ? undoStack[undoStack.length - 1].label : null);
  redoLabel.set(redoStack.length ? redoStack[redoStack.length - 1].label : null);
  historyLabels.set(undoStack.map((e) => e.label));
  schedulePersist();
}

// --- IndexedDB-backed persistence (survives reload) ---------------------------
// The original studio persists its undo history per-pattern (chunk CY_eMlbS.js: a "history"
// object store with per-entry + meta records). We keep the rebuild's two-stack snapshot model
// but mirror it to IndexedDB under the active pattern id, debounced, capped to bound size.
const PERSIST_LIMIT = 30; // most-recent entries persisted per stack (in-memory keeps HISTORY_LIMIT)
let historyPatternId: string | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let restoring = false;

function schedulePersist() {
  if (restoring || !historyPatternId || typeof indexedDB === 'undefined') return;
  if (persistTimer) clearTimeout(persistTimer);
  const id = historyPatternId;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    saveHistory({
      patternId: id,
      undo: undoStack.slice(-PERSIST_LIMIT),
      redo: redoStack.slice(-PERSIST_LIMIT)
    }).catch((e) => console.warn('Failed to persist history', e));
  }, 800);
}

/** Bind the history to a pattern id and restore its persisted undo/redo (no-op if none). Returns
 *  true when prior history was restored. Call when a pattern is opened. */
export async function restoreHistory(patternId: string): Promise<boolean> {
  historyPatternId = patternId;
  if (typeof indexedDB === 'undefined') return false;
  try {
    const rec = await loadHistory(patternId);
    if (rec && (rec.undo?.length || rec.redo?.length)) {
      restoring = true;
      undoStack = rec.undo ?? [];
      redoStack = rec.redo ?? [];
      restoring = false;
      refresh();
      return true;
    }
  } catch (e) {
    console.warn('Failed to restore history', e);
  }
  return false;
}

/** Forget a pattern's persisted history (e.g. when the pattern is deleted). */
export async function clearPersistedHistory(patternId: string): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  try { await deleteHistory(patternId); } catch (e) { console.warn('Failed to clear history store', e); }
}

/**
 * Record the pre-edit pattern under a command label. `label` describes the action that is about
 * to change the pattern (e.g. "Add seam"), so undoing back past this entry is shown as that name.
 *
 * Gesture coalescing (the original's dragTransaction): a rapid stream of pushes with the SAME
 * label (a drag emits one per mousemove) keeps only the first — one undo entry per gesture,
 * holding the pre-gesture pattern.
 */
const COALESCE_MS = 800;
let lastPushLabel = '';
let lastPushAt = 0;

export function pushUndo(p: Pattern, label = 'Edit') {
  const now = Date.now();
  const coalesce = label === lastPushLabel && now - lastPushAt < COALESCE_MS && undoStack.length > 0;
  lastPushLabel = label;
  lastPushAt = now;
  if (coalesce) {
    // same gesture continuing: the existing entry already holds the pre-gesture pattern
    if (redoStack.length) { redoStack = []; refresh(); }
    return;
  }
  undoStack.push({ pattern: p, label });
  redoStack = [];
  if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
  refresh();
}

/** Undo: returns the prior pattern and parks `current` on the redo stack under the same label. */
export function undo(current: Pattern): Pattern | null {
  const entry = undoStack.pop();
  if (!entry) return null;
  redoStack.push({ pattern: current, label: entry.label });
  refresh();
  return entry.pattern;
}

/** Redo: returns the re-applied pattern and parks `current` back on the undo stack. */
export function redo(current: Pattern): Pattern | null {
  const entry = redoStack.pop();
  if (!entry) return null;
  undoStack.push({ pattern: current, label: entry.label });
  if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
  refresh();
  return entry.pattern;
}

/** Wipe history (e.g. when a brand-new pattern is opened and prior history is irrelevant). */
export function resetHistory() {
  undoStack = [];
  redoStack = [];
  refresh();
}

export const canUndo = derived(undoLabel, ($l) => $l !== null);
export const canRedo = derived(redoLabel, ($l) => $l !== null);
