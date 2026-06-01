// The command registry — the unified operation surface. Each entry is schema-described (like the
// original studio's registry) and backed by a pure reducer. Components, the command palette,
// keyboard shortcuts and external automation all dispatch through these.

import type { Pattern } from '$lib/types/pattern';
import type { CommandDef } from './types';
import {
  selectionMove, selectionRotate, selectionScale, selectionMirror, selectionMoveToLayer, selectionDelete
} from './selection';
import {
  elementBringToFront, elementSendToBack, elementMoveToLayer, elementRename, elementDelete
} from './element';
import {
  variableReorder, variableSetOptions, variableUpdate,
  layerRename, layerSetStyle, imageUpdate, textUpdate, type LayerStyle
} from './structural';
import { pieceAddPath } from './piece';

const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);

const defs: CommandDef[] = [
  // --- selection (batch transforms) -----------------------------------------
  {
    type: 'selection.move', category: 'selection', label: 'Move selection',
    summary: 'Move the current selection by a delta (mm).', inputs: ['dx', 'dy'],
    example: { dx: 10, dy: 0 },
    run: (p, a, c) => selectionMove(p, c.selection, num(a.dx), num(a.dy))
  },
  {
    type: 'selection.rotate', category: 'selection', label: 'Rotate selection',
    summary: 'Rotate the current selection by degrees about its centroid.', inputs: ['degrees'],
    example: { degrees: 90 },
    run: (p, a, c) => selectionRotate(p, c.selection, num(a.degrees))
  },
  {
    type: 'selection.scale', category: 'selection', label: 'Scale selection',
    summary: 'Scale the current selection by a factor about its centroid.', inputs: ['factor', 'factorY?'],
    example: { factor: 1.1 },
    run: (p, a, c) => selectionScale(p, c.selection, num(a.factor, 1), a.factorY === undefined ? num(a.factor, 1) : num(a.factorY, 1))
  },
  {
    type: 'selection.mirror', category: 'selection', label: 'Mirror selection',
    summary: 'Mirror the current selection on the x or y axis.', inputs: ['axis'],
    example: { axis: 'x' },
    run: (p, a, c) => selectionMirror(p, c.selection, str(a.axis, 'x') === 'y' ? 'y' : 'x')
  },
  {
    type: 'selection.moveToLayer', category: 'selection', label: 'Move selection to layer',
    summary: 'Move selected elements to a layer.', inputs: ['layerId'],
    run: (p, a, c) => selectionMoveToLayer(p, c.selection, str(a.layerId))
  },
  {
    type: 'selection.delete', category: 'selection', label: 'Delete selection',
    summary: 'Delete the selected elements.', inputs: [],
    run: (p, _a, c) => selectionDelete(p, c.selection)
  },

  // --- element (any-kind ops) -----------------------------------------------
  {
    type: 'element.bringToFront', category: 'element', label: 'Bring to front',
    summary: 'Move a path or piece to the front of its draw order.', inputs: ['id'],
    run: (p, a) => elementBringToFront(p, str(a.id))
  },
  {
    type: 'element.sendToBack', category: 'element', label: 'Send to back',
    summary: 'Move a path or piece to the back of its draw order.', inputs: ['id'],
    run: (p, a) => elementSendToBack(p, str(a.id))
  },
  {
    type: 'element.moveToLayer', category: 'element', label: 'Move to layer',
    summary: 'Move one element (point/path/piece/text) to a layer.', inputs: ['id', 'layerId'],
    run: (p, a) => elementMoveToLayer(p, str(a.id), str(a.layerId))
  },
  {
    type: 'element.rename', category: 'element', label: 'Rename element',
    summary: 'Rename a resolvable element.', inputs: ['id', 'name'],
    run: (p, a) => elementRename(p, str(a.id), str(a.name))
  },
  {
    type: 'element.delete', category: 'element', label: 'Delete element',
    summary: 'Delete one resolvable element by id.', inputs: ['id'],
    run: (p, a) => elementDelete(p, str(a.id))
  },

  // --- piece building --------------------------------------------------------
  {
    type: 'piecePath.add', category: 'piecePath', label: 'Add path to piece',
    summary: 'Add an existing draft path to a piece as a boundary or internal edge.',
    inputs: ['pieceId', 'pathId', 'kind?'],
    example: { pieceId: 'Piece_x', pathId: 'Path_y', kind: 'main' },
    run: (p, a, c) => pieceAddPath(p, str(a.pieceId), str(a.pathId), str(a.kind, 'main') === 'internal' ? 'internal' : 'main', c.uid)
  },

  // --- point -----------------------------------------------------------------
  {
    type: 'point.move', category: 'point', label: 'Move point',
    summary: 'Move one point to an absolute coordinate (mm).', inputs: ['pointId', 'x', 'y'],
    run: (p, a) => ({
      ...p,
      points: p.points.map((pt) => (pt.id === str(a.pointId) ? { ...pt, x: num(a.x, pt.x), y: num(a.y, pt.y) } : pt)),
      hasChanged: true
    })
  },
  {
    type: 'point.rename', category: 'point', label: 'Rename point',
    summary: 'Rename a construction point.', inputs: ['pointId', 'name'],
    run: (p, a) => ({
      ...p,
      points: p.points.map((pt) => (pt.id === str(a.pointId) ? { ...pt, name: str(a.name, pt.name) } : pt)),
      hasChanged: true
    })
  },

  // --- path ------------------------------------------------------------------
  {
    type: 'path.reverse', category: 'path', label: 'Reverse path',
    summary: 'Reverse a path direction.', inputs: ['pathId'],
    run: (p, a) => ({
      ...p,
      paths: p.paths.map((path) => {
        if (path.id !== str(a.pathId)) return path;
        const pathPoints = [...path.pathPoints].reverse().map((pp) =>
          pp.handle ? { ...pp, handle: { ...pp.handle, v1: pp.handle.v2, v2: pp.handle.v1 } } : pp
        );
        return { ...path, pathPoints, version: (path.version ?? 0) + 1 };
      }),
      hasChanged: true
    })
  },

  // --- variable --------------------------------------------------------------
  {
    type: 'variable.reorder', category: 'variable', label: 'Reorder variable',
    summary: 'Move a variable to a new index in the variable list.', inputs: ['variableId', 'toIndex'],
    run: (p, a) => variableReorder(p, str(a.variableId), num(a.toIndex))
  },
  {
    type: 'variable.setOptions', category: 'variable', label: 'Set variable options',
    summary: 'Set enum options for a variable.', inputs: ['variableId', 'options[]'],
    example: { variableId: 'var_x', options: ['Small', 'Medium', 'Large'] },
    run: (p, a) => variableSetOptions(p, str(a.variableId), Array.isArray(a.options) ? a.options : [])
  },
  {
    type: 'variable.setType', category: 'variable', label: 'Set variable type',
    summary: 'Set a variable type.', inputs: ['variableId', 'type'],
    run: (p, a) => variableUpdate(p, str(a.variableId), { type: str(a.type, 'number') })
  },
  {
    type: 'variable.setValue', category: 'variable', label: 'Set variable value',
    summary: 'Set a variable override value.', inputs: ['variableId', 'value'],
    run: (p, a) => variableUpdate(p, str(a.variableId), { overrideValue: (a.value ?? null) as string | number | null })
  },
  {
    type: 'variable.setVisible', category: 'variable', label: 'Toggle variable visibility',
    summary: 'Toggle whether a variable is visible in the UI.', inputs: ['variableId', 'visible'],
    run: (p, a) => variableUpdate(p, str(a.variableId), { isVisible: a.visible !== false })
  },
  {
    type: 'variable.setEditable', category: 'variable', label: 'Toggle variable editable',
    summary: 'Toggle whether a variable is editable.', inputs: ['variableId', 'editable'],
    run: (p, a) => variableUpdate(p, str(a.variableId), { isEditable: a.editable !== false })
  },
  {
    type: 'variable.setDescription', category: 'variable', label: 'Set variable description',
    summary: 'Set variable documentation text.', inputs: ['variableId', 'description'],
    run: (p, a) => variableUpdate(p, str(a.variableId), { description: str(a.description) })
  },

  // --- layer -----------------------------------------------------------------
  {
    type: 'layer.rename', category: 'layer', label: 'Rename layer',
    summary: 'Rename a layer.', inputs: ['layerId', 'name'],
    run: (p, a) => layerRename(p, str(a.layerId), str(a.name))
  },
  {
    type: 'layer.setStyle', category: 'layer', label: 'Set layer style',
    summary: 'Set or clear a layer style override.', inputs: ['layerId', 'style'],
    example: { layerId: 'default', style: { color: '#3b82f6', dashed: true } },
    run: (p, a) => layerSetStyle(p, str(a.layerId), (a.style ?? null) as LayerStyle | null)
  },
  {
    type: 'layer.setVisible', category: 'layer', label: 'Toggle layer visibility',
    summary: 'Show or hide a layer.', inputs: ['layerId', 'visible'],
    run: (p, a) => ({ ...p, layers: p.layers.map((l) => (l.id === str(a.layerId) ? { ...l, visible: a.visible !== false } : l)), hasChanged: true })
  },
  {
    type: 'layer.setLocked', category: 'layer', label: 'Toggle layer lock',
    summary: 'Lock or unlock a layer.', inputs: ['layerId', 'locked'],
    run: (p, a) => ({ ...p, layers: p.layers.map((l) => (l.id === str(a.layerId) ? { ...l, locked: a.locked === true } : l)), hasChanged: true })
  },
  {
    type: 'layer.setCurrent', category: 'layer', label: 'Set current layer',
    summary: 'Set the current layer for new geometry.', inputs: ['layerId'],
    run: (p, a) => ({ ...p, currentLayerId: str(a.layerId, p.currentLayerId), hasChanged: true })
  },

  // --- pattern settings ------------------------------------------------------
  {
    type: 'pattern.setName', category: 'pattern', label: 'Set pattern name',
    summary: 'Set the pattern name.', inputs: ['name'],
    run: (p, a) => ({ ...p, name: str(a.name, p.name), hasChanged: true })
  },
  {
    type: 'pattern.setDescription', category: 'pattern', label: 'Set pattern description',
    summary: 'Set the pattern description.', inputs: ['description'],
    run: (p, a) => ({ ...p, description: str(a.description), hasChanged: true })
  },
  {
    type: 'pattern.setSeamAllowance', category: 'pattern', label: 'Set seam allowance',
    summary: 'Set the default seam allowance (mm).', inputs: ['seamAllowance'],
    run: (p, a) => ({ ...p, seamAllowance: num(a.seamAllowance, p.seamAllowance), hasChanged: true })
  },
  {
    type: 'pattern.setDefaultNotchSize', category: 'pattern', label: 'Set default notch size',
    summary: 'Set the default notch size (mm).', inputs: ['size'],
    run: (p, a) => ({ ...p, defaultNotchSize: num(a.size, p.defaultNotchSize), hasChanged: true })
  },
  {
    type: 'pattern.setPointNaming', category: 'pattern', label: 'Set point naming',
    summary: 'Set point naming mode and prefix.', inputs: ['mode?', 'prefix?'],
    run: (p, a) => ({ ...p, pointLabeling: str(a.mode, p.pointLabeling), pointPrefix: str(a.prefix, p.pointPrefix), hasChanged: true })
  },
  {
    type: 'pattern.setUnit', category: 'pattern', label: 'Set units',
    summary: 'Set pattern length and/or angle units.', inputs: ['lengthUnit?', 'angleUnit?'],
    run: (p, a) => ({
      ...p,
      lengthUnit: (str(a.lengthUnit, p.lengthUnit) as Pattern['lengthUnit']),
      angleUnit: (str(a.angleUnit, p.angleUnit) as Pattern['angleUnit']),
      hasChanged: true
    })
  },
  {
    type: 'pattern.setPublic', category: 'pattern', label: 'Set pattern visibility',
    summary: 'Mark the pattern public or private (local metadata).', inputs: ['isPublic'],
    run: (p, a) => ({ ...p, isPublic: a.isPublic === true, hasChanged: true })
  },

  // --- image / text ----------------------------------------------------------
  {
    type: 'image.update', category: 'image', label: 'Update background image',
    summary: 'Update background image dimensions and locks.', inputs: ['imageId', 'width?', 'height?', 'rotation?', 'opacity?', 'locked?', 'lockAspect?', 'layerId?'],
    run: (p, a) => imageUpdate(p, str(a.imageId), a as Parameters<typeof imageUpdate>[2])
  },
  {
    type: 'text.update', category: 'text', label: 'Update text',
    summary: 'Update text annotation content, style and layer.', inputs: ['textId', 'value?', 'fontSize?', 'color?', 'align?', 'rotation?', 'layerId?'],
    run: (p, a) => textUpdate(p, str(a.textId), a as Parameters<typeof textUpdate>[2])
  }
];

export const COMMANDS: ReadonlyMap<string, CommandDef> = new Map(defs.map((d) => [d.type, d]));

/** All command definitions, sorted by category then type — for the palette / docs. */
export const COMMAND_LIST: readonly CommandDef[] = [...defs].sort(
  (a, b) => a.category.localeCompare(b.category) || a.type.localeCompare(b.type)
);

/** The category → commands index, for grouped display. */
export function commandsByCategory(): Map<string, CommandDef[]> {
  const m = new Map<string, CommandDef[]>();
  for (const d of COMMAND_LIST) {
    const arr = m.get(d.category) ?? [];
    arr.push(d);
    m.set(d.category, arr);
  }
  return m;
}
