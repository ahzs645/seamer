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

let undoStack: Pattern[] = [];
let redoStack: Pattern[] = [];

export function pushUndo(p: Pattern) {
  undoStack.push(p);
  redoStack = [];
  if (undoStack.length > 50) undoStack.shift();
}

export function undo() {
  return undoStack.length > 0 ? undoStack.pop()! : null;
}

export function redo() {
  return redoStack.length > 0 ? redoStack.pop()! : null;
}
