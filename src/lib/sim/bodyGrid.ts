// Uniform spatial grid of the (posed, static) body triangles for cloth-vs-body collision.
// Built on the CPU and uploaded to the GPU; rebuilt only when the body shape/pose changes.

export interface BodyGrid {
  positions: Float32Array; // vec4 per body vertex: x,y,z,0
  triangles: Uint32Array; // vec4u per triangle: i0,i1,i2,0
  cellStart: Uint32Array; // length numCells+1 (prefix sum)
  cellTris: Uint32Array; // triangle indices grouped by cell
  origin: [number, number, number];
  cellSize: number;
  dims: [number, number, number];
  numTriangles: number;
}

const CELL_SIZE = 0.04; // m

export function buildBodyGrid(vertexPositions: Float32Array, indices: Uint32Array): BodyGrid {
  const numVerts = vertexPositions.length / 3;
  const numTris = indices.length / 3;

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < vertexPositions.length; i += 3) {
    const x = vertexPositions[i], y = vertexPositions[i + 1], z = vertexPositions[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const pad = CELL_SIZE;
  const origin: [number, number, number] = [minX - pad, minY - pad, minZ - pad];
  const dims: [number, number, number] = [
    Math.max(1, Math.ceil((maxX - minX + 2 * pad) / CELL_SIZE)),
    Math.max(1, Math.ceil((maxY - minY + 2 * pad) / CELL_SIZE)),
    Math.max(1, Math.ceil((maxZ - minZ + 2 * pad) / CELL_SIZE))
  ];
  const numCells = dims[0] * dims[1] * dims[2];

  const cellOf = (cx: number, cy: number, cz: number) => (cz * dims[1] + cy) * dims[0] + cx;
  const triCell = new Int32Array(numTris);
  const counts = new Uint32Array(numCells + 1);

  for (let t = 0; t < numTris; t++) {
    const i0 = indices[t * 3], i1 = indices[t * 3 + 1], i2 = indices[t * 3 + 2];
    const cx = (vertexPositions[i0 * 3] + vertexPositions[i1 * 3] + vertexPositions[i2 * 3]) / 3;
    const cy = (vertexPositions[i0 * 3 + 1] + vertexPositions[i1 * 3 + 1] + vertexPositions[i2 * 3 + 1]) / 3;
    const cz = (vertexPositions[i0 * 3 + 2] + vertexPositions[i1 * 3 + 2] + vertexPositions[i2 * 3 + 2]) / 3;
    const gx = Math.min(dims[0] - 1, Math.max(0, Math.floor((cx - origin[0]) / CELL_SIZE)));
    const gy = Math.min(dims[1] - 1, Math.max(0, Math.floor((cy - origin[1]) / CELL_SIZE)));
    const gz = Math.min(dims[2] - 1, Math.max(0, Math.floor((cz - origin[2]) / CELL_SIZE)));
    const c = cellOf(gx, gy, gz);
    triCell[t] = c;
    counts[c + 1]++;
  }
  for (let i = 0; i < numCells; i++) counts[i + 1] += counts[i];
  const cellStart = counts; // prefix sum, length numCells+1
  const cellTris = new Uint32Array(numTris);
  const cursor = cellStart.slice();
  for (let t = 0; t < numTris; t++) {
    const c = triCell[t];
    cellTris[cursor[c]++] = t;
  }

  const positions = new Float32Array(numVerts * 4);
  for (let i = 0; i < numVerts; i++) {
    positions[i * 4] = vertexPositions[i * 3];
    positions[i * 4 + 1] = vertexPositions[i * 3 + 1];
    positions[i * 4 + 2] = vertexPositions[i * 3 + 2];
  }
  const triangles = new Uint32Array(numTris * 4);
  for (let t = 0; t < numTris; t++) {
    triangles[t * 4] = indices[t * 3];
    triangles[t * 4 + 1] = indices[t * 3 + 1];
    triangles[t * 4 + 2] = indices[t * 3 + 2];
  }

  return { positions, triangles, cellStart, cellTris, origin, cellSize: CELL_SIZE, dims, numTriangles: numTris };
}
