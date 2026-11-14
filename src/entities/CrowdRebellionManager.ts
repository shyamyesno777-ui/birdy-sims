import * as THREE from 'three/webgpu';
import { PALETTE } from '../rendering/Palette.ts';
import {
  createPastelMaterial,
  createUnlitPastelFXMaterial,
} from '../rendering/StorybookMaterial.ts';
import {
  rbox,
  rcyl,
  smoothSphere,
  transformGeo,
  mergeParts,
} from '../geometry/Sculptor.ts';
import {
  COLLISION_GROUP_STATIC,
  createGroundRaycastHit,
  type PhysicsWorld,
} from '../physics/PhysicsWorld.ts';
import type { AcousticSoundtrack } from '../audio/AcousticSoundtrack.ts';
import type { WorldFX } from '../rendering/WorldFX.ts';
import type { EventBus, GameEventMap, RebellionMode } from '../core/EventBus.ts';
import type { PerchSystem } from '../world/PerchSystem.ts';

export const CROWD_POOL_SIZE = 45;
export const MAX_ACTIVE_RAGDOLLS = 15;
export const MAX_ACTIVE_BULLETS = 50;
export const BIRD_MAX_HEALTH = 100;
export const SHOULDER_PERCH_COOLDOWN_SEC = 120.0;
const SHOULDER_HEAL_PER_SEC = 2.0;

const RAGDOLL_DURATION = 3.0;
const RAGDOLL_FADE_START = 2.2;
const ENEMY_BULLET_POOL_SIZE = 50;
const ENEMY_BULLET_SPEED = 66.0;
const ENEMY_BULLET_MAX_AGE = 2.35;
const ENEMY_BULLET_DAMAGE = 10;
const BIRD_HURT_RADIUS = 0.72;
const SHOT_ALERT_RADIUS_SQ = 76 * 76;
const HOSTILE_AGGRO_RADIUS_SQ = 96 * 96;
const HOSTILE_FIRE_RANGE_SQ = 82 * 82;
const MAJOR_REBELLION_KILL_THRESHOLD = 20;
const ESCALATION_KILL_THRESHOLD = 5;
export const COUPLE_PAIR_COUNT = 6;
const COUPLE_SIDE_SEPARATION = 2.15;
const COUPLE_CRY_DURATION = 12.0;

export const TROPHY_CART_START_INDEX = COUPLE_PAIR_COUNT * 2;
export const TROPHY_CART_COUNT = 4;
const TROPHY_CART_END_INDEX = TROPHY_CART_START_INDEX + TROPHY_CART_COUNT;
const EXTREME_RAGE_ACCURACY = 0.7;
const EXTREME_RAGE_BULLET_SPEED = 112.0;
const EXTREME_RAGE_AGGRO_RADIUS_SQ = 130 * 130;
const EXTREME_RAGE_REBELLION_RADIUS_SQ = 78 * 78;
const INTIMIDATE_RANGE_SQ = 22 * 22;
const INTIMIDATE_RESPECT_XP = 25;
const INTIMIDATE_NPC_COOLDOWN = 14.0;
const RESPECT_ORB_POOL_SIZE = 16;

type CrowdArea = 'park' | 'street' | 'cafe';
type CrowdState = 'walking' | 'fleeing' | 'crying' | 'hostile' | 'ragdoll';

interface WalkNode {
  x: number;
  z: number;
  area: CrowdArea;
  neighbors: number[];
}

interface CrowdStyleSpec {
  coatHex: number;
  trouserHex: number;
  skinHex: number;
  hairHex: number;
  scarfHex: number;
}

interface CrowdStyleGeometries {
  torsoHeadGeo: THREE.BufferGeometry;
  armGeo: THREE.BufferGeometry;
  legGeo: THREE.BufferGeometry;
}

interface CrowdHumanSlot {
  index: number;
  root: THREE.Group;
  bodyPivot: THREE.Group;
  torsoHeadMesh: THREE.Mesh;
  armLPivot: THREE.Group;
  armLMesh: THREE.Mesh;
  armRPivot: THREE.Group;
  armRMesh: THREE.Mesh;
  legLPivot: THREE.Group;
  legLMesh: THREE.Mesh;
  legRPivot: THREE.Group;
  legRMesh: THREE.Mesh;
  gunGroup: THREE.Group;
  muzzleFlash: THREE.Mesh;
  heartIconGroup: THREE.Group;
  tearIconGroup: THREE.Group;
  cartGroup: THREE.Group | null;
  trophyGroup: THREE.Group | null;
  trophyHaloMesh: THREE.Mesh | null;
  rageAuraGroup: THREE.Group | null;
  shadowDisc: THREE.Mesh;
  scale: number;
  baseHipY: number;
  voicePitch: number;
  state: CrowdState;
  rolledTier: 0 | 1 | 2;
  hasTrophyCart: boolean;
  trophyIntact: boolean;
  extremeRage: boolean;
  partnerIndex: number;
  coupleId: number;
  couplePauseTimer: number;
  coupleWalkTimer: number;
  yaw: number;
  walkSpeed: number;
  gaitPhase: number;
  groundY: number;
  currentNodeIdx: number;
  targetNodeIdx: number;
  fleeDirX: number;
  fleeDirZ: number;
  fleeTimer: number;
  cryTimer: number;
  intimidateCooldown: number;
  fireCooldown: number;
  muzzleFlashTimer: number;
  steerStuckFrames: number;
  // Ragdoll simulation fields (active up to 15 simultaneously)
  ragdollTimer: number;
  ragdollPos: THREE.Vector3;
  ragdollVel: THREE.Vector3;
  ragdollPitch: number;
  ragdollRoll: number;
  ragdollPitchVel: number;
  ragdollRollVel: number;
  ragdollYawVel: number;
  ragdollMatIdx: number;
}

interface EnemyBulletSlot {
  active: boolean;
  age: number;
  pos: THREE.Vector3;
  prevPos: THREE.Vector3;
  vel: THREE.Vector3;
  mesh: THREE.Mesh;
}

interface RespectOrbSlot {
  active: boolean;
  age: number;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  mesh: THREE.Mesh;
}

export interface CrowdBulletHitCandidate {
  slotIndex: number;
  hitKind: 'human' | 'trophy';
  distance: number;
  point: THREE.Vector3;
}

// Module-level scratch vectors to avoid per-frame allocations inside 60 FPS loops
const _zeroVec = new THREE.Vector3(0, 0, 0);
const _downVec = new THREE.Vector3(0, -1, 0);
const _groundProbe = new THREE.Vector3();
const _groundHit = createGroundRaycastHit();
const _losOrigin = new THREE.Vector3();
const _losDir = new THREE.Vector3();
const _losHit = createGroundRaycastHit();
const _camFwd = new THREE.Vector3();
const _segDir = new THREE.Vector3();
const _toNpc = new THREE.Vector3();
const _hitPtScratch = new THREE.Vector3();
const _muzzleWorld = new THREE.Vector3();
const _bulletDir = new THREE.Vector3();
const _bulletNext = new THREE.Vector3();
const _bulletRayDir = new THREE.Vector3();
const _bulletToBird = new THREE.Vector3();
const _bulletClosest = new THREE.Vector3();
const _bulletHit = createGroundRaycastHit();
const _burstPos = new THREE.Vector3();
const _ejectImpulse = new THREE.Vector3();
const _steer2dOut = { x: 0, z: 0, steerX: 0, steerZ: 0, collided: false };

const CROWD_STYLES: readonly CrowdStyleSpec[] = [
  {
    coatHex: PALETTE.coatPeriwinkle,
    trouserHex: PALETTE.ironworkPlum,
    skinHex: PALETTE.skinPeach,
    hairHex: PALETTE.hairEspresso,
    scarfHex: PALETTE.awningCream,
  },
  {
    coatHex: PALETTE.coatMustard,
    trouserHex: PALETTE.woodWalnut,
    skinHex: PALETTE.skinWarmTan,
    hairHex: PALETTE.hairAuburn,
    scarfHex: PALETTE.awningCoral,
  },
  {
    coatHex: PALETTE.coatSage,
    trouserHex: PALETTE.denimSoft,
    skinHex: PALETTE.skinRosy,
    hairHex: PALETTE.hairHoney,
    scarfHex: PALETTE.porcelainWhite,
  },
  {
    coatHex: PALETTE.coatRose,
    trouserHex: PALETTE.coatSlate,
    skinHex: PALETTE.skinDeepUmber,
    hairHex: PALETTE.hairEspresso,
    scarfHex: PALETTE.awningGold,
  },
  {
    coatHex: PALETTE.coatSlate,
    trouserHex: PALETTE.denimSoft,
    skinHex: PALETTE.skinPeach,
    hairHex: PALETTE.hairSilver,
    scarfHex: PALETTE.awningMint,
  },
  {
    coatHex: PALETTE.awningMint,
    trouserHex: PALETTE.ironworkPlum,
    skinHex: PALETTE.skinWarmTan,
    hairHex: PALETTE.hairAuburn,
    scarfHex: PALETTE.awningCream,
  },
];

/**
 * Connected walkable pedestrian network spanning Streets/Boulevards, NE Botanical Park,
 * NW Cafe Promenade, SE Market Walk, and SW Canal Quays (avoiding buildings & basins).
 */
const WALK_GRAPH: readonly WalkNode[] = [
  // 0..7: Central Streets & Boulevards (N-S corridor x = ±16, E-W corridor z = ±16)
  { x: -16, z: 16, area: 'street', neighbors: [1, 2, 8, 16] },
  { x: 16, z: 16, area: 'street', neighbors: [0, 3, 18, 26] },
  { x: -16, z: -16, area: 'street', neighbors: [0, 3, 36, 28] },
  { x: 16, z: -16, area: 'street', neighbors: [1, 2, 5, 22] },
  { x: -16, z: -64, area: 'street', neighbors: [36, 37] },
  { x: 16, z: -64, area: 'street', neighbors: [3, 7, 23, 25] },
  { x: -16, z: -96, area: 'street', neighbors: [37, 7] },
  { x: 16, z: -96, area: 'street', neighbors: [5, 6, 24] },

  // 8..15: NW Cafe Promenade & Upper North Street
  { x: -20.5, z: 48, area: 'cafe', neighbors: [0, 9, 10, 12] },
  { x: -20.5, z: 89, area: 'cafe', neighbors: [8, 11, 14] },
  { x: -29.5, z: 38, area: 'cafe', neighbors: [8, 12] },
  { x: -33, z: 89, area: 'cafe', neighbors: [9, 12, 13] },
  { x: -29.5, z: 62, area: 'cafe', neighbors: [8, 10, 11] },
  { x: -64, z: 90, area: 'cafe', neighbors: [11, 15] },
  { x: -16, z: 106, area: 'street', neighbors: [9, 17, 38] },
  { x: -94, z: 90, area: 'cafe', neighbors: [13, 39] },

  // 16..21: Upper Avenue & NE Botanical Park West/North Paths
  { x: -46, z: 16, area: 'street', neighbors: [0, 29] },
  { x: 16, z: 106, area: 'street', neighbors: [14, 18, 20, 42] },
  { x: 16, z: 54, area: 'street', neighbors: [1, 17, 19] },
  { x: 24, z: 26, area: 'park', neighbors: [18, 20, 21, 26] },
  { x: 24, z: 84, area: 'park', neighbors: [17, 19, 32] },
  { x: 52, z: 24, area: 'park', neighbors: [19, 33] },

  // 22..25: SE Farmers' Market & Plaza
  { x: 30, z: -28, area: 'cafe', neighbors: [3, 23, 27] },
  { x: 42, z: -56, area: 'cafe', neighbors: [5, 22, 24, 25] },
  { x: 70, z: -80, area: 'cafe', neighbors: [7, 23, 25, 50] },
  { x: 42, z: -82, area: 'cafe', neighbors: [5, 23, 24] },

  // 26..31: E/W Boulevards & SW Canal Quays (strictly clear of sunken canal trench)
  { x: 52, z: 16, area: 'street', neighbors: [1, 19, 27] },
  { x: 86, z: 16, area: 'street', neighbors: [22, 26, 33, 44] },
  { x: -48, z: -16, area: 'street', neighbors: [2, 29] },
  { x: -88, z: 16, area: 'street', neighbors: [16, 28, 40] },
  { x: -56, z: -34, area: 'cafe', neighbors: [36, 34] },
  { x: -54, z: -74, area: 'cafe', neighbors: [37, 35] },

  // 32..37: NE Park Outer Loop, Canal Bridge Approaches & Quays
  { x: 78, z: 84, area: 'park', neighbors: [20, 33, 43] },
  { x: 82, z: 48, area: 'park', neighbors: [21, 27, 32] },
  { x: -86, z: -34, area: 'cafe', neighbors: [30] },
  { x: -84, z: -76, area: 'cafe', neighbors: [31, 46] },
  { x: -16, z: -34, area: 'street', neighbors: [2, 4, 30] },
  { x: -16, z: -74, area: 'street', neighbors: [4, 6, 31, 49] },

  // 38..53: Expanded Outer City Boulevards, Plazas & Parks (Nodes stay area='street' so couples remain near parks/cafes)
  { x: -16, z: 196, area: 'street', neighbors: [14, 39, 41, 42] },
  { x: -185, z: 160, area: 'street', neighbors: [15, 38, 40, 41] },
  { x: -185, z: 16, area: 'street', neighbors: [29, 39, 46] },
  { x: -228, z: 242, area: 'street', neighbors: [38, 39] },
  { x: 16, z: 196, area: 'street', neighbors: [17, 38, 43, 45] },
  { x: 185, z: 160, area: 'street', neighbors: [32, 42, 44, 45] },
  { x: 185, z: 16, area: 'street', neighbors: [27, 43, 52] },
  { x: 228, z: 242, area: 'street', neighbors: [42, 43] },
  { x: -185, z: -120, area: 'street', neighbors: [35, 40, 47, 48] },
  { x: -228, z: -242, area: 'street', neighbors: [46, 48, 49] },
  { x: -16, z: -196, area: 'street', neighbors: [46, 47, 49, 51] },
  { x: -16, z: -120, area: 'street', neighbors: [37, 47, 48] },
  { x: 185, z: -160, area: 'street', neighbors: [24, 51, 52, 53] },
  { x: 16, z: -196, area: 'street', neighbors: [48, 50, 53] },
  { x: 185, z: -16, area: 'street', neighbors: [44, 50] },
  { x: 228, z: -242, area: 'street', neighbors: [50, 51] },
];

// Dedicated Park & Cafe starting nodes for the 6 linked couples (slots 0..11)
const COUPLE_SPAWN_NODES: readonly number[] = [8, 19, 12, 20, 22, 33];
// Dedicated plaza, boulevard, market, and park-gate nodes for the 4 Trophy Cart NPCs (slots 12..15)
const TROPHY_CART_SPAWN_NODES: readonly number[] = [0, 1, 22, 18];

