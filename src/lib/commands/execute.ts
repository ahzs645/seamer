// Command dispatcher + external automation API.
//
// executeCommand() runs a registered command against a supplied pattern and commits the result
// through an `apply(next, label)` callback (the studio wires this to its undo-aware update path, so
// the command bus never bypasses history or duplicates editor state). installCommandApi() exposes a
// stable `window.seamscape` surface so external scripts / agents can drive the editor locally — no
// login, no network: the whole command registry runs in-page.

import type { Pattern } from '$lib/types/pattern';
import type { Selection } from './selection';
import { COMMANDS, COMMAND_LIST } from './registry';
import { makeUid, type CommandResult, type CommandContext } from './types';

export interface ExecuteHost {
  /** Snapshot of the current pattern. */
  getPattern: () => Pattern;
  /** The current editor selection. */
  getSelection: () => Selection;
  /** Commit a new pattern with an undo label. No-op expected when next === current. */
  apply: (next: Pattern, label: string) => void;
}

/** Run a command by type. Returns {ok, changed, error}; commits via host.apply when it changes. */
export function executeCommand(host: ExecuteHost, type: string, params: Record<string, unknown> = {}): CommandResult {
  const def = COMMANDS.get(type);
  if (!def) return { ok: false, changed: false, error: `Unknown command: ${type}` };
  const pattern = host.getPattern();
  const ctx: CommandContext = { selection: host.getSelection(), uid: makeUid };
  let next: Pattern;
  try {
    next = def.run(pattern, params, ctx);
  } catch (e) {
    return { ok: false, changed: false, error: e instanceof Error ? e.message : String(e) };
  }
  const changed = next !== pattern && JSON.stringify(next) !== JSON.stringify(pattern);
  if (changed) host.apply(next, def.label ?? def.summary);
  return { ok: true, changed };
}

/** A serialisable description of the whole command surface (for docs / agent tool schemas). */
export function commandSchema() {
  return COMMAND_LIST.map((d) => ({
    type: d.type,
    category: d.category,
    summary: d.summary,
    inputs: d.inputs,
    example: d.example ?? null
  }));
}

declare global {
  interface Window {
    seamscape?: {
      commands: () => ReturnType<typeof commandSchema>;
      execute: (type: string, params?: Record<string, unknown>) => CommandResult;
      getPattern: () => Pattern;
      getSelection: () => Selection;
    };
  }
}

/** Install the `window.seamscape` automation API. Returns a disposer. Safe to call only in browser. */
export function installCommandApi(host: ExecuteHost): () => void {
  if (typeof window === 'undefined') return () => {};
  window.seamscape = {
    commands: commandSchema,
    execute: (type, params) => executeCommand(host, type, params),
    getPattern: host.getPattern,
    getSelection: host.getSelection
  };
  return () => {
    if (window.seamscape) delete window.seamscape;
  };
}
