// Seamer pattern schema — realigned to the original application's data model.
// All 2D coordinates are in millimeters; the 3D renderer divides by 1000 to get meters.
// This file is the single source of truth consumed by the 2D canvas, the panels and the
// 3D renderer (avatar reconstruction, arrangement, triangulation and cloth simulation).

export interface Formula {
  formula: string;
  unit: 'inch' | 'cm' | 'mm' | 'degrees' | 'radians' | string;
}

export interface ConstrainablePoint {
  id: string;
  name: string;
  x: number; // millimeters
  y: number; // millimeters
}

/** A 2D vector used for grain direction / piece origin (carries an id+name in the data). */
export interface NamedVector {
  id: string;
  name: string;
  x: number;
  y: number;
}

export interface Variable {
  id: string; // e.g. "var_89ti3xo9e"
  name: string; // human name, e.g. "waist_width"
  description?: string; // optional notes about how the variable is used
  type: 'number' | 'boolean' | 'enum' | 'string' | 'length' | 'angle' | string;
  value: number | null; // cached resolved value (null = recompute from formula)
  valueFormula: Formula;
  isEditable: boolean;
  isVisible: boolean;
  options: unknown[];
  unitType: string;
}

/** Cubic Bézier control tangents stored on a curve path point (offsets in mm, relative to anchor). */
export interface BezierHandle {
  v1: { x: number; y: number }; // incoming control offset
  v2: { x: number; y: number }; // outgoing control offset
  sameLength: boolean;
  sameAngle: boolean;
  lengthFormula: Formula;
  angleFormula: Formula;
}

export interface PathPoint {
  id: string; // ConstrainablePoint id
  handle?: BezierHandle;
}

export interface SlidingPoint {
  id: string; // ConstrainablePoint id (its resolved x/y is stored in points[])
  positionFormula?: Formula;
  positionType?: 'along' | string;
  positionFrom?: string; // ConstrainablePoint id the offset is measured from
}

export interface ConstrainablePath {
  id: string;
  name: string;
  pathType: 'line' | 'curve' | 'referenced' | string;
  pathPoints: PathPoint[];
  slidingPoints?: SlidingPoint[];
  basePoint?: string | null;
  version: number;
  lengthFormula?: Formula;
  angleFormula?: Formula;
  // referenced-path only:
  referencedPath?: string;
  referencedFromPoint?: string;
  referencedToPoint?: string;
  mirrorX?: boolean;
  mirrorY?: boolean;
  mirrorLine?: string;
}

export interface Notch {
  id?: string;
  position?: number;
  size?: number;
  [k: string]: unknown;
}

/** A boundary edge of a piece: a span of a ConstrainablePath between two points. */
export interface PiecePath {
  id: string; // PiecePath_xxx — distinct id used by seams
  name: string;
  path: string; // ConstrainablePath id supplying the geometry
  from: string; // ConstrainablePoint id
  to: string; // ConstrainablePoint id
  reversed: boolean;
  isMirrorLine?: boolean;
  notches: Notch[];
}

export interface PieceArrangement {
  mode: 'curved' | 'flat' | string;
  cylinderName: string; // body cylinder to attach to, e.g. "Torso"
  uDegrees: number; // circumferential angle on the cylinder (deg)
  v: number; // axial param (0 = startBone end, 1 = endBone end)
  uOffsetMm: number; // tangential nudge around the cylinder (mm)
  vOffsetMm: number; // axial nudge along the cylinder (mm)
  radialOffsetMm: number; // push outward from the surface (mm)
  use2DPosition: boolean; // true => ignore cylinder, lay flat in 2D plane
  positionChanged: boolean;
  matrixWorld: number[]; // 16-float column-major saved group transform (meters)
  position: number[]; // 3-float translation extracted from matrixWorld (meters)
}