function buildStyleGeometries(spec: CrowdStyleSpec): CrowdStyleGeometries {
  // Torso + collar + head + hair/cap merged into one lightweight opaque mesh
  const torsoHeadParts: THREE.BufferGeometry[] = [
    transformGeo(rbox(1.56, 2.72, 0.96, 0.24, spec.coatHex, 1), {
      pos: [0, 1.38, 0],
    }),
    transformGeo(rcyl(0.46, 0.56, 0.34, spec.scarfHex, 10), {
      pos: [0, 2.74, 0.02],
    }),
    transformGeo(rcyl(0.24, 0.28, 0.36, spec.skinHex, 8), {
      pos: [0, 3.04, 0],
    }),
    transformGeo(smoothSphere(0.76, spec.skinHex, 12, 10, [0.95, 1.06, 0.98]), {
      pos: [0, 3.74, 0.02],
    }),
    transformGeo(smoothSphere(0.8, spec.hairHex, 12, 8, [1.02, 0.72, 1.04]), {
      pos: [0, 4.08, -0.08],
    }),
    // Expressive dark eyes on front face (+Z)
    transformGeo(rbox(0.12, 0.14, 0.08, 0.03, PALETTE.ironworkPlum, 1), {
      pos: [-0.24, 3.78, 0.71],
    }),
    transformGeo(rbox(0.12, 0.14, 0.08, 0.03, PALETTE.ironworkPlum, 1), {
      pos: [0.24, 3.78, 0.71],
    }),
  ];
  const torsoHeadGeo = mergeParts(torsoHeadParts);

  // Single downward arm geometry hanging from shoulder pivot (0, 0, 0) down to y = -2.35
  const armGeo = mergeParts([
    transformGeo(rcyl(0.24, 0.21, 1.92, spec.coatHex, 8), {
      pos: [0, -0.96, 0],
    }),
    transformGeo(smoothSphere(0.22, spec.skinHex, 8, 6), {
      pos: [0, -2.05, 0.02],
    }),
  ]);

  // Single downward leg + shoe geometry hanging from hip pivot (0, 0, 0) down to y = -4.55
  const legGeo = mergeParts([
    transformGeo(rcyl(0.32, 0.25, 4.15, spec.trouserHex, 8), {
      pos: [0, -2.08, 0],
    }),
    transformGeo(rbox(0.46, 0.36, 0.88, 0.12, PALETTE.woodWalnut, 1), {
      pos: [0, -4.34, 0.18],
    }),
  ]);

  return { torsoHeadGeo, armGeo, legGeo };
}

function buildEnemyPistolGeometry(): THREE.BufferGeometry {
  return mergeParts([
    transformGeo(rbox(0.24, 0.28, 1.15, 0.04, 0x262b34, 1), {
      pos: [0, 0.08, 0.45],
    }),
    transformGeo(rbox(0.2, 0.62, 0.28, 0.04, PALETTE.woodWalnut, 1), {
      rot: [0.26, 0, 0],
      pos: [0, -0.28, 0.05],
    }),
  ]);
}

function buildHeartIconGeometry(): THREE.BufferGeometry {
  return mergeParts([
    transformGeo(smoothSphere(0.28, PALETTE.berryRuby, 10, 8, [1.0, 1.0, 0.58]), {
      pos: [-0.18, 0.16, 0],
    }),
    transformGeo(smoothSphere(0.28, PALETTE.berryRuby, 10, 8, [1.0, 1.0, 0.58]), {
      pos: [0.18, 0.16, 0],
    }),
    transformGeo(rcyl(0.34, 0.03, 0.46, PALETTE.berryRuby, 10), {
      pos: [0, -0.08, 0],
      scale: [1.05, 1.0, 0.55],
    }),
    transformGeo(smoothSphere(0.11, PALETTE.goldGlow, 6, 5), {
      pos: [0.46, 0.34, 0],
    }),
    transformGeo(smoothSphere(0.09, PALETTE.goldGlow, 6, 5), {
      pos: [-0.44, 0.28, 0],
    }),
  ]);
}

function buildTearPanicIconGeometry(): THREE.BufferGeometry {
  return mergeParts([
    // Left bright sky-blue teardrop
    transformGeo(smoothSphere(0.22, 0x52c7ff, 9, 7, [0.95, 1.15, 0.8]), {
      pos: [-0.34, -0.08, 0],
    }),
    transformGeo(rcyl(0.03, 0.19, 0.34, 0x52c7ff, 9), {
      pos: [-0.34, 0.14, 0],
    }),
    // Right bright sky-blue teardrop
    transformGeo(smoothSphere(0.22, 0x52c7ff, 9, 7, [0.95, 1.15, 0.8]), {
      pos: [0.34, -0.08, 0],
    }),
    transformGeo(rcyl(0.03, 0.19, 0.34, 0x52c7ff, 9), {
      pos: [0.34, 0.14, 0],
    }),
    // Center coral-red panic exclamation mark (!)
    transformGeo(rbox(0.18, 0.56, 0.18, 0.05, 0xff493d, 1), {
      pos: [0, 0.36, 0],
    }),
    transformGeo(smoothSphere(0.12, 0xff493d, 8, 6), {
      pos: [0, -0.08, 0],
    }),
  ]);
}

function buildCartGeometry(): THREE.BufferGeometry {
  const wheelHex = 0x282d38;
  const trimHex = PALETTE.brassWarm;
  return mergeParts([
    // Cart bed deck & raised side rails
    transformGeo(rbox(2.15, 0.34, 2.75, 0.08, PALETTE.woodOak, 1), {
      pos: [0, 1.82, 0],
    }),
    transformGeo(rbox(2.26, 0.24, 2.86, 0.06, trimHex, 1), {
      pos: [0, 2.04, 0],
    }),
    // Crimson velvet display cushion
    transformGeo(rbox(1.25, 0.26, 1.25, 0.08, PALETTE.berryRuby, 1), {
      pos: [0, 2.2, 0.15],
    }),
    // Lower axle & support legs
    transformGeo(rcyl(0.1, 0.1, 2.25, wheelHex, 8), {
      pos: [0, 0.62, -0.82],
      rot: [0, 0, Math.PI * 0.5],
    }),
    transformGeo(rcyl(0.1, 0.1, 2.25, wheelHex, 8), {
      pos: [0, 0.62, 0.88],
      rot: [0, 0, Math.PI * 0.5],
    }),
    // 4 wheels resting cleanly on y = 0
    transformGeo(rcyl(0.62, 0.62, 0.22, wheelHex, 12), {
      pos: [-1.14, 0.62, -0.82],
      rot: [0, 0, Math.PI * 0.5],
    }),
    transformGeo(rcyl(0.62, 0.62, 0.22, wheelHex, 12), {
      pos: [1.14, 0.62, -0.82],
      rot: [0, 0, Math.PI * 0.5],
    }),
    transformGeo(rcyl(0.62, 0.62, 0.22, wheelHex, 12), {
      pos: [-1.14, 0.62, 0.88],
      rot: [0, 0, Math.PI * 0.5],
    }),
    transformGeo(rcyl(0.62, 0.62, 0.22, wheelHex, 12), {
      pos: [1.14, 0.62, 0.88],
      rot: [0, 0, Math.PI * 0.5],
    }),
    // Push handles extending back toward NPC hands
    transformGeo(rcyl(0.09, 0.09, 1.55, PALETTE.woodWalnut, 8), {
      pos: [-0.88, 2.95, -1.55],
      rot: [-0.88, 0, 0],
    }),
    transformGeo(rcyl(0.09, 0.09, 1.55, PALETTE.woodWalnut, 8), {
      pos: [0.88, 2.95, -1.55],
      rot: [-0.88, 0, 0],
    }),
    transformGeo(rcyl(0.09, 0.09, 1.9, trimHex, 8), {
      pos: [0, 3.5, -2.1],
      rot: [0, 0, Math.PI * 0.5],
    }),
  ]);
}

function buildGoldenTrophyGeometry(): THREE.BufferGeometry {
  const goldHex = 0xffd84a;
  const plinthHex = 0x5c3622;
  return mergeParts([
    // Dark wood prize plinth
    transformGeo(rbox(0.84, 0.42, 0.84, 0.06, plinthHex, 1), {
      pos: [0, 0.21, 0],
    }),
    // Golden base collar & stem
    transformGeo(rcyl(0.24, 0.38, 0.34, goldHex, 12), {
      pos: [0, 0.58, 0],
    }),
    transformGeo(rcyl(0.14, 0.18, 0.48, goldHex, 10), {
      pos: [0, 0.96, 0],
    }),
    // Wide gleaming chalice cup
    transformGeo(rcyl(0.72, 0.24, 0.92, goldHex, 14), {
      pos: [0, 1.58, 0],
    }),
    // Upper lip & left/right trophy handles
    transformGeo(rcyl(0.78, 0.72, 0.14, 0xfff0a3, 14), {
      pos: [0, 2.02, 0],
    }),
    transformGeo(rcyl(0.1, 0.1, 0.68, goldHex, 8), {
      pos: [-0.74, 1.62, 0],
      rot: [0, 0, 0.35],
    }),
    transformGeo(rcyl(0.1, 0.1, 0.68, goldHex, 8), {
      pos: [0.74, 1.62, 0],
      rot: [0, 0, -0.35],
    }),
    // Glowing jewel star finial
    transformGeo(smoothSphere(0.24, 0xfff6b8, 8, 6), {
      pos: [0, 2.28, 0],
    }),
  ]);
}

function createRagdollFadeMaterial(): THREE.MeshLambertNodeMaterial {
  const mat = new THREE.MeshLambertNodeMaterial();
  mat.vertexColors = true;
  mat.transparent = true;
  mat.opacity = 1.0;
  mat.depthWrite = false;
  return mat;
}

/**
 * Performance-optimized Object-Pooled 45-NPC Crowd & Rebellion Escalation Manager:
 * - 45 lightweight articulated 3D pedestrians walking across park, street, and cafe zones
 * - Object-pooled ragdoll knockout (3-second collapse + opacity fade-out + off-screen recycle),
 *   strictly capped at 15 simultaneous ragdolls to preserve 60 FPS
 * - Birdy Health (100 HP), Kills counter, panic scream/flee below 5 kills,
 *   10% armed rebellion at >= 5 kills, and MAJOR REBELLION (40% hostile) at >= 20 kills
 */
export class CrowdRebellionManager {
  private readonly group = new THREE.Group();
  private readonly sharedOpaqueMat: THREE.NodeMaterial;
  private readonly pistolMat: THREE.NodeMaterial;
  private readonly shadowMat: THREE.MeshBasicNodeMaterial;
  private readonly muzzleMat: THREE.MeshBasicNodeMaterial;
  private readonly enemyBulletMat: THREE.MeshBasicNodeMaterial;
  private readonly trophyHaloMat: THREE.MeshBasicNodeMaterial;
  private readonly rageAuraMat: THREE.MeshBasicNodeMaterial;
  private readonly respectOrbMat: THREE.MeshBasicNodeMaterial;
  private readonly ragdollMatPool: THREE.MeshLambertNodeMaterial[] = [];

  private readonly styleGeos: CrowdStyleGeometries[] = [];
  private readonly pistolGeo: THREE.BufferGeometry;
  private readonly heartGeo: THREE.BufferGeometry;
  private readonly tearGeo: THREE.BufferGeometry;
  private readonly cartGeo: THREE.BufferGeometry;
  private readonly trophyGeo: THREE.BufferGeometry;
  private readonly trophyHaloGeo: THREE.BufferGeometry;
  private readonly rageAuraBodyGeo: THREE.BufferGeometry;
  private readonly rageAuraRingGeo: THREE.BufferGeometry;
  private readonly respectOrbGeo: THREE.BufferGeometry;
  private readonly muzzleGeo: THREE.BufferGeometry;
  private readonly shadowGeo: THREE.BufferGeometry;
  private readonly enemyBulletGeo: THREE.BufferGeometry;
  private readonly prewarmGeos: THREE.BufferGeometry[] = [];
  private readonly prewarmMeshes: THREE.Mesh[] = [];

  private readonly slots: CrowdHumanSlot[] = [];
  private readonly activeRagdollQueue: number[] = [];
  private readonly freeRagdollMatIndices: number[] = [];
  private readonly enemyBullets: EnemyBulletSlot[] = [];
  private readonly respectOrbs: RespectOrbSlot[] = [];
  private enemyBulletCursor = 0;
  private respectOrbCursor = 0;

