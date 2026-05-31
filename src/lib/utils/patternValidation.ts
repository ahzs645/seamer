// Pattern integrity checks — surfaces broken references and degenerate geometry the way the
// original studio's "Errors" panel does. Pure: takes a Pattern, returns a list of issues.

import type { Pattern } from '$lib/types/pattern';
import { indexPoints, indexPaths, pieceOutline } from '$lib/utils/patternGeometry';

export interface Issue {
  severity: 'error' | 'warning';
  message: string;
  /** id of the offending object, if selectable */
  targetId?: string;
}

export function validatePattern(pattern: Pattern): Issue[] {
  const issues: Issue[] = [];
  const points = indexPoints(pattern);
  const paths = indexPaths(pattern);
  const piecePathIds = new Set<string>();
  for (const piece of pattern.pieces) {
    for (const pp of piece.mainPaths) piecePathIds.add(pp.id);
    for (const pp of piece.internalPaths) piecePathIds.add(pp.id);
  }

  // duplicate point names
  const nameCounts = new Map<string, number>();
  for (const pt of pattern.points) nameCounts.set(pt.name, (nameCounts.get(pt.name) ?? 0) + 1);
  for (const [nm, n] of nameCounts) {
    if (nm && n > 1) issues.push({ severity: 'warning', message: `Duplicate point name "${nm}" (${n} points)` });
  }

  // paths referencing missing points
  for (const path of pattern.paths) {
    for (const pp of path.pathPoints) {
      if (!points.has(pp.id)) {
        issues.push({ severity: 'error', message: `Path "${path.name || path.id}" references a missing point`, targetId: path.id });
        break;
      }
    }
  }

  // piece-level checks
  for (const piece of pattern.pieces) {
    if (piece.mainPaths.length < 3) {
      issues.push({ severity: 'error', message: `Piece "${piece.name}" has fewer than 3 boundary edges`, targetId: piece.id });
    }
    for (const pp of [...piece.mainPaths, ...piece.internalPaths]) {
      if (pp.path && !paths.has(pp.path)) {
        issues.push({ severity: 'error', message: `Piece "${piece.name}": edge "${pp.name || pp.id}" references a missing path`, targetId: piece.id });
      }
      if (!points.has(pp.from) || !points.has(pp.to)) {
        issues.push({ severity: 'error', message: `Piece "${piece.name}": edge "${pp.name || pp.id}" has a missing endpoint`, targetId: piece.id });
      }
    }
    // boundary fails to stitch into a closed loop
    if (piece.mainPaths.length >= 3) {
      const outline = pieceOutline(pattern, piece, paths, points, 8);
      if (outline.length < 3) {
        issues.push({ severity: 'warning', message: `Piece "${piece.name}" boundary does not form a closed loop`, targetId: piece.id });
      }
    }
  }

  // seams referencing missing piece-path edges
  for (const seam of pattern.seams) {
    for (const ref of [...seam.fromPaths, ...seam.toPaths]) {
      if (!piecePathIds.has(ref.id)) {
        issues.push({ severity: 'error', message: `Seam "${seam.name || seam.id}" references a deleted edge`, targetId: seam.id });
        break;
      }
    }
  }

  return issues;
}