export interface PieceSettings3D {
  arrangement: PieceArrangement;
  enable3d: boolean;
  frozen: boolean; // exclude from simulation (pinned)
  flipNormals: boolean;
  filterExternalCollisionsByClothNormal: boolean;
  collisionLayer: number;
  particleDistance?: number | null; // per-piece mesh resolution override (mm)
  // flat per-particle cache of the settled rest state, stride 5: [x2d, y2d, x3d, y3d, z3d]
  // x2d/y2d in mm, x3d/y3d/z3d in meters.
  savedPositions: number[];
}

export interface Piece {
  id: string;
  name: string;
  type: 'dynamic' | string; // "dynamic" => closed simulatable cloth piece
  materialId: string;
  origin: NamedVector; // piece-local origin in 2D mm
  originPoint: string; // ConstrainablePoint id of the origin
  position: { x: number; y: number }; // piece placement on the 2D canvas (mm)
  rotation: number; // degrees
  grainVector: NamedVector; // fabric grain direction (default {x:0,y:1})
  text: string | null;
  rightPieces: number;
  leftPieces: number;
  mirrorLeftPiecesAxis: 'X' | 'Y' | string;
  mirrorX: boolean;
  mirrorY: boolean;
  seamAllowanceInside: boolean;
  mainPaths: PiecePath[]; // ordered boundary loop
  internalPaths: PiecePath[]; // darts / internal seams / fold lines
  settings3d: PieceSettings3D;
  hidden?: boolean; // object-browser visibility toggle (omitted = visible)
}

export interface TextureSlot {
  url: string;
  mediaId: string | null;
  color: string; // hex tint; used as base color when there is no map
  scale: number; // physical tile size in mm (texture repeats every `scale` mm)
  normalUrl: string;
  normalMediaId: string | null;
  normalMapScale: number;
  opacityUrl: string;
  opacityMediaId: string | null;
  opacityMapScale: number;
}

export interface Material {
  id: string;
  name: string;
  frontTexture: TextureSlot | null;
  backTexture: TextureSlot | null;
  useSeparateBackSide: boolean;
  // cloth simulation params (UI scale 0..100):
  stretchWarpValue: number;
  stretchWeftValue: number;
  bendValue: number;
  thickness: number; // mm
  weight: number; // g/m²
  // PBR params:
  roughness: number;
  metalness: number;
  specularIntensity: number;
  opacity: number;
  normalScale: number;
  alphaCutoff: number;
  libraryItemId: string | null;
  libraryVersion: number | null;
  libraryUpdatedAt: string | null;
}

export interface SeamRef {
  id: string; // PiecePath id
  mirrored: boolean;
  reversed: boolean;
}

export interface Seam {
  id: string;
  name: string;
  fromPaths: SeamRef[];
  toPaths: SeamRef[];
}

export interface Body {
  // Map of measurement name -> value. Always includes age (years), height, weight.
  // Lengths are in the unit indicated by unitType (imperial => inch/lb, metric => cm/kg).
  fields: Record<string, number>;
  gender: 'female' | 'male' | string;
  unitType: 'imperial' | 'metric' | string;
  bodyColor: string; // hex
}

export interface Layer {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  order: number;
  style: unknown | null;
}

export interface PatternSettings3D {
  cameraFov: number;
  cameraPosition: [number, number, number];
  controlsTarget: [number, number, number];
  gravity: [number, number, number];
  avatarEnabled: boolean;
  showAvatar: boolean;
  showArrangementPoints: boolean;
  showTriangles: boolean;
  showSeams: boolean;
  lightingMode: 'flat' | 'hdri' | 'studio1' | 'studio2' | 'sunset' | string;
  bokehFStop: number;
  n8aoEnabled: boolean;
  n8aoRadius: number;
  n8aoDistanceFalloff: number;
  n8aoIntensity: number;
  smaaScale: number;
  forceLowEndHardware: boolean;
  handleSelfCollisions: boolean;
  debugFocusPoint: boolean;
}

export interface PatternImage {
  id: string;
  [k: string]: unknown;
}

export interface PatternText {
  id: string;
  [k: string]: unknown;
}

export interface Pattern {
  id: string;
  name: string;
  description: string;
  lengthUnit: 'inch' | 'cm' | 'mm';
  angleUnit: 'degrees' | 'radians';
  defaultNotchSize: number; // mm
  isPublic: boolean;
  pointLabeling: 'numeric' | 'alphabetic' | string;
  pointPrefix: string;