  private kills = 0;
  private respectXp = 0;
  private birdHp = BIRD_MAX_HEALTH;
  private birdHpExact = BIRD_MAX_HEALTH;
  private birdInvulnTimer = 0;
  private birdDownedTimer = 0;
  private mode: RebellionMode = 'peaceful';
  private screamCooldown = 0;
  private globalEnemyFireCooldown = 0;
  private hitSfxCooldown = 0;
  private perchCooldownTimer = 0;
  private pendingEjectImpulse = false;
  private admiredSlotIndex = -1;
  private lastIntimidatePromptAvailable = false;
  private sparkleTimer = 0;
  private respectMultiplierFn: ((pos: THREE.Vector3) => number) | null = null;
  private disposed = false;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly perches: PerchSystem,
    private readonly physics: PhysicsWorld,
    private readonly audio: AcousticSoundtrack,
    private readonly fx: WorldFX,
    private readonly events: EventBus<GameEventMap>
  ) {
    this.group.name = 'crowd_rebellion_pool';
    this.scene.add(this.group);

    this.sharedOpaqueMat = createPastelMaterial({ vertexColors: true, rimStrength: 0.08 });
    this.pistolMat = createPastelMaterial({ color: 0x2a303b, vertexColors: false, rimStrength: 0.1 });
    this.shadowMat = createUnlitPastelFXMaterial(0x1b202b, 0.24, true);
    this.muzzleMat = createUnlitPastelFXMaterial(0xffb845, 0.92, true);
    this.enemyBulletMat = createUnlitPastelFXMaterial(0xff4f38, 0.96, false);
    this.trophyHaloMat = createUnlitPastelFXMaterial(0xffe15a, 0.32, true);
    this.rageAuraMat = createUnlitPastelFXMaterial(0xff231c, 0.42, true);
    this.respectOrbMat = createUnlitPastelFXMaterial(0xffe252, 0.96, false);

    for (let i = 0; i < CROWD_STYLES.length; i++) {
      this.styleGeos.push(buildStyleGeometries(CROWD_STYLES[i]));
    }
    this.pistolGeo = buildEnemyPistolGeometry();
    this.heartGeo = buildHeartIconGeometry();
    this.tearGeo = buildTearPanicIconGeometry();
    this.cartGeo = buildCartGeometry();
    this.trophyGeo = buildGoldenTrophyGeometry();
    this.trophyHaloGeo = smoothSphere(1.52, 0xffe878, 10, 8);
    this.rageAuraBodyGeo = rcyl(2.15, 2.65, 9.4, 0xff261e, 14);
    this.rageAuraRingGeo = rcyl(3.15, 3.15, 0.18, 0xff3b29, 16);
    this.respectOrbGeo = smoothSphere(0.42, 0xffe252, 8, 6);
    this.muzzleGeo = smoothSphere(0.32, 0xffc65c, 6, 5, [1.0, 1.0, 2.2]);
    this.shadowGeo = rcyl(1.15, 1.15, 0.04, 0x1b202b, 12);
    this.enemyBulletGeo = smoothSphere(0.18, 0xff5a3d, 6, 5, [1.0, 1.0, 2.6]);

    // Pre-create & attach 15 ragdoll fade materials to tiny hidden pre-warm meshes so
    // GameApp's startup WebGPU pipeline pre-warm compiles them with zero runtime stutter.
    const prewarmTri = new THREE.BufferGeometry();
    prewarmTri.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([0, 0, 0, 0.01, 0, 0, 0, 0.01, 0], 3)
    );
    prewarmTri.setAttribute(
      'normal',
      new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0], 3)
    );
    prewarmTri.setAttribute(
      'color',
      new THREE.Float32BufferAttribute([1, 1, 1, 1, 1, 1, 1, 1, 1], 3)
    );
    this.prewarmGeos.push(prewarmTri);

    for (let i = 0; i < MAX_ACTIVE_RAGDOLLS; i++) {
      const mat = createRagdollFadeMaterial();
      this.ragdollMatPool.push(mat);
      this.freeRagdollMatIndices.push(i);
      const pw = new THREE.Mesh(prewarmTri, mat);
      pw.position.set(0, -35, 0);
      pw.visible = false;
      pw.castShadow = false;
      pw.receiveShadow = false;
      this.group.add(pw);
      this.prewarmMeshes.push(pw);
    }

    // Build 45 pooled pedestrian NPCs distributed cleanly across park, streets & cafe areas
    for (let i = 0; i < CROWD_POOL_SIZE; i++) {
      const slot = this.createHumanSlot(i);
      this.slots.push(slot);
      this.group.add(slot.root);
    }

    // Pre-allocate pooled enemy projectiles
    for (let i = 0; i < ENEMY_BULLET_POOL_SIZE; i++) {
      const mesh = new THREE.Mesh(this.enemyBulletGeo, this.enemyBulletMat);
      mesh.visible = false;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      this.group.add(mesh);
      this.enemyBullets.push({
        active: false,
        age: 0,
        pos: new THREE.Vector3(),
        prevPos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        mesh,
      });
    }

    // Pre-allocate pooled Respect/XP drop orbs for intimidation rewards
    for (let i = 0; i < RESPECT_ORB_POOL_SIZE; i++) {
      const mesh = new THREE.Mesh(this.respectOrbGeo, this.respectOrbMat);
      mesh.visible = false;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      this.group.add(mesh);
      this.respectOrbs.push({
        active: false,
        age: 0,
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        mesh,
      });
    }
  }

  public getKills(): number {
    return this.kills;
  }

  public getRespectXp(): number {
    return this.respectXp;
  }

  public getBirdHp(): number {
    return this.birdHp;
  }

  public getMode(): RebellionMode {
    return this.mode;
  }

  public setRespectMultiplierFn(fn: (pos: THREE.Vector3) => number): void {
    this.respectMultiplierFn = fn;
  }

  public getHostileChance(): number {
    if (this.kills >= MAJOR_REBELLION_KILL_THRESHOLD) return 0.4;
    if (this.kills >= ESCALATION_KILL_THRESHOLD) return 0.1;
    return 0.0;
  }

  public getActiveRagdollCount(): number {
    return this.activeRagdollQueue.length;
  }

  public getPerchCooldownRemaining(): number {
    return this.perchCooldownTimer;
  }

  public isAdmired(): boolean {
    return this.admiredSlotIndex >= 0;
  }

  public getCoupleCount(): number {
    return COUPLE_PAIR_COUNT;
  }

  public getCryingCount(): number {
    let count = 0;
    for (let i = 0; i < COUPLE_PAIR_COUNT * 2; i++) {
      if (this.slots[i]?.state === 'crying') count++;
    }
    return count;
  }

  public getTrophyCartCount(): number {
    return TROPHY_CART_COUNT;
  }

  public getExtremeRageCount(): number {
    let count = 0;
    for (let i = TROPHY_CART_START_INDEX; i < TROPHY_CART_END_INDEX; i++) {
      if (this.slots[i]?.extremeRage && this.slots[i]?.state !== 'ragdoll') count++;
    }
    return count;
  }

  public sampleEjectGust(): THREE.Vector3 | null {
    if (!this.pendingEjectImpulse) return null;
    this.pendingEjectImpulse = false;
    return _ejectImpulse;
  }

  private createHumanSlot(index: number): CrowdHumanSlot {
    const style = this.styleGeos[index % this.styleGeos.length];
    const scale = 0.88 + ((index * 17) % 11) * 0.016;
    const baseHipY = 4.55;

    const root = new THREE.Group();
    root.scale.setScalar(scale);

    const shadowDisc = new THREE.Mesh(this.shadowGeo, this.shadowMat);
    shadowDisc.position.set(0, 0.04, 0);
    shadowDisc.castShadow = false;
    shadowDisc.receiveShadow = false;
    root.add(shadowDisc);

    const bodyPivot = new THREE.Group();
    bodyPivot.position.set(0, baseHipY, 0);
    root.add(bodyPivot);

    const torsoHeadMesh = new THREE.Mesh(style.torsoHeadGeo, this.sharedOpaqueMat);
    torsoHeadMesh.castShadow = false;
    torsoHeadMesh.receiveShadow = true;
    bodyPivot.add(torsoHeadMesh);

    const armLPivot = new THREE.Group();
    armLPivot.position.set(-1.02, 2.66, 0);
    const armLMesh = new THREE.Mesh(style.armGeo, this.sharedOpaqueMat);
    armLMesh.castShadow = false;
    armLMesh.receiveShadow = true;
    armLPivot.add(armLMesh);
    bodyPivot.add(armLPivot);

    const armRPivot = new THREE.Group();
    armRPivot.position.set(1.02, 2.66, 0);
    const armRMesh = new THREE.Mesh(style.armGeo, this.sharedOpaqueMat);
    armRMesh.castShadow = false;
    armRMesh.receiveShadow = true;
    armRPivot.add(armRMesh);

    // Concealed pistol attached to right hand — only visible when hostile
    const gunGroup = new THREE.Group();
    gunGroup.position.set(0, -2.02, 0.18);
    gunGroup.rotation.x = Math.PI * 0.5;
    gunGroup.visible = false;
    const pistolMesh = new THREE.Mesh(this.pistolGeo, this.pistolMat);
    pistolMesh.castShadow = false;
    pistolMesh.receiveShadow = true;
    gunGroup.add(pistolMesh);

    const muzzleFlash = new THREE.Mesh(this.muzzleGeo, this.muzzleMat);
    muzzleFlash.position.set(0, 0.12, 1.12);
    muzzleFlash.visible = false;
    gunGroup.add(muzzleFlash);
    armRPivot.add(gunGroup);
    bodyPivot.add(armRPivot);

    const legLPivot = new THREE.Group();
    legLPivot.position.set(-0.4, baseHipY, 0);
    const legLMesh = new THREE.Mesh(style.legGeo, this.sharedOpaqueMat);
    legLMesh.castShadow = false;
    legLMesh.receiveShadow = true;
    legLPivot.add(legLMesh);
    root.add(legLPivot);

    const legRPivot = new THREE.Group();
    legRPivot.position.set(0.4, baseHipY, 0);
    const legRMesh = new THREE.Mesh(style.legGeo, this.sharedOpaqueMat);
    legRMesh.castShadow = false;
    legRMesh.receiveShadow = true;
    legRPivot.add(legRMesh);
    root.add(legRPivot);

    // Floating heart & sparkle icon above NPC's head when bird is perched & admired
    const heartIconGroup = new THREE.Group();
    heartIconGroup.position.set(0, 5.25, 0);
    heartIconGroup.visible = false;
    const heartMesh = new THREE.Mesh(this.heartGeo, this.sharedOpaqueMat);
    heartMesh.castShadow = false;
    heartMesh.receiveShadow = false;
    heartIconGroup.add(heartMesh);
    bodyPivot.add(heartIconGroup);

    // Floating tear/panic icon above surviving partner's head when their partner is eliminated
    const tearIconGroup = new THREE.Group();
    tearIconGroup.position.set(0, 5.35, 0);
    tearIconGroup.visible = false;
    const tearMesh = new THREE.Mesh(this.tearGeo, this.sharedOpaqueMat);
    tearMesh.castShadow = false;
    tearMesh.receiveShadow = false;
    tearIconGroup.add(tearMesh);
    bodyPivot.add(tearIconGroup);

    const isCoupleSlot = index < COUPLE_PAIR_COUNT * 2;
    const isTrophyCartSlot =
      index >= TROPHY_CART_START_INDEX && index < TROPHY_CART_END_INDEX;
    const coupleId = isCoupleSlot ? Math.floor(index / 2) : -1;
    const partnerIndex = isCoupleSlot ? (index % 2 === 0 ? index + 1 : index - 1) : -1;
    const isCoupleLead = isCoupleSlot && index % 2 === 0;

    let cartGroup: THREE.Group | null = null;
    let trophyGroup: THREE.Group | null = null;
    let trophyHaloMesh: THREE.Mesh | null = null;
    let rageAuraGroup: THREE.Group | null = null;

    if (isTrophyCartSlot) {
      cartGroup = new THREE.Group();
      cartGroup.position.set(0, 0, 2.75);
      const cartMesh = new THREE.Mesh(this.cartGeo, this.sharedOpaqueMat);
      cartMesh.castShadow = false;
      cartMesh.receiveShadow = true;
      cartGroup.add(cartMesh);

      trophyGroup = new THREE.Group();
      trophyGroup.position.set(0, 2.34, 0.15);
      const trophyMesh = new THREE.Mesh(this.trophyGeo, this.sharedOpaqueMat);
      trophyMesh.castShadow = false;
      trophyMesh.receiveShadow = true;
      trophyGroup.add(trophyMesh);

      trophyHaloMesh = new THREE.Mesh(this.trophyHaloGeo, this.trophyHaloMat);
      trophyHaloMesh.position.set(0, 1.38, 0);
      trophyHaloMesh.castShadow = false;
      trophyHaloMesh.receiveShadow = false;
      trophyGroup.add(trophyHaloMesh);

      cartGroup.add(trophyGroup);
      root.add(cartGroup);

      rageAuraGroup = new THREE.Group();
      rageAuraGroup.visible = false;
      const rageBodyMesh = new THREE.Mesh(this.rageAuraBodyGeo, this.rageAuraMat);
      rageBodyMesh.position.set(0, 4.85, 0);
      rageBodyMesh.castShadow = false;
      rageBodyMesh.receiveShadow = false;
      const rageRingMesh = new THREE.Mesh(this.rageAuraRingGeo, this.rageAuraMat);
      rageRingMesh.position.set(0, 0.14, 0);
      rageRingMesh.castShadow = false;
      rageRingMesh.receiveShadow = false;
      rageAuraGroup.add(rageBodyMesh);
      rageAuraGroup.add(rageRingMesh);
      root.add(rageAuraGroup);
    }

    // Pick initial node: couples spawn together at Park/Cafe nodes; trophy carts at prominent plazas; others across WALK_GRAPH
    const nodeIdx = isCoupleSlot
      ? COUPLE_SPAWN_NODES[coupleId % COUPLE_SPAWN_NODES.length]
      : isTrophyCartSlot
        ? TROPHY_CART_SPAWN_NODES[(index - TROPHY_CART_START_INDEX) % TROPHY_CART_SPAWN_NODES.length]
        : (index * 7) % WALK_GRAPH.length;
    const node = WALK_GRAPH[nodeIdx];
    const nextIdx = isCoupleSlot
      ? this.pickCoupleNeighbor(nodeIdx, -1, coupleId)
      : node.neighbors.length > 0
        ? node.neighbors[index % node.neighbors.length]
        : (nodeIdx + 1) % WALK_GRAPH.length;
    const targetNode = WALK_GRAPH[nextIdx];

    const yaw = Math.atan2(targetNode.x - node.x, targetNode.z - node.z);
    let spawnX: number;
    let spawnZ: number;
    if (isCoupleSlot) {
      // Spawn partners cleanly side-by-side shoulder-to-shoulder
      const sideSign = isCoupleLead ? -0.5 : 0.5;
      const sideOffset = sideSign * COUPLE_SIDE_SEPARATION;
      spawnX = node.x + Math.cos(yaw) * sideOffset;
      spawnZ = node.z - Math.sin(yaw) * sideOffset;
    } else if (isTrophyCartSlot) {
      spawnX = node.x;
      spawnZ = node.z;
    } else {
      // Small lateral sidewalk spread so multiple solo walkers look natural
      const jitterAngle = (index * 2.39996) % (Math.PI * 2);
      const jitterR = 1.4 + (index % 3) * 1.15;
      spawnX = node.x + Math.cos(jitterAngle) * jitterR;
      spawnZ = node.z + Math.sin(jitterAngle) * jitterR;
    }
    const groundY = this.sampleWalkGroundY(spawnX, spawnZ);

    root.position.set(spawnX, groundY, spawnZ);
    root.rotation.y = yaw;

    const slot: CrowdHumanSlot = {
      index,
      root,
      bodyPivot,
      torsoHeadMesh,
      armLPivot,
      armLMesh,
      armRPivot,
      armRMesh,
      legLPivot,
      legLMesh,
      legRPivot,
      legRMesh,
      gunGroup,
      muzzleFlash,
      heartIconGroup,
      tearIconGroup,
      cartGroup,
      trophyGroup,
      trophyHaloMesh,
      rageAuraGroup,
      shadowDisc,
      scale,
      baseHipY,
      voicePitch: 0.8 + ((index * 19) % 15) * 0.032,
      state: 'walking',
      rolledTier: 0,
      hasTrophyCart: isTrophyCartSlot,
      trophyIntact: isTrophyCartSlot,
      extremeRage: false,
      partnerIndex,
      coupleId,
      couplePauseTimer: isCoupleSlot && coupleId % 2 === 1 ? 2.4 : 0,
      coupleWalkTimer: 7.5 + (coupleId >= 0 ? coupleId * 1.4 : 0),
      yaw,
      walkSpeed: isTrophyCartSlot
        ? 3.15 + ((index - TROPHY_CART_START_INDEX) % 2) * 0.25
        : isCoupleSlot
          ? 3.55 + (coupleId % 3) * 0.2
          : 4.1 + ((index * 11) % 7) * 0.32,
      gaitPhase: isCoupleSlot ? (isCoupleLead ? 0 : 0.35) : (index * 1.17) % (Math.PI * 2),
      groundY,
      currentNodeIdx: nodeIdx,
      targetNodeIdx: nextIdx,
      fleeDirX: 0,
      fleeDirZ: 1,
      fleeTimer: 0,
      cryTimer: 0,
      intimidateCooldown: 0,
      fireCooldown: 0.7 + ((index * 13) % 10) * 0.18,
      muzzleFlashTimer: 0,
      steerStuckFrames: 0,
      ragdollTimer: 0,
      ragdollPos: new THREE.Vector3(spawnX, groundY, spawnZ),
      ragdollVel: new THREE.Vector3(),
      ragdollPitch: 0,
      ragdollRoll: 0,
      ragdollPitchVel: 0,
      ragdollRollVel: 0,
      ragdollYawVel: 0,
      ragdollMatIdx: -1,
    };

    // Register left & right shoulder dynamic perches for peaceful shoulder-perching & admiring
    for (const side of [-1, 1] as const) {
      const sideKey = side < 0 ? 'l' : 'r';
      this.perches.addDynamicSegment({
        id: `crowd_shoulder_${sideKey}_${index}`,
        getApproxCenter: (out) => {
          if (this.perchCooldownTimer > 0 || slot.state !== 'walking') {
            out.set(99999, -9999, 99999);
          } else {
            out.copy(slot.root.position);
          }
        },
        approxHalfSpan: 2.2,
        getEndpoints: (outA, outB) => {
          if (this.perchCooldownTimer > 0 || slot.state !== 'walking') {
            outA.set(99999, -9999, 99999);
            outB.set(99999.1, -9999, 99999);
            return;
          }
          const cosY = Math.cos(slot.yaw);
          const sinY = Math.sin(slot.yaw);
          const shLocalX = side * 0.82 * slot.scale;
          const shY = slot.root.position.y + (slot.baseHipY + 2.74) * slot.scale;
          const cx = slot.root.position.x + cosY * shLocalX;
          const cz = slot.root.position.z - sinY * shLocalX;
          const halfSpan = 0.18 * slot.scale;
          outA.set(cx - cosY * halfSpan, shY, cz + sinY * halfSpan);
          outB.set(cx + cosY * halfSpan, shY, cz - sinY * halfSpan);
        },
        radius: 0.05,
        surface: 'fabric',
        onLand: () => {
          if (this.perchCooldownTimer <= 0 && slot.state === 'walking') {
            _burstPos.set(
              slot.root.position.x,
              slot.root.position.y + 8.6 * slot.scale,
              slot.root.position.z
            );
            this.audio.playHumanPetCoo(_burstPos, slot.voicePitch);
            this.fx.spawnBurst(_burstPos, 6, true, 2.4);
          }
        },
      });
    }

    return slot;
  }

  private pickCoupleNeighbor(nodeIdx: number, prevIdx: number, seed: number): number {
    const node = WALK_GRAPH[nodeIdx];
    const neighbors = node.neighbors;
    if (neighbors.length === 0) return (nodeIdx + 1) % WALK_GRAPH.length;

    const preferred: number[] = [];
    const fallback: number[] = [];
    for (let i = 0; i < neighbors.length; i++) {
      const nb = neighbors[i];
      if (nb === prevIdx) continue;
      const area = WALK_GRAPH[nb].area;
      if (area === 'park' || area === 'cafe') {
        preferred.push(nb);
      } else {
        fallback.push(nb);
      }
    }
    if (preferred.length > 0) {
      return preferred[Math.abs(seed) % preferred.length];
    }
    if (fallback.length > 0) {
      return fallback[Math.abs(seed) % fallback.length];
    }
    return neighbors[Math.abs(seed) % neighbors.length];
  }

  private sampleWalkGroundY(x: number, z: number): number {
    _groundProbe.set(x, 8.5, z);
    const hit = this.physics.raycastGround(
      _groundProbe,
      _downVec,
      14.0,
      undefined,
      _groundHit,
      COLLISION_GROUP_STATIC
    );
    if (hit.hit && hit.normal.y > 0.65 && hit.point.y >= -0.25 && hit.point.y <= 1.5) {
      return hit.point.y;
    }
    return 0.3;
  }

  private setSlotMaterial(slot: CrowdHumanSlot, mat: THREE.Material): void {
    slot.torsoHeadMesh.material = mat;
    slot.armLMesh.material = mat;
    slot.armRMesh.material = mat;
    slot.legLMesh.material = mat;
    slot.legRMesh.material = mat;
  }

  private isInsideRestrictedArea(x: number, z: number): boolean {
    // Keep out of NE Park central fountain basin
    const fdx = x - 48;
    const fdz = z - 48;
    if (fdx * fdx + fdz * fdz < 17.2 * 17.2) return true;
    // Keep out of SW sunken canal basin water
    if (x < -15.5 && z > -69.0 && z < -39.5) return true;
    // Check dynamic physics liquid basins
    if (this.physics.getBasinAtXZ(x, z, 0.4)) return true;
    return false;
  }

  /**
   * Non-mutating bullet capsule intersection scan across all upright pooled crowd NPCs.
   * Allows GameApp to resolve closest hit cleanly before triggering knockout/escalation.
   */
  public findBulletHit(
    prevPos: THREE.Vector3,
    nextPos: THREE.Vector3
  ): CrowdBulletHitCandidate | null {
    _segDir.subVectors(nextPos, prevPos);
    const segLen = _segDir.length();
    if (segLen < 1e-5) return null;
    _segDir.divideScalar(segLen);

    let bestDist = segLen + 0.15;
    let bestIndex = -1;
    let bestHitKind: 'human' | 'trophy' = 'human';

    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i];
      if (slot.state === 'ragdoll') continue;

      const rx = slot.root.position.x;
      const ry = slot.root.position.y;
      const rz = slot.root.position.z;

      // Check intact glowing Golden Trophy sphere mounted on the cart ahead of the NPC
      if (slot.hasTrophyCart && slot.trophyIntact) {
        const tx = rx + Math.sin(slot.yaw) * 2.9 * slot.scale;
        const ty = ry + 3.7 * slot.scale;
        const tz = rz + Math.cos(slot.yaw) * 2.9 * slot.scale;
        const tRadius = 1.65 * slot.scale;
        _toNpc.set(tx - prevPos.x, ty - prevPos.y, tz - prevPos.z);
        const tProj = Math.max(0, Math.min(segLen, _toNpc.dot(_segDir)));
        const cx = prevPos.x + _segDir.x * tProj;
        const cy = prevPos.y + _segDir.y * tProj;
        const cz = prevPos.z + _segDir.z * tProj;
        const dSq = (cx - tx) * (cx - tx) + (cy - ty) * (cy - ty) + (cz - tz) * (cz - tz);
        if (dSq <= tRadius * tRadius && tProj < bestDist) {
          bestDist = tProj;
          bestIndex = i;
          bestHitKind = 'trophy';
          _hitPtScratch.set(cx, cy, cz);
        }
      }

      const height = 9.4 * slot.scale;
      const radius = 1.55 * slot.scale;

      // Fast broadphase vertical rejection
      const minY = Math.min(prevPos.y, nextPos.y);
      const maxY = Math.max(prevPos.y, nextPos.y);
      if (maxY < ry - 0.3 || minY > ry + height + 0.4) continue;

      // Closest point on 3D swept segment to pedestrian vertical spine (clamped [ry+0.6, ry+height-0.4])
      _toNpc.set(rx - prevPos.x, ry + height * 0.55 - prevPos.y, rz - prevPos.z);
      const proj = Math.max(0, Math.min(segLen, _toNpc.dot(_segDir)));
      const cx = prevPos.x + _segDir.x * proj;
      const cy = prevPos.y + _segDir.y * proj;
      const cz = prevPos.z + _segDir.z * proj;

      if (cy < ry - 0.25 || cy > ry + height + 0.35) continue;

      const dx = cx - rx;
      const dz = cz - rz;
      if (dx * dx + dz * dz <= radius * radius && proj < bestDist) {
        bestDist = proj;
        bestIndex = i;
        bestHitKind = 'human';
        _hitPtScratch.set(cx, cy, cz);
      }
    }

    if (bestIndex < 0) return null;
    return {
      slotIndex: bestIndex,
      hitKind: bestHitKind,
      distance: bestDist,
      point: _hitPtScratch.clone(),
    };
  }

  /**
   * Executes bullet hit on a matched pooled NPC:
   * triggers 3s ragdoll knockout (respecting strict 15-ragdoll cap), increments Kills,
   * checks rebellion thresholds (5+ -> 10%, 20+ -> MAJOR REBELLION 40%), and alerts crowd.
   */
  public applyBulletHit(
    cand: CrowdBulletHitCandidate,
    prevPos: THREE.Vector3,
    nextPos: THREE.Vector3,
    birdPos: THREE.Vector3
  ): void {
    const slot = this.slots[cand.slotIndex];
    if (!slot || slot.state === 'ragdoll') return;

    // Shooting & shattering a prized Golden Trophy triggers Extreme Rage (red aura) + local rebellion + 70% accuracy
    if (cand.hitKind === 'trophy' && slot.hasTrophyCart && slot.trophyIntact) {
      this.shatterGoldenTrophy(slot, cand.point, birdPos);
      return;
    }

    _segDir.subVectors(nextPos, prevPos);
    if (_segDir.lengthSq() > 1e-6) {
      _segDir.normalize();
    } else {
      _segDir.set(0, 0, 1);
    }

    // Increment kill counter & check rebellion escalation
    this.kills += 1;
    const prevMode = this.mode;
    const nextMode: RebellionMode =
      this.kills >= MAJOR_REBELLION_KILL_THRESHOLD
        ? 'major'
        : this.kills >= ESCALATION_KILL_THRESHOLD
          ? 'skirmish'
          : 'peaceful';
    this.mode = nextMode;

    // Enter ragdoll (enforcing hard 15 simultaneous ragdoll cap)
    this.enterRagdoll(slot, _segDir, birdPos);

    this.fx.spawnBurst(cand.point, 9, false, 4.2);
    this.audio.playHumanGrunt(cand.point, slot.voicePitch, 'oof');

    this.events.emit('crowd:kill', {
      kills: this.kills,
      mode: this.mode,
      hostileChance: this.getHostileChance(),
    });

    if (nextMode !== prevMode) {
      this.events.emit('rebellion:changed', {
        mode: nextMode,
        prevMode,
        kills: this.kills,
        hostileChance: this.getHostileChance(),
      });
      this.audio.playRebellionAlert(nextMode === 'major');
      // Immediately escalate crowd across the vicinity when crossing Kill 5 or Kill 20
      this.escalateCrowdNear(
        birdPos,
        nextMode === 'major' ? 145 * 145 : 95 * 95,
        birdPos,
        true
      );
    } else {
      this.onPlayerShot(cand.point, birdPos);
    }

    // If eliminated NPC was part of a couple, immediately put surviving partner into crying/panic sprint
    this.triggerPartnerPanic(slot, birdPos);
  }

  private shatterGoldenTrophy(
    slot: CrowdHumanSlot,
    impactPos: THREE.Vector3,
    birdPos: THREE.Vector3
  ): void {
    slot.trophyIntact = false;
    if (slot.trophyGroup) slot.trophyGroup.visible = false;

    this.fx.spawnShatterDebris(impactPos, 0xffd23f);
    this.fx.spawnBurst(impactPos, 14, true, 5.4);
    this.audio.playCeramicShatter(impactPos);
    _burstPos.copy(slot.root.position).setY(slot.root.position.y + 8.5 * slot.scale);
    this.audio.playHumanYell(_burstPos, slot.voicePitch * 0.88, 'hey');
    this.audio.playRebellionAlert(true);

    // Put this specific NPC into Extreme Rage mode (glowing red aura, 70% accuracy)
    slot.extremeRage = true;
    if (slot.rageAuraGroup) slot.rageAuraGroup.visible = true;
    this.setSlotHostile(slot, birdPos);
    slot.fireCooldown = 0.28;

    // Also enforce 120s shoulder-perching cooldown on gunfire
    this.perchCooldownTimer = SHOULDER_PERCH_COOLDOWN_SEC;
    if (this.admiredSlotIndex >= 0) {
      this.slots[this.admiredSlotIndex].heartIconGroup.visible = false;
      this.admiredSlotIndex = -1;
    }
    this.events.emit('crowd:admired', {
      admired: false,
      cooldownRemaining: this.perchCooldownTimer,
    });

    // Trigger immediate local rebellion around the shattered trophy
    let spawnedRebels = 0;
    for (let i = 0; i < this.slots.length; i++) {
      const other = this.slots[i];
      if (other.index === slot.index || other.state === 'ragdoll' || other.state === 'crying') {
        continue;
      }
      const dx = other.root.position.x - impactPos.x;
      const dz = other.root.position.z - impactPos.z;
      if (dx * dx + dz * dz > EXTREME_RAGE_REBELLION_RADIUS_SQ) continue;

      if (other.state === 'hostile') continue;
      // Local rebellion surge: ~45% nearby turn hostile & shoot back, rest scatter screaming
      if (Math.random() < 0.45 || spawnedRebels === 0) {
        this.setSlotHostile(other, birdPos);
        spawnedRebels++;
      } else {
        this.setSlotFleeing(other, birdPos);
      }
    }

    this.events.emit('crowd:trophyShattered', {
      slotIndex: slot.index,
      pos: impactPos.clone(),
      rageAccuracy: EXTREME_RAGE_ACCURACY,
    });
  }

  private triggerPartnerPanic(fallenSlot: CrowdHumanSlot, threatPos: THREE.Vector3): void {
    if (fallenSlot.partnerIndex < 0) return;
    const partner = this.slots[fallenSlot.partnerIndex];
    if (!partner || partner.state === 'ragdoll') return;

    partner.state = 'crying';
    partner.gunGroup.visible = false;
    partner.muzzleFlash.visible = false;
    partner.heartIconGroup.visible = false;
    partner.tearIconGroup.visible = true;
    partner.cryTimer = COUPLE_CRY_DURATION;

    if (this.admiredSlotIndex === partner.index) {
      this.admiredSlotIndex = -1;
      this.events.emit('crowd:admired', {
        admired: false,
        cooldownRemaining: this.perchCooldownTimer,
      });
    }

    const dx = partner.root.position.x - threatPos.x;
    const dz = partner.root.position.z - threatPos.z;
    const len = Math.hypot(dx, dz);
    if (len > 0.1) {
      partner.fleeDirX = dx / len;
      partner.fleeDirZ = dz / len;
    } else {
      const ang = (partner.index * 1.7) % (Math.PI * 2);
      partner.fleeDirX = Math.cos(ang);
      partner.fleeDirZ = Math.sin(ang);
    }

    _burstPos.copy(partner.root.position).setY(partner.root.position.y + 8.5 * partner.scale);
    this.audio.playHumanYell(_burstPos, Math.min(1.45, partner.voicePitch * 1.18), 'shoo');
  }

  /**
   * Called whenever the player fires their pistol (`gun:fired`).
   * - Resets the 120-second (2-minute) shoulder-perching cooldown, cancels all admiring states,
   *   and immediately ejects the bird if perched on an NPC shoulder.
   * - Below 5 kills: nearby NPCs scream and flee.
   * - At >= 5 kills: nearby NPCs roll 10% chance to turn hostile and shoot back.
   * - At >= 20 kills (MAJOR REBELLION): nearby/remaining NPCs roll to reach 40% hostile fighters.
   */
  public onPlayerShot(shotPos: THREE.Vector3, birdPos: THREE.Vector3, activePerchId = ''): void {
    this.perchCooldownTimer = SHOULDER_PERCH_COOLDOWN_SEC;

    if (this.admiredSlotIndex >= 0) {
      this.slots[this.admiredSlotIndex].heartIconGroup.visible = false;
      this.admiredSlotIndex = -1;
    }

    if (
      activePerchId.startsWith('crowd_shoulder_') ||
      activePerchId.startsWith('npc_shoulder_') ||
      activePerchId.startsWith('npc_hat_')
    ) {
      _ejectImpulse.set((Math.random() - 0.5) * 4.5, 5.8, (Math.random() - 0.5) * 4.5);
      this.pendingEjectImpulse = true;
    }

    this.events.emit('crowd:admired', {
      admired: false,
      cooldownRemaining: this.perchCooldownTimer,
    });

    this.escalateCrowdNear(shotPos, SHOT_ALERT_RADIUS_SQ, birdPos, false);
  }

  private escalateCrowdNear(
    origin: THREE.Vector3,
    radiusSq: number,
    birdPos: THREE.Vector3,
    forcePlayScream: boolean
  ): void {
    const tierTarget: 0 | 1 | 2 =
      this.kills >= MAJOR_REBELLION_KILL_THRESHOLD
        ? 2
        : this.kills >= ESCALATION_KILL_THRESHOLD
          ? 1
          : 0;

    let screamed = false;
    let maxAlertSounds = 0;

    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i];
      if (slot.state === 'ragdoll' || slot.state === 'crying') continue;

      const dx = slot.root.position.x - origin.x;
      const dz = slot.root.position.z - origin.z;
      const dSq = dx * dx + dz * dz;
      const inRange = dSq <= radiusSq || slot.root.position.distanceToSquared(birdPos) <= radiusSq;
      if (!inRange) continue;

      if (tierTarget === 0) {
        // Peaceful/pre-rebellion panic: scream and run away
        if (slot.state !== 'fleeing' || slot.fleeTimer < 2.0) {
          this.setSlotFleeing(slot, birdPos);
        }
        if (!screamed && this.screamCooldown <= 0 && maxAlertSounds < 2) {
          this.screamCooldown = 0.42;
          maxAlertSounds++;
          screamed = true;
          _burstPos.copy(slot.root.position).setY(slot.root.position.y + 8.5 * slot.scale);
          this.audio.playHumanYell(_burstPos, slot.voicePitch, i % 2 === 0 ? 'oi' : 'hey');
        }
        continue;
      }

      // Already hostile? Refresh awareness & don't downgrade
      if (slot.state === 'hostile') {
        slot.rolledTier = tierTarget;
        continue;
      }

      // Roll hostile chance cleanly once per escalation tier
      if (slot.rolledTier < tierTarget) {
        let turnHostile = false;
        if (tierTarget === 1) {
          // Kills 5..19: exact 10% chance to turn hostile
          turnHostile = Math.random() < 0.1;
        } else if (slot.rolledTier === 1) {
          // Surviving NPC that failed the 10% roll upgrades to exact 40% total probability:
          // P(hostile) = 0.10 + 0.90 * 0.3333 = 0.40
          turnHostile = Math.random() < 1 / 3;
        } else {
          // Fresh NPC rolling straight into MAJOR REBELLION: exact 40% chance
          turnHostile = Math.random() < 0.4;
        }
        slot.rolledTier = tierTarget;

        if (turnHostile) {
          this.setSlotHostile(slot, birdPos);
          if (this.screamCooldown <= 0 || forcePlayScream) {
            this.screamCooldown = 0.45;
            _burstPos.copy(slot.root.position).setY(slot.root.position.y + 8.5 * slot.scale);
            this.audio.playHumanYell(_burstPos, slot.voicePitch, 'hey');
          }
        } else {
          this.setSlotFleeing(slot, birdPos);
          if (!screamed && this.screamCooldown <= 0) {
            this.screamCooldown = 0.42;
            screamed = true;
            _burstPos.copy(slot.root.position).setY(slot.root.position.y + 8.5 * slot.scale);
            this.audio.playHumanYell(_burstPos, slot.voicePitch, 'shoo');
          }
        }
      } else if (slot.state === 'walking') {
        this.setSlotFleeing(slot, birdPos);
      }
    }
  }

  private setSlotFleeing(slot: CrowdHumanSlot, threatPos: THREE.Vector3): void {
    slot.state = 'fleeing';
    slot.gunGroup.visible = false;
    slot.muzzleFlash.visible = false;
    slot.heartIconGroup.visible = false;
    const dx = slot.root.position.x - threatPos.x;
    const dz = slot.root.position.z - threatPos.z;
    const len = Math.hypot(dx, dz);
    if (len > 0.1) {
      slot.fleeDirX = dx / len;
      slot.fleeDirZ = dz / len;
    } else {
      const ang = (slot.index * 1.3) % (Math.PI * 2);
      slot.fleeDirX = Math.cos(ang);
      slot.fleeDirZ = Math.sin(ang);
    }
    slot.fleeTimer = 5.0 + ((slot.index * 7) % 5) * 0.45;
  }

  private setSlotHostile(slot: CrowdHumanSlot, targetPos: THREE.Vector3): void {
    slot.state = 'hostile';
    slot.gunGroup.visible = true;
    slot.muzzleFlash.visible = false;
    slot.heartIconGroup.visible = false;
    slot.muzzleFlashTimer = 0;
    slot.fireCooldown = 0.45 + ((slot.index * 11) % 8) * 0.18;
    const dx = targetPos.x - slot.root.position.x;
    const dz = targetPos.z - slot.root.position.z;
    if (dx * dx + dz * dz > 0.01) {
      slot.yaw = Math.atan2(dx, dz);
    }
  }

  private enterRagdoll(slot: CrowdHumanSlot, bulletDir: THREE.Vector3, _birdPos: THREE.Vector3): void {
    // Enforce hard cap of MAX_ACTIVE_RAGDOLLS (15): force-recycle oldest active ragdoll if needed
    while (this.activeRagdollQueue.length >= MAX_ACTIVE_RAGDOLLS) {
      const oldestIdx = this.activeRagdollQueue.shift();
      if (oldestIdx !== undefined && oldestIdx !== slot.index) {
        this.recycleRagdollOffscreen(this.slots[oldestIdx]);
      }
    }

    slot.state = 'ragdoll';
    slot.extremeRage = false;
    slot.gunGroup.visible = false;
    slot.muzzleFlash.visible = false;
    slot.heartIconGroup.visible = false;
    slot.tearIconGroup.visible = false;
    if (slot.rageAuraGroup) slot.rageAuraGroup.visible = false;
    if (slot.cartGroup) slot.cartGroup.visible = false;
    slot.shadowDisc.visible = false;
    slot.ragdollTimer = 0;
    slot.ragdollPos.copy(slot.root.position);
    slot.ragdollVel.set(
      bulletDir.x * 13.5 + ((slot.index % 2 === 0 ? 1 : -1) * 2.2),
      6.4,
      bulletDir.z * 13.5 + (((slot.index * 3) % 2 === 0 ? -1 : 1) * 2.2)
    );
    slot.ragdollPitch = 0;
    slot.ragdollRoll = 0;
    slot.ragdollPitchVel = 4.6 + (slot.index % 3) * 1.1;
    slot.ragdollRollVel = (slot.index % 2 === 0 ? 1 : -1) * (3.2 + (slot.index % 4) * 0.65);
    slot.ragdollYawVel = (slot.index % 2 === 0 ? -1 : 1) * 2.4;

    if (slot.ragdollMatIdx === -1 && this.freeRagdollMatIndices.length > 0) {
      slot.ragdollMatIdx = this.freeRagdollMatIndices.pop()!;
      this.ragdollMatPool[slot.ragdollMatIdx].opacity = 1.0;
    }

    this.activeRagdollQueue.push(slot.index);
  }

  private pickOffscreenSpawnNode(birdPos: THREE.Vector3, camera: THREE.Camera): number {
    camera.getWorldDirection(_camFwd);
    const camPos = camera.position;

    let bestNode = 0;
    let bestScore = -Infinity;

    for (let i = 0; i < WALK_GRAPH.length; i++) {
      const node = WALK_GRAPH[i];
      if (this.isInsideRestrictedArea(node.x, node.z)) continue;

      const bdx = node.x - birdPos.x;
      const bdz = node.z - birdPos.z;
      const birdDistSq = bdx * bdx + bdz * bdz;
      // Avoid popping right next to player
      if (birdDistSq < 46 * 46) continue;

      const cdx = node.x - camPos.x;
      const cdz = node.z - camPos.z;
      const cLen = Math.hypot(cdx, cdz) || 1;
      const dot = (cdx * _camFwd.x + cdz * _camFwd.z) / cLen;

      // Prefer nodes outside forward camera FOV (dot < 0.28) or sufficiently distant (> 92 SU)
      let score = dot < 0.28 ? 100 : birdDistSq > 92 * 92 ? 40 : -50;
      score += Math.min(70, Math.sqrt(birdDistSq) * 0.45);
      score -= dot * 24;

      // Slight spread jitter so recycled NPCs don't all stack at one corner
      score += Math.random() * 14;

      if (score > bestScore) {
        bestScore = score;
        bestNode = i;
      }
    }

    return bestNode;
  }

  private recycleRagdollOffscreen(
    slot: CrowdHumanSlot,
    birdPos?: THREE.Vector3,
    camera?: THREE.Camera
  ): void {
    const qPos = this.activeRagdollQueue.indexOf(slot.index);
    if (qPos >= 0) {
      this.activeRagdollQueue.splice(qPos, 1);
    }

    if (slot.ragdollMatIdx >= 0) {
      this.ragdollMatPool[slot.ragdollMatIdx].opacity = 1.0;
      this.freeRagdollMatIndices.push(slot.ragdollMatIdx);
      slot.ragdollMatIdx = -1;
    }

    this.setSlotMaterial(slot, this.sharedOpaqueMat);

    const nodeIdx =
      birdPos && camera
        ? this.pickOffscreenSpawnNode(birdPos, camera)
        : (slot.index * 5 + 3) % WALK_GRAPH.length;
    const node = WALK_GRAPH[nodeIdx];
    const nextIdx =
      node.neighbors.length > 0
        ? node.neighbors[(slot.index + 1) % node.neighbors.length]
        : (nodeIdx + 1) % WALK_GRAPH.length;
    const nextNode = WALK_GRAPH[nextIdx];

    const jitterAng = Math.random() * Math.PI * 2;
    const jitterR = 1.2 + Math.random() * 1.6;
    const sx = node.x + Math.cos(jitterAng) * jitterR;
    const sz = node.z + Math.sin(jitterAng) * jitterR;
    const gy = this.sampleWalkGroundY(sx, sz);
    const yaw = Math.atan2(nextNode.x - sx, nextNode.z - sz);

    slot.state = 'walking';
    slot.rolledTier = 0;
    slot.extremeRage = false;
    slot.currentNodeIdx = nodeIdx;
    slot.targetNodeIdx = nextIdx;
    slot.groundY = gy;
    slot.yaw = yaw;
    slot.fleeTimer = 0;
    slot.cryTimer = 0;
    slot.intimidateCooldown = 0;
    slot.ragdollTimer = 0;
    slot.gunGroup.visible = false;
    slot.muzzleFlash.visible = false;
    slot.heartIconGroup.visible = false;
    slot.tearIconGroup.visible = false;
    if (slot.rageAuraGroup) slot.rageAuraGroup.visible = false;
    if (slot.hasTrophyCart) {
      slot.trophyIntact = true;
      if (slot.cartGroup) slot.cartGroup.visible = true;
      if (slot.trophyGroup) slot.trophyGroup.visible = true;
    }
    slot.shadowDisc.visible = true;

    slot.root.position.set(sx, gy, sz);
    slot.root.rotation.set(0, yaw, 0);
    slot.bodyPivot.position.set(0, slot.baseHipY, 0);
    slot.bodyPivot.rotation.set(0, 0, 0);
    slot.armLPivot.rotation.set(0, 0, 0);
    slot.armRPivot.rotation.set(0, 0, 0);
    slot.legLPivot.rotation.set(0, 0, 0);
    slot.legRPivot.rotation.set(0, 0, 0);
  }

  private fireEnemyBullet(
    slot: CrowdHumanSlot,
    birdPos: THREE.Vector3,
    birdVelocity: THREE.Vector3
  ): void {
    slot.root.updateMatrixWorld(true);
    slot.muzzleFlash.getWorldPosition(_muzzleWorld);

    _bulletDir.subVectors(birdPos, _muzzleWorld);
    const dist = _bulletDir.length();
    if (dist < 0.5) return;
    _bulletDir.divideScalar(dist);

    // Line-of-sight check so rebels don't shoot blindly into solid walls
    _losOrigin.copy(_muzzleWorld);
    _losDir.copy(_bulletDir);
    const losHit = this.physics.raycastGround(
      _losOrigin,
      _losDir,
      Math.max(0.5, dist - 1.1),
      undefined,
      _losHit,
      COLLISION_GROUP_STATIC
    );
    if (losHit.hit) return;

    // Strictly reuse an inactive slot first, otherwise recycle oldest at the 50-bullet cap
    let bullet = this.enemyBullets[this.enemyBulletCursor];
    if (bullet.active) {
      let foundInactive = false;
      for (let i = 0; i < this.enemyBullets.length; i++) {
        const idx = (this.enemyBulletCursor + i) % this.enemyBullets.length;
        if (!this.enemyBullets[idx].active) {
          bullet = this.enemyBullets[idx];
          this.enemyBulletCursor = (idx + 1) % this.enemyBullets.length;
          foundInactive = true;
          break;
        }
      }
      if (!foundInactive) {
        this.enemyBulletCursor = (this.enemyBulletCursor + 1) % this.enemyBullets.length;
      }
    } else {
      this.enemyBulletCursor = (this.enemyBulletCursor + 1) % this.enemyBullets.length;
    }

    const bulletSpeed = slot.extremeRage ? EXTREME_RAGE_BULLET_SPEED : ENEMY_BULLET_SPEED;

    if (slot.extremeRage) {
      if (Math.random() < EXTREME_RAGE_ACCURACY) {
        // 70% dead-on predictive shot leading the bird's motion cleanly
        const leadTime = Math.min(0.45, dist / bulletSpeed);
        _bulletNext.copy(birdPos).addScaledVector(birdVelocity, leadTime * 0.85);
        _bulletDir.subVectors(_bulletNext, _muzzleWorld).normalize();
        _bulletDir.set(
          _bulletDir.x + (Math.random() - 0.5) * 0.008,
          _bulletDir.y + (Math.random() - 0.5) * 0.008,
          _bulletDir.z + (Math.random() - 0.5) * 0.008
        ).normalize();
      } else {
        // 30% miss outside the bird's hurt sphere
        const missSignX = Math.random() < 0.5 ? -1 : 1;
        const missSignY = Math.random() < 0.5 ? -1 : 1;
        _bulletDir.set(
          _bulletDir.x + missSignX * (0.11 + Math.random() * 0.08),
          _bulletDir.y + missSignY * (0.06 + Math.random() * 0.05),
          _bulletDir.z + missSignX * 0.08
        ).normalize();
      }
    } else {
      // Slight fair angular spread so an airborne, weaving sparrow can dodge normal gunfire
      const spreadX = (Math.random() - 0.5) * 0.085;
      const spreadY = (Math.random() - 0.5) * 0.065;
      const spreadZ = (Math.random() - 0.5) * 0.085;
      _bulletDir.set(
        _bulletDir.x + spreadX,
        _bulletDir.y + spreadY,
        _bulletDir.z + spreadZ
      ).normalize();
    }

    bullet.active = true;
    bullet.age = 0;
    bullet.pos.copy(_muzzleWorld);
    bullet.prevPos.copy(_muzzleWorld);
    bullet.vel.copy(_bulletDir).multiplyScalar(bulletSpeed);
    bullet.mesh.position.copy(_muzzleWorld);
    bullet.mesh.lookAt(
      _muzzleWorld.x + _bulletDir.x,
      _muzzleWorld.y + _bulletDir.y,
      _muzzleWorld.z + _bulletDir.z
    );
    bullet.mesh.visible = true;

    slot.muzzleFlash.visible = true;
    slot.muzzleFlashTimer = 0.06;
    this.audio.playGunshot(_muzzleWorld);
  }

  private damageBird(hitPos: THREE.Vector3): void {
    if (this.birdInvulnTimer > 0 || this.birdDownedTimer > 0) return;

    const prevHp = this.birdHp;
    this.birdHpExact = Math.max(0, this.birdHpExact - ENEMY_BULLET_DAMAGE);
    this.birdHp = Math.round(this.birdHpExact);
    this.birdInvulnTimer = 0.24;

    this.fx.spawnFeatherBurst(hitPos, 8, 3.8);
    if (this.hitSfxCooldown <= 0) {
      this.hitSfxCooldown = 0.16;
      this.audio.playBirdHurt();
    }

    const downed = this.birdHp <= 0;
    if (downed) {
      this.birdDownedTimer = 2.2;
      this.birdInvulnTimer = 2.6;
      // Clear active airborne bullets and briefly cool enemy shooters so recovery is fair
      for (let i = 0; i < this.enemyBullets.length; i++) {
        this.enemyBullets[i].active = false;
        this.enemyBullets[i].mesh.visible = false;
      }
      for (let i = 0; i < this.slots.length; i++) {
        if (this.slots[i].state === 'hostile') {
          this.slots[i].fireCooldown = Math.max(this.slots[i].fireCooldown, 2.6);
        }
      }
    }

    this.events.emit('bird:healthChanged', {
      hp: this.birdHp,
      maxHp: BIRD_MAX_HEALTH,
      delta: this.birdHp - prevHp,
      downed,
    });
  }

  public reviveBird(): void {
    this.birdDownedTimer = 0;
    this.birdInvulnTimer = 2.4;
    this.birdHpExact = BIRD_MAX_HEALTH;
    this.birdHp = BIRD_MAX_HEALTH;
    for (let i = 0; i < this.enemyBullets.length; i++) {
      this.enemyBullets[i].active = false;
      this.enemyBullets[i].mesh.visible = false;
    }
    for (let i = 0; i < this.slots.length; i++) {
      if (this.slots[i].state === 'hostile') {
        this.slots[i].fireCooldown = Math.max(this.slots[i].fireCooldown, 2.2);
      }
    }
    this.events.emit('bird:healthChanged', {
      hp: this.birdHp,
      maxHp: BIRD_MAX_HEALTH,
      delta: BIRD_MAX_HEALTH,
      downed: false,
    });
  }

  private stepEnemyBullets(dt: number, birdPos: THREE.Vector3): void {
    for (let i = 0; i < this.enemyBullets.length; i++) {
      const b = this.enemyBullets[i];
      if (!b.active) continue;

      b.age += dt;
      if (
        b.age >= ENEMY_BULLET_MAX_AGE ||
        Math.abs(b.pos.x) > 360 ||
        Math.abs(b.pos.z) > 360 ||
        b.pos.y < -10 ||
        b.pos.y > 200
      ) {
        b.active = false;
        b.mesh.visible = false;
        continue;
      }

      b.prevPos.copy(b.pos);
      _bulletNext.copy(b.pos).addScaledVector(b.vel, dt);
      _bulletRayDir.subVectors(_bulletNext, b.prevPos);
      const segLen = _bulletRayDir.length();

      if (segLen > 1e-5) {
        _bulletRayDir.divideScalar(segLen);

        // Swept collision vs static world geometry (walls/buildings provide cover)
        const wallHit = this.physics.raycastGround(
          b.prevPos,
          _bulletRayDir,
          segLen + 0.05,
          undefined,
          _bulletHit,
          COLLISION_GROUP_STATIC
        );
        const maxTravel = wallHit.hit ? wallHit.distance : segLen;

        // Swept sphere test vs Birdy hitbox
        _bulletToBird.subVectors(birdPos, b.prevPos);
        const proj = Math.max(0, Math.min(maxTravel, _bulletToBird.dot(_bulletRayDir)));
        _bulletClosest.copy(b.prevPos).addScaledVector(_bulletRayDir, proj);
        if (_bulletClosest.distanceToSquared(birdPos) <= BIRD_HURT_RADIUS * BIRD_HURT_RADIUS) {
          b.active = false;
          b.mesh.visible = false;
          this.damageBird(_bulletClosest);
          continue;
        }

        if (wallHit.hit) {
          b.active = false;
          b.mesh.visible = false;
          continue;
        }
      }

      b.pos.copy(_bulletNext);
      b.mesh.position.copy(b.pos);
    }
  }

  private moveHumanXZ(slot: CrowdHumanSlot, dirX: number, dirZ: number, dist: number, tramX: number): void {
    // 1. Static 2D spatial grid avoidance around trees, benches, planters & walls
    this.physics.steerAndResolve2D(
      slot.root.position.x,
      slot.root.position.z,
      dirX,
      dirZ,
      0.72,
      2.6,
      _steer2dOut
    );
    let moveX = _steer2dOut.steerX;
    let moveZ = _steer2dOut.steerZ;
    let baseX = _steer2dOut.x;
    let baseZ = _steer2dOut.z;

    // 2. Waist-height obstacle whisker backup for non-registered/dynamic props
    _losOrigin.set(baseX, slot.root.position.y + 3.2, baseZ);
    _losDir.set(moveX, 0, moveZ);
    const wall = this.physics.raycastGround(
      _losOrigin,
      _losDir,
      1.9 + dist,
      undefined,
      _losHit,
      COLLISION_GROUP_STATIC
    );
    let blockedByWall = false;
    if (wall.hit && wall.normal.y < 0.55) {
      blockedByWall = true;
      const dot = moveX * wall.normal.x + moveZ * wall.normal.z;
      if (dot < 0) {
        moveX -= wall.normal.x * dot;
        moveZ -= wall.normal.z * dot;
        const nLen = Math.hypot(moveX, moveZ);
        if (nLen > 0.05) {
          moveX /= nLen;
          moveZ /= nLen;
        } else {
          moveX = -wall.normal.z;
          moveZ = wall.normal.x;
        }
      }
    }

    if (slot.state === 'fleeing' || slot.state === 'crying') {
      slot.fleeDirX = moveX;
      slot.fleeDirZ = moveZ;
    }

    let nx = baseX + moveX * dist;
    let nz = baseZ + moveZ * dist;

    // Expanded World bounds clamp (`±312 SU` inside outer facades)
    if (nx < -312) {
      nx = -312;
      if (slot.state === 'fleeing' || slot.state === 'crying') slot.fleeDirX = Math.abs(slot.fleeDirX);
    }
    if (nx > 312) {
      nx = 312;
      if (slot.state === 'fleeing' || slot.state === 'crying') slot.fleeDirX = -Math.abs(slot.fleeDirX);
    }
    if (nz < -312) {
      nz = -312;
      if (slot.state === 'fleeing' || slot.state === 'crying') slot.fleeDirZ = Math.abs(slot.fleeDirZ);
    }
    if (nz > 312) {
      nz = 312;
      if (slot.state === 'fleeing' || slot.state === 'crying') slot.fleeDirZ = -Math.abs(slot.fleeDirZ);
    }

    // Avoid tram corridor hazard at z ≈ 0
    if (Math.abs(nz) < 4.8 && Math.abs(nx - tramX) < 19.0) {
      nz += nz >= 0 ? dist * 1.4 : -dist * 1.4;
    }

    // Reject moves into restricted water basins / central fountain
    let restricted = this.isInsideRestrictedArea(nx, nz);
    if (restricted) {
      if (slot.state === 'fleeing' || slot.state === 'crying') {
        const tmp = slot.fleeDirX;
        slot.fleeDirX = -slot.fleeDirZ;
        slot.fleeDirZ = tmp;
      }
      nx = baseX;
      nz = baseZ;
    } else {
      // Re-clamp final position cleanly out of any 2D obstacle
      this.physics.steerAndResolve2D(nx, nz, moveX, moveZ, 0.72, 0.2, _steer2dOut);
      nx = Math.max(-312, Math.min(312, _steer2dOut.x));
      nz = Math.max(-312, Math.min(312, _steer2dOut.z));
    }

    const movedDist = Math.hypot(nx - slot.root.position.x, nz - slot.root.position.z);
    slot.root.position.x = nx;
    slot.root.position.z = nz;

    // Smart waypoint recovery: if nearly stalled against a corner/water edge while patrolling, pick another neighbor
    if (dist > 0.01 && (movedDist < dist * 0.25 || restricted || (blockedByWall && _steer2dOut.collided))) {
      slot.steerStuckFrames += 1;
      if (slot.steerStuckFrames >= 12 && slot.state === 'walking') {
        slot.steerStuckFrames = 0;
        const curNode = WALK_GRAPH[slot.currentNodeIdx] ?? WALK_GRAPH[slot.targetNodeIdx];
        const neighbors = curNode.neighbors;
        if (neighbors.length > 0) {
          const alt = neighbors[(slot.index + Math.floor(Math.random() * neighbors.length)) % neighbors.length];
          slot.targetNodeIdx = alt;
        }
      }
    } else {
      slot.steerStuckFrames = 0;
    }
  }

  public update(
    dt: number,
    elapsed: number,
    birdPos: THREE.Vector3,
    camera: THREE.Camera,
    tramX: number,
    activePerchId = '',
    gunEquipped = false,
    birdVelocity: THREE.Vector3 = _zeroVec
  ): void {
    if (this.disposed) return;

    if (this.screamCooldown > 0) this.screamCooldown = Math.max(0, this.screamCooldown - dt);
    if (this.globalEnemyFireCooldown > 0) {
      this.globalEnemyFireCooldown = Math.max(0, this.globalEnemyFireCooldown - dt);
    }
    if (this.hitSfxCooldown > 0) this.hitSfxCooldown = Math.max(0, this.hitSfxCooldown - dt);
    if (this.birdInvulnTimer > 0) this.birdInvulnTimer = Math.max(0, this.birdInvulnTimer - dt);

    // Tick 120-second gunfire perching cooldown; once it hits 0 and gun is holstered, calm fleeing NPCs
    const prevCooldown = this.perchCooldownTimer;
    if (this.perchCooldownTimer > 0) {
      this.perchCooldownTimer = Math.max(0, this.perchCooldownTimer - dt);
      if (this.perchCooldownTimer <= 0 && !gunEquipped) {
        for (let i = 0; i < this.slots.length; i++) {
          if (this.slots[i].state === 'fleeing') {
            this.slots[i].state = 'walking';
            this.slots[i].fleeTimer = 0;
          }
        }
      }
    }

    // Parse active crowd shoulder perch index
    let currentPerchedSlotIdx = -1;
    let perchedSide: -1 | 1 = 1;
    if (
      this.perchCooldownTimer > 0 &&
      (activePerchId.startsWith('crowd_shoulder_') ||
        activePerchId.startsWith('npc_shoulder_') ||
        activePerchId.startsWith('npc_hat_'))
    ) {
      _ejectImpulse.set((Math.random() - 0.5) * 4.5, 5.8, (Math.random() - 0.5) * 4.5);
      this.pendingEjectImpulse = true;
    } else if (this.perchCooldownTimer <= 0 && !gunEquipped && activePerchId.startsWith('crowd_shoulder_')) {
      const isLeft = activePerchId.startsWith('crowd_shoulder_l_');
      const idxStr = activePerchId.slice('crowd_shoulder_x_'.length);
      const parsed = Number.parseInt(idxStr, 10);
      if (Number.isFinite(parsed) && parsed >= 0 && parsed < this.slots.length) {
        const candidate = this.slots[parsed];
        if (candidate.state === 'walking') {
          currentPerchedSlotIdx = parsed;
          perchedSide = isLeft ? -1 : 1;
        }
      }
    }

    // Also count story NPC shoulder/hat perches as Admired when peaceful & no gunfire cooldown
    const isStoryShoulderPerched =
      this.perchCooldownTimer <= 0 &&
      !gunEquipped &&
      (activePerchId.startsWith('npc_shoulder_') || activePerchId.startsWith('npc_hat_'));
    const isCurrentlyAdmired = currentPerchedSlotIdx >= 0 || isStoryShoulderPerched;

    if (
      currentPerchedSlotIdx !== this.admiredSlotIndex ||
      Math.ceil(prevCooldown) !== Math.ceil(this.perchCooldownTimer)
    ) {
      if (this.admiredSlotIndex >= 0 && this.admiredSlotIndex !== currentPerchedSlotIdx) {
        this.slots[this.admiredSlotIndex].heartIconGroup.visible = false;
      }
      this.admiredSlotIndex = currentPerchedSlotIdx;
      this.events.emit('crowd:admired', {
        admired: isCurrentlyAdmired,
        cooldownRemaining: this.perchCooldownTimer,
      });
    }

    // Regenerate +2 Birdy Health per second while perched & admired
    if (isCurrentlyAdmired && this.birdDownedTimer <= 0 && this.birdHpExact < BIRD_MAX_HEALTH) {
      const prevRounded = this.birdHp;
      this.birdHpExact = Math.min(BIRD_MAX_HEALTH, this.birdHpExact + SHOULDER_HEAL_PER_SEC * dt);
      const nextRounded = Math.round(this.birdHpExact);
      if (nextRounded !== prevRounded) {
        this.birdHp = nextRounded;
        this.events.emit('bird:healthChanged', {
          hp: this.birdHp,
          maxHp: BIRD_MAX_HEALTH,
          delta: nextRounded - prevRounded,
          downed: false,
        });
      }
    }

    // Non-blocking downed recovery timer so game never soft-locks
    if (this.birdDownedTimer > 0) {
      this.birdDownedTimer = Math.max(0, this.birdDownedTimer - dt);
      if (this.birdDownedTimer <= 0) {
        this.birdHpExact = BIRD_MAX_HEALTH;
        this.birdHp = BIRD_MAX_HEALTH;
        this.events.emit('bird:healthChanged', {
          hp: this.birdHp,
          maxHp: BIRD_MAX_HEALTH,
          delta: BIRD_MAX_HEALTH,
          downed: false,
        });
      }
    }

    const majorMode = this.kills >= MAJOR_REBELLION_KILL_THRESHOLD;

    // 0. Check & emit whether an intimidation target is in range while gun is equipped
    const intimidateAvail =
      gunEquipped && this.findIntimidateCandidate(birdPos, camera) >= 0;
    if (intimidateAvail !== this.lastIntimidatePromptAvailable) {
      this.lastIntimidatePromptAvailable = intimidateAvail;
      this.events.emit('crowd:intimidatePrompt', { available: intimidateAvail });
    }

    // 1. Update all 45 pooled crowd NPCs
    const camPos = camera.position;
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i];

      if (slot.intimidateCooldown > 0) {
        slot.intimidateCooldown = Math.max(0, slot.intimidateCooldown - dt);
      }

      if (slot.muzzleFlashTimer > 0) {
        slot.muzzleFlashTimer = Math.max(0, slot.muzzleFlashTimer - dt);
        if (slot.muzzleFlashTimer <= 0) {
          slot.muzzleFlash.visible = false;
        }
      }

      const cdx = slot.root.position.x - camPos.x;
      const cdz = slot.root.position.z - camPos.z;
      const camDistSq = cdx * cdx + cdz * cdz;
      const animateLimbs = camDistSq <= 90 * 90;

      if (slot.state === 'ragdoll') {
        slot.shadowDisc.visible = false;
        slot.ragdollTimer += dt;
        slot.ragdollVel.y -= 28.0 * dt;
        slot.ragdollPos.addScaledVector(slot.ragdollVel, dt);

        if (slot.ragdollPos.y <= slot.groundY) {
          slot.ragdollPos.y = slot.groundY;
          if (slot.ragdollVel.y < -2.2) {
            slot.ragdollVel.y = -slot.ragdollVel.y * 0.28;
          } else {
            slot.ragdollVel.y = 0;
          }
          slot.ragdollVel.x *= Math.max(0, 1 - 6.8 * dt);
          slot.ragdollVel.z *= Math.max(0, 1 - 6.8 * dt);
          slot.ragdollPitchVel *= Math.max(0, 1 - 5.5 * dt);
          slot.ragdollRollVel *= Math.max(0, 1 - 5.5 * dt);
          slot.ragdollYawVel *= Math.max(0, 1 - 5.5 * dt);
        }

        slot.ragdollPitch = Math.min(Math.PI * 0.48, slot.ragdollPitch + slot.ragdollPitchVel * dt);
        slot.ragdollRoll += slot.ragdollRollVel * dt;
        slot.yaw += slot.ragdollYawVel * dt;

        slot.root.position.copy(slot.ragdollPos);
        slot.root.rotation.y = slot.yaw;

        // Collapse body to ground & flail limbs during knockout
        const collapseT = Math.min(1, slot.ragdollTimer * 2.8);
        slot.bodyPivot.position.y = slot.baseHipY * (1 - collapseT * 0.78) + 0.35;
        slot.bodyPivot.rotation.set(slot.ragdollPitch, 0, slot.ragdollRoll * 0.55);
        slot.armLPivot.rotation.set(-1.35 * collapseT, 0, -0.85 * collapseT);
        slot.armRPivot.rotation.set(-1.15 * collapseT, 0, 0.92 * collapseT);
        slot.legLPivot.rotation.set(1.25 * collapseT, 0, -0.24 * collapseT);
        slot.legRPivot.rotation.set(1.42 * collapseT, 0, 0.28 * collapseT);

        // Smooth opacity fade-out across the final 0.8s (2.2s -> 3.0s)
        if (slot.ragdollTimer >= RAGDOLL_FADE_START && slot.ragdollMatIdx >= 0) {
          const fadeMat = this.ragdollMatPool[slot.ragdollMatIdx];
          if (slot.torsoHeadMesh.material !== fadeMat) {
            this.setSlotMaterial(slot, fadeMat);
          }
          const fadeFrac = Math.min(
            1,
            (slot.ragdollTimer - RAGDOLL_FADE_START) / (RAGDOLL_DURATION - RAGDOLL_FADE_START)
          );
          fadeMat.opacity = Math.max(0, 1 - fadeFrac);
        }

        if (slot.ragdollTimer >= RAGDOLL_DURATION) {
          this.recycleRagdollOffscreen(slot, birdPos, camera);
        }
        continue;
      }

      slot.shadowDisc.visible = camDistSq <= 135 * 135;

      if (animateLimbs && slot.hasTrophyCart && slot.trophyIntact && slot.trophyHaloMesh) {
        const pulse = 1.0 + Math.sin(elapsed * 4.4 + slot.index) * 0.14;
        slot.trophyHaloMesh.scale.setScalar(pulse);
      }

      if (slot.state === 'hostile') {
        if (slot.extremeRage && slot.rageAuraGroup) {
          slot.rageAuraGroup.visible = true;
          if (animateLimbs) {
            const auraPulse = 1.0 + Math.sin(elapsed * 12.0 + slot.index) * 0.12;
            slot.rageAuraGroup.scale.set(auraPulse, 1.0 + Math.cos(elapsed * 9.0) * 0.06, auraPulse);
            slot.rageAuraGroup.rotation.y = elapsed * 2.8;
          }
        }

        const dx = birdPos.x - slot.root.position.x;
        const dz = birdPos.z - slot.root.position.z;
        const horizDistSq = dx * dx + dz * dz;
        const desiredYaw = Math.atan2(dx, dz);

        // Smooth turn toward sparrow
        let yawDiff = desiredYaw - slot.yaw;
        while (yawDiff > Math.PI) yawDiff -= Math.PI * 2;
        while (yawDiff < -Math.PI) yawDiff += Math.PI * 2;
        slot.yaw += yawDiff * Math.min(1, dt * (slot.extremeRage ? 12.5 : 8.5));
        slot.root.rotation.y = slot.yaw;

        // If bird moved far out of combat range, return to street patrol cleanly
        const aggroRadiusSq = slot.extremeRage
          ? EXTREME_RAGE_AGGRO_RADIUS_SQ
          : HOSTILE_AGGRO_RADIUS_SQ;
        if (horizDistSq > aggroRadiusSq) {
          slot.state = 'walking';
          slot.extremeRage = false;
          if (slot.rageAuraGroup) slot.rageAuraGroup.visible = false;
          slot.gunGroup.visible = false;
          slot.muzzleFlash.visible = false;
          continue;
        }

        const horizDist = Math.sqrt(horizDistSq) || 1;
        const firingBandSq = 18 * 18;
        const advanceSpeed = horizDistSq > firingBandSq
          ? slot.walkSpeed * (slot.extremeRage ? 1.85 : 1.48)
          : 0;

        if (advanceSpeed > 0.1) {
          const inv = 1 / horizDist;
          this.moveHumanXZ(slot, dx * inv, dz * inv, advanceSpeed * dt, tramX);
          if (animateLimbs) {
            slot.gaitPhase += dt * 9.5;
            const stride = Math.sin(slot.gaitPhase) * 0.52;
            slot.legLPivot.rotation.x = stride;
            slot.legRPivot.rotation.x = -stride;
          }
        } else if (animateLimbs) {
          slot.legLPivot.rotation.x *= Math.max(0, 1 - dt * 10);
          slot.legRPivot.rotation.x *= Math.max(0, 1 - dt * 10);
        }

        if (animateLimbs) {
          const dyAim = birdPos.y - (slot.root.position.y + 6.4 * slot.scale);
          const aimPitch = Math.max(-0.95, Math.min(0.65, Math.atan2(dyAim, horizDist)));
          slot.armRPivot.rotation.set(-Math.PI * 0.5 - aimPitch, 0, 0);
          slot.armLPivot.rotation.set(-0.28, 0, -0.14);
        }

        slot.fireCooldown -= dt;
        const fireRangeSq = slot.extremeRage
          ? EXTREME_RAGE_AGGRO_RADIUS_SQ
          : HOSTILE_FIRE_RANGE_SQ;
        if (
          slot.fireCooldown <= 0 &&
          (slot.extremeRage || this.globalEnemyFireCooldown <= 0) &&
          horizDistSq <= fireRangeSq &&
          this.birdDownedTimer <= 0
        ) {
          if (slot.extremeRage) {
            slot.fireCooldown = 0.82 + Math.random() * 0.42;
          } else {
            slot.fireCooldown = majorMode
              ? 1.25 + Math.random() * 0.95
              : 1.7 + Math.random() * 1.15;
            this.globalEnemyFireCooldown = majorMode ? 0.16 : 0.28;
          }
          this.fireEnemyBullet(slot, birdPos, birdVelocity);
        }
        continue;
      }

      if (slot.state === 'crying') {
        slot.cryTimer -= dt;
        const sprintSpeed = slot.walkSpeed * 2.18;
        this.moveHumanXZ(slot, slot.fleeDirX, slot.fleeDirZ, sprintSpeed * dt, tramX);
        slot.yaw = Math.atan2(slot.fleeDirX, slot.fleeDirZ);
        slot.root.rotation.y = slot.yaw;

        if (animateLimbs) {
          slot.gaitPhase += dt * 14.5;
          const stride = Math.sin(slot.gaitPhase) * 0.76;
          slot.legLPivot.rotation.x = stride;
          slot.legRPivot.rotation.x = -stride;

          const sobTremble = Math.sin(elapsed * 18 + slot.index) * 0.34;
          slot.armLPivot.rotation.set(-2.55 + sobTremble, 0, -0.25);
          slot.armRPivot.rotation.set(-2.55 - sobTremble, 0, 0.25);

          slot.tearIconGroup.visible = true;
          slot.tearIconGroup.position.y = 5.38 + Math.sin(elapsed * 8.5) * 0.22;
          slot.tearIconGroup.rotation.y = elapsed * 3.1;
        } else {
          slot.tearIconGroup.visible = true;
        }

        if (slot.cryTimer <= 0) {
          slot.state = 'walking';
          slot.tearIconGroup.visible = false;
        }
        continue;
      } else if (slot.tearIconGroup.visible) {
        slot.tearIconGroup.visible = false;
      }

      if (slot.state === 'fleeing') {
        slot.fleeTimer -= dt;
        const speed = slot.walkSpeed * 1.78;
        this.moveHumanXZ(slot, slot.fleeDirX, slot.fleeDirZ, speed * dt, tramX);
        slot.yaw = Math.atan2(slot.fleeDirX, slot.fleeDirZ);
        slot.root.rotation.y = slot.yaw;

        if (animateLimbs) {
          slot.gaitPhase += dt * 12.5;
          const stride = Math.sin(slot.gaitPhase) * 0.68;
          slot.legLPivot.rotation.x = stride;
          slot.legRPivot.rotation.x = -stride;
          const panicWave = Math.sin(elapsed * 14 + slot.index) * 0.45;
          slot.armLPivot.rotation.set(-2.3 + panicWave, 0, -0.35);
          slot.armRPivot.rotation.set(-2.3 - panicWave, 0, 0.35);
        }

        if (slot.fleeTimer <= 0) {
          slot.state = 'walking';
        }
        continue;
      }

      // Admired shoulder-perched state: NPC stops walking, waves happily, and displays floating heart icon
      if (i === currentPerchedSlotIdx) {
        slot.heartIconGroup.visible = true;
        slot.heartIconGroup.position.y = 5.25 + Math.sin(elapsed * 4.2) * 0.22;
        slot.heartIconGroup.rotation.y = elapsed * 2.4;

        slot.legLPivot.rotation.x *= Math.max(0, 1 - dt * 10);
        slot.legRPivot.rotation.x *= Math.max(0, 1 - dt * 10);

        const wave = Math.sin(elapsed * 7.5) * 0.36;
        if (perchedSide < 0) {
          slot.armRPivot.rotation.set(-2.15 + wave, 0, 0.28);
          slot.armLPivot.rotation.set(-0.22, 0, -0.12);
        } else {
          slot.armLPivot.rotation.set(-2.15 + wave, 0, -0.28);
          slot.armRPivot.rotation.set(-0.22, 0, 0.12);
        }

        this.sparkleTimer -= dt;
        if (this.sparkleTimer <= 0) {
          this.sparkleTimer = 0.85;
          _burstPos.set(birdPos.x, birdPos.y + 0.35, birdPos.z);
          this.fx.spawnBurst(_burstPos, 4, true, 1.8);
        }
        continue;
      } else if (slot.heartIconGroup.visible) {
        slot.heartIconGroup.visible = false;
      }

      // Linked Couple walking / standing together near parks & cafes
      if (slot.partnerIndex >= 0) {
        const partner = this.slots[slot.partnerIndex];
        const isCompanion = slot.index % 2 === 1;
        const partnerPerched = partner.index === currentPerchedSlotIdx;

        // Companion follows cleanly alongside the lead partner when lead is walking
        if (isCompanion && partner && partner.state === 'walking') {
          const rightX = Math.cos(partner.yaw);
          const rightZ = -Math.sin(partner.yaw);
          const goalX = partner.root.position.x + rightX * COUPLE_SIDE_SEPARATION;
          const goalZ = partner.root.position.z + rightZ * COUPLE_SIDE_SEPARATION;
          const toGoalX = goalX - slot.root.position.x;
          const toGoalZ = goalZ - slot.root.position.z;
          const toGoalDist = Math.hypot(toGoalX, toGoalZ);

          if (partnerPerched || partner.couplePauseTimer > 0) {
            if (toGoalDist > 0.35) {
              const stepDist = Math.min(toGoalDist, slot.walkSpeed * 1.15 * dt);
              this.moveHumanXZ(slot, toGoalX / toGoalDist, toGoalZ / toGoalDist, stepDist, tramX);
              if (animateLimbs) {
                slot.gaitPhase += dt * slot.walkSpeed * 1.4;
                const stride = Math.sin(slot.gaitPhase) * 0.38;
                slot.legLPivot.rotation.x = stride;
                slot.legRPivot.rotation.x = -stride;
              }
            } else if (animateLimbs) {
              slot.legLPivot.rotation.x *= Math.max(0, 1 - dt * 10);
              slot.legRPivot.rotation.x *= Math.max(0, 1 - dt * 10);
            }
            const lookPartnerYaw = Math.atan2(
              partner.root.position.x - slot.root.position.x,
              partner.root.position.z - slot.root.position.z
            );
            let yawDiff = lookPartnerYaw - slot.yaw;
            while (yawDiff > Math.PI) yawDiff -= Math.PI * 2;
            while (yawDiff < -Math.PI) yawDiff += Math.PI * 2;
            slot.yaw += yawDiff * Math.min(1, dt * 5.0);
            slot.root.rotation.y = slot.yaw;
            if (animateLimbs) {
              const chatGesture = Math.sin(elapsed * 2.8 + slot.coupleId) * 0.14;
              slot.armLPivot.rotation.set(-0.35 + chatGesture, 0, -0.08);
              slot.armRPivot.rotation.set(-0.2 - chatGesture, 0, 0.08);
            }
          } else {
            const catchupSpeed = toGoalDist > 3.5 ? slot.walkSpeed * 1.65 : slot.walkSpeed * 1.05;
            if (toGoalDist > 0.25) {
              const stepDist = Math.min(toGoalDist, catchupSpeed * dt);
              this.moveHumanXZ(slot, toGoalX / toGoalDist, toGoalZ / toGoalDist, stepDist, tramX);
            }
            let yawDiff = partner.yaw - slot.yaw;
            while (yawDiff > Math.PI) yawDiff -= Math.PI * 2;
            while (yawDiff < -Math.PI) yawDiff += Math.PI * 2;
            slot.yaw += yawDiff * Math.min(1, dt * 7.0);
            slot.root.rotation.y = slot.yaw;

            if (animateLimbs) {
              const moveVisual = toGoalDist > 0.25 || partner.couplePauseTimer <= 0 ? 1.0 : 0.0;
              slot.gaitPhase += dt * slot.walkSpeed * 1.65 * moveVisual;
              const stride = Math.sin(slot.gaitPhase) * 0.44 * moveVisual;
              slot.legLPivot.rotation.x = stride;
              slot.legRPivot.rotation.x = -stride;
              slot.armLPivot.rotation.set(-stride * 0.72, 0, -0.06);
              slot.armRPivot.rotation.set(stride * 0.72, 0, 0.06);
            }
          }
          continue;
        }

        if (partnerPerched && !isCompanion) {
          if (animateLimbs) {
            slot.legLPivot.rotation.x *= Math.max(0, 1 - dt * 10);
            slot.legRPivot.rotation.x *= Math.max(0, 1 - dt * 10);
            const chatGesture = Math.sin(elapsed * 3.0 + slot.coupleId) * 0.16;
            slot.armLPivot.rotation.set(-0.35 + chatGesture, 0, -0.08);
            slot.armRPivot.rotation.set(-0.2 - chatGesture, 0, 0.08);
          }
          continue;
        }

        if (slot.couplePauseTimer > 0) {
          slot.couplePauseTimer = Math.max(0, slot.couplePauseTimer - dt);
          if (partner && partner.state === 'walking') {
            const lookPartnerYaw = Math.atan2(
              partner.root.position.x - slot.root.position.x,
              partner.root.position.z - slot.root.position.z
            );
            let yawDiff = lookPartnerYaw - slot.yaw;
            while (yawDiff > Math.PI) yawDiff -= Math.PI * 2;
            while (yawDiff < -Math.PI) yawDiff += Math.PI * 2;
            slot.yaw += yawDiff * Math.min(1, dt * 4.5);
            slot.root.rotation.y = slot.yaw;
          }
          if (animateLimbs) {
            slot.legLPivot.rotation.x *= Math.max(0, 1 - dt * 10);
            slot.legRPivot.rotation.x *= Math.max(0, 1 - dt * 10);
            const chatGesture = Math.sin(elapsed * 2.6 + slot.coupleId) * 0.14;
            slot.armLPivot.rotation.set(-0.28 + chatGesture, 0, -0.08);
            slot.armRPivot.rotation.set(-0.22 - chatGesture, 0, 0.08);
          }
          continue;
        }

        slot.coupleWalkTimer -= dt;
        if (slot.coupleWalkTimer <= 0) {
          slot.coupleWalkTimer = 9.0 + (slot.coupleId % 3) * 2.0;
          slot.couplePauseTimer = 3.4 + (slot.coupleId % 2) * 1.1;
          continue;
        }
      }

      // Default 'walking' patrol state across Park, Streets, Cafe & Expanded Districts
      const targetNode = WALK_GRAPH[slot.targetNodeIdx];
      const dx = targetNode.x - slot.root.position.x;
      const dz = targetNode.z - slot.root.position.z;
      const distSq = dx * dx + dz * dz;

      if (distSq < 4.2 * 4.2) {
        const arrivedIdx = slot.targetNodeIdx;
        const arrivedNode = WALK_GRAPH[arrivedIdx];
        const prevIdx = slot.currentNodeIdx;
        slot.currentNodeIdx = arrivedIdx;

        // Couples prefer staying near park/cafe nodes; solo crowd patrol everywhere
        if (slot.coupleId >= 0) {
          slot.targetNodeIdx = this.pickCoupleNeighbor(
            arrivedIdx,
            prevIdx,
            slot.index + Math.floor(elapsed)
          );
        } else {
          const neighbors = arrivedNode.neighbors;
          if (neighbors.length > 0) {
            let chosen = neighbors[(slot.index + Math.floor(elapsed * 3)) % neighbors.length];
            if (neighbors.length > 1 && chosen === prevIdx) {
              chosen = neighbors[(neighbors.indexOf(chosen) + 1) % neighbors.length];
            }
            slot.targetNodeIdx = chosen;
          } else {
            slot.targetNodeIdx = (arrivedIdx + 1) % WALK_GRAPH.length;
          }
        }
      } else {
        // Slow down gently when the bird flies slowly near shoulder height so landing is effortless
        const bdx = birdPos.x - slot.root.position.x;
        const bdz = birdPos.z - slot.root.position.z;
        const birdHorizSq = bdx * bdx + bdz * bdz;
        const nearFriendlyBird =
          this.perchCooldownTimer <= 0 &&
          !gunEquipped &&
          birdHorizSq < 6.5 * 6.5 &&
          birdPos.y > slot.root.position.y + 3.5 &&
          birdPos.y < slot.root.position.y + 11.5;
        const speedMul = nearFriendlyBird ? 0.28 : 1.0;

        const dist = Math.sqrt(distSq);
        const dirX = dx / dist;
        const dirZ = dz / dist;
        this.moveHumanXZ(slot, dirX, dirZ, slot.walkSpeed * speedMul * dt, tramX);

        const desiredYaw = Math.atan2(dirX, dirZ);
        let yawDiff = desiredYaw - slot.yaw;
        while (yawDiff > Math.PI) yawDiff -= Math.PI * 2;
        while (yawDiff < -Math.PI) yawDiff += Math.PI * 2;
        slot.yaw += yawDiff * Math.min(1, dt * 6.5);
        slot.root.rotation.y = slot.yaw;

        if (animateLimbs) {
          slot.gaitPhase += dt * slot.walkSpeed * speedMul * 1.65;
          const stride = Math.sin(slot.gaitPhase) * 0.46 * speedMul;
          slot.legLPivot.rotation.x = stride;
          slot.legRPivot.rotation.x = -stride;
          if (slot.hasTrophyCart) {
            // Hold arms outstretched forward pushing the cart handles
            slot.armLPivot.rotation.set(-0.92, 0, -0.05);
            slot.armRPivot.rotation.set(-0.92, 0, 0.05);
          } else {
            slot.armLPivot.rotation.set(-stride * 0.72, 0, -0.06);
            slot.armRPivot.rotation.set(stride * 0.72, 0, 0.06);
          }
        }
      }
    }

    // 2. Step pooled enemy bullets and floating Respect/XP orbs
    this.stepEnemyBullets(dt, birdPos);
    this.stepRespectOrbs(dt, elapsed, birdPos);
  }

  public findIntimidateCandidate(birdPos: THREE.Vector3, camera: THREE.Camera): number {
    camera.getWorldDirection(_camFwd);
    let bestIdx = -1;
    let bestScore = Infinity;

    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i];
      if (slot.state !== 'fleeing' && slot.state !== 'crying') continue;
      if (slot.intimidateCooldown > 0) continue;

      const dx = slot.root.position.x - birdPos.x;
      const dy = slot.root.position.y + 4.8 * slot.scale - birdPos.y;
      const dz = slot.root.position.z - birdPos.z;
      const distSq = dx * dx + dy * dy + dz * dz;
      if (distSq > INTIMIDATE_RANGE_SQ) continue;

      const dist = Math.sqrt(distSq) || 0.01;
      const aimDot = (dx * _camFwd.x + dy * _camFwd.y + dz * _camFwd.z) / dist;
      // Favor targets aimed closely along the crosshair OR right next to Birdy (< 9 SU)
      if (aimDot < 0.25 && distSq > 9 * 9) continue;

      const score = dist - Math.max(0, aimDot) * 8.5;
      if (score < bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    return bestIdx;
  }

  /**
   * 'E'-key Intimidation / Extortion while gun is equipped and flying close to a fleeing NPC:
   * frightens them into dropping bonus Respect/XP without needing to shoot them.
   */
  public tryIntimidate(birdPos: THREE.Vector3, camera: THREE.Camera): boolean {
    const idx = this.findIntimidateCandidate(birdPos, camera);
    if (idx < 0) return false;

    const slot = this.slots[idx];
    slot.intimidateCooldown = INTIMIDATE_NPC_COOLDOWN;
    slot.fleeTimer = Math.max(slot.fleeTimer, 5.5);

    const mul = this.respectMultiplierFn ? Math.max(1, this.respectMultiplierFn(slot.root.position)) : 1;
    const respectGained = Math.round(INTIMIDATE_RESPECT_XP * mul);
    this.respectXp += respectGained;

    const orb = this.respectOrbs[this.respectOrbCursor];
    this.respectOrbCursor = (this.respectOrbCursor + 1) % this.respectOrbs.length;

    const dropX = slot.root.position.x;
    const dropY = slot.root.position.y + 5.2 * slot.scale;
    const dropZ = slot.root.position.z;
    orb.active = true;
    orb.age = 0;
    orb.pos.set(dropX, dropY, dropZ);
    const toBirdX = birdPos.x - dropX;
    const toBirdZ = birdPos.z - dropZ;
    const hLen = Math.hypot(toBirdX, toBirdZ) || 1;
    orb.vel.set((toBirdX / hLen) * 3.5, 6.8, (toBirdZ / hLen) * 3.5);
    orb.mesh.position.copy(orb.pos);
    orb.mesh.scale.setScalar(1.0);
    orb.mesh.visible = true;

    _burstPos.set(dropX, dropY + 1.8, dropZ);
    this.fx.spawnBurst(_burstPos, 10, true, 4.0);
    this.audio.playHumanYell(_burstPos, Math.min(1.42, slot.voicePitch * 1.15), 'shoo');
    this.audio.playSparrowMicroChirp('mischief');

    this.events.emit('crowd:intimidated', {
      slotIndex: slot.index,
      respectGained,
      totalRespect: this.respectXp,
    });
    return true;
  }

  private stepRespectOrbs(dt: number, elapsed: number, birdPos: THREE.Vector3): void {
    for (let i = 0; i < this.respectOrbs.length; i++) {
      const orb = this.respectOrbs[i];
      if (!orb.active) continue;

      orb.age += dt;
      if (orb.age < 0.28) {
        orb.vel.y -= 14.0 * dt;
        orb.pos.addScaledVector(orb.vel, dt);
      } else {
        // Magnetically zip into Birdy cleanly
        _toNpc.subVectors(birdPos, orb.pos);
        const dist = _toNpc.length();
        if (dist < 1.35 || orb.age > 2.2) {
          orb.active = false;
          orb.mesh.visible = false;
          this.fx.spawnBurst(birdPos, 5, true, 2.2);
          continue;
        }
        _toNpc.divideScalar(dist);
        const pullSpeed = Math.min(48.0, 22.0 + orb.age * 28.0);
        orb.pos.addScaledVector(_toNpc, pullSpeed * dt);
      }

      const pulse = 1.0 + Math.sin(elapsed * 10.0 + i) * 0.16;
      orb.mesh.position.copy(orb.pos);
      orb.mesh.rotation.y = elapsed * 4.5;
      orb.mesh.scale.setScalar(pulse);
    }
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    for (let i = 0; i < this.styleGeos.length; i++) {
      this.styleGeos[i].torsoHeadGeo.dispose();
      this.styleGeos[i].armGeo.dispose();
      this.styleGeos[i].legGeo.dispose();
    }
    for (let i = 0; i < this.prewarmGeos.length; i++) {
      this.prewarmGeos[i].dispose();
    }
    this.pistolGeo.dispose();
    this.heartGeo.dispose();
    this.tearGeo.dispose();
    this.cartGeo.dispose();
    this.trophyGeo.dispose();
    this.trophyHaloGeo.dispose();
    this.rageAuraBodyGeo.dispose();
    this.rageAuraRingGeo.dispose();
    this.respectOrbGeo.dispose();
    this.muzzleGeo.dispose();
    this.shadowGeo.dispose();
    this.enemyBulletGeo.dispose();

    this.shadowMat.dispose();
    this.muzzleMat.dispose();
    this.enemyBulletMat.dispose();
    this.trophyHaloMat.dispose();
    this.rageAuraMat.dispose();
    this.respectOrbMat.dispose();
    for (let i = 0; i < this.ragdollMatPool.length; i++) {
      this.ragdollMatPool[i].dispose();
    }

    this.scene.remove(this.group);
  }
}
