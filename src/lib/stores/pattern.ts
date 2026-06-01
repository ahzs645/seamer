import { writable, derived } from 'svelte/store';
import type { Pattern } from '$lib/types/pattern';
import { EMPTY_PATTERN } from '$lib/types/pattern';

export const pattern = writable<Pattern>(structuredClone(EMPTY_PATTERN));

export const selectedTool = writable<string>('select');

export const zoom = writable<number>(1);

export const panOffset = writable<{ x: number; y: number }>({ x: 0, y: 0 });

export const selectedPointIds = writable<Set<string>>(new Set());

export const selectedPathIds = writable<Set<string>>(new Set());

export const selectedPieceIds = writable<Set<string>>(new Set());

export const showGrid = writable<boolean>(true);

export const snapToGrid = writable<boolean>(false);

export const interactionMode = writable<'fast' | 'accurate'>('fast');

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
}

/**
 * Record the pre-edit pattern under a command label. `label` describes the action that is about
 * to change the pattern (e.g. "Add seam"), so undoing back past this entry is shown as that name.
 */
export function pushUndo(p: Pattern, label = 'Edit') {
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