  points: ConstrainablePoint[];
  variables: Variable[];
  paths: ConstrainablePath[];
  pieces: Piece[];
  seams: Seam[];
  materials: Material[];

  seamAllowance: number; // mm
  versionName: string;
  versionId: string;
  versionNumber: number;
  softwareVersion: string;
  currentSize: string;
  images: PatternImage[];
  frozenSnapshot: unknown | null;
  texts: PatternText[];
  body: Body;
  layers: Layer[];
  currentLayerId: string;
  useBodyMeasurementsForSizes: boolean;
  gradingProfile: unknown | null;
  markerSettings: unknown | null;

  graphicsOffset: { x: number; y: number };
  graphicsScale: number; // 2D canvas px-per-mm zoom
  enable3d: boolean;
  showCompass: boolean;
  showGrid: boolean;
  snapToGrid: boolean;
  snapToGuides: boolean;
  showPieceNames: boolean;
  viewMode: '2d' | '3d' | 'both';
  interactionMode: 'fast' | 'accurate' | string;
  settings3d: PatternSettings3D;
  hasChanged: boolean;
}

export interface PatternSummary {
  id: string;
  name: string;
  description: string;
  is3d: boolean;
  thumbnailUrl: string | null;
  updatedAt: string;
  ownerUserId: string;
  organizationId: string | null;
  organization: unknown | null;
  owner: {
    id: string;
    firstName: string;
    lastName: string | null;
    email: string;
    image: string | null;
  };
}

export function defaultPatternSettings3D(): PatternSettings3D {
  return {
    cameraFov: 54.43,
    cameraPosition: [0.49, 0.83, 0.84],
    controlsTarget: [0.095, 0.77, 0.053],
    gravity: [0, -9.8, 0],
    avatarEnabled: true,
    showAvatar: true,
    showArrangementPoints: false,
    showTriangles: false,
    showSeams: true,
    lightingMode: 'flat',
    bokehFStop: 11,
    n8aoEnabled: false,
    n8aoRadius: 0.6,
    n8aoDistanceFalloff: 1.5,
    n8aoIntensity: 5,
    smaaScale: 2,
    forceLowEndHardware: false,
    handleSelfCollisions: true,
    debugFocusPoint: false
  };
}

export function createEmptyPattern(): Pattern {
  return {
    id: crypto.randomUUID(),
    name: 'New Pattern',
    description: '',
    lengthUnit: 'inch',
    angleUnit: 'degrees',
    defaultNotchSize: 6.35,
    isPublic: false,
    pointLabeling: 'numeric',
    pointPrefix: 'A',
    points: [],
    variables: [],
    paths: [],
    pieces: [],
    seams: [],
    materials: [],
    seamAllowance: 12.7,
    versionName: 'Initial',
    versionId: crypto.randomUUID(),
    versionNumber: 1,
    softwareVersion: '1.0.0',
    currentSize: '',
    images: [],
    frozenSnapshot: null,
    texts: [],
    body: {
      fields: { age: 35, height: 65, weight: 150 },
      gender: 'female',
      unitType: 'imperial',
      bodyColor: '#b58a6a'
    },
    layers: [{ id: 'default', name: 'Default', visible: true, locked: false, order: 0, style: null }],
    currentLayerId: 'default',
    useBodyMeasurementsForSizes: false,
    gradingProfile: null,
    markerSettings: null,
    graphicsOffset: { x: 0, y: 0 },
    graphicsScale: 0.31,
    enable3d: true,
    showCompass: false,
    showGrid: true,
    snapToGrid: false,
    snapToGuides: false,
    showPieceNames: true,
    viewMode: 'both',
    interactionMode: 'fast',
    settings3d: defaultPatternSettings3D(),
    hasChanged: false
  };
}

/** Eager singleton kept for components that import a constant; prefer createEmptyPattern(). */
export const EMPTY_PATTERN: Pattern = createEmptyPattern();
