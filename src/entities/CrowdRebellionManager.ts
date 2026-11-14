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

export const CROWD_POOL_SIZE = 45;
export const MAX_ACTIVE_RAGDOLLS = 15;
export const BIRD_MAX_HEALTH = 100;

const RAGDOLL_DURATION = 3.0;
const RAGDOLL_FADE_START = 2.2;
const ENEMY_BULLET_POOL_SIZE = 40;
const ENEMY_BULLET_SPEED = 66.0;
const ENEMY_BULLET_MAX_AGE = 2.35;
const ENEMY_BULLET_DAMAGE = 10;
const BIRD_HURT_RADIUS = 0.72;
const SHOT_ALERT_RADIUS_SQ = 76 * 76;
const HOSTILE_AGGRO_RADIUS_SQ = 96 * 96;
const HOSTILE_FIRE_RANGE_SQ = 82 * 82;
const MAJOR_REBELLION_KILL_THRESHOLD = 20;
const ESCALATION_KILL_THRESHOLD = 5;

type CrowdArea = 'park' | 'street' | 'cafe';
type CrowdState = 'walking' | 'fleeing' | 'hostile' | 'ragdoll';

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
  shadowDisc: THREE.Mesh;
  scale: number;
  baseHipY: number;
  voicePitch: number;
  state: CrowdState;
  rolledTier: 0 | 1 | 2;
  yaw: number;
  walkSpeed: number;
  gaitPhase: number;
  groundY: number;
  currentNodeIdx: number;
  targetNodeIdx: number;
  fleeDirX: number;
  fleeDirZ: number;
  fleeTimer: number;
  fireCooldown: number;
  muzzleFlashTimer: number;
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

export interface CrowdBulletHitCandidate {
  slotIndex: number;
  distance: number;
  point: THREE.Vector3;
}

// Module-level scratch vectors to avoid per-frame allocations inside 60 FPS loops
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
  { x: -16, z: 106, area: 'street', neighbors: [9, 17] },
  { x: -94, z: 90, area: 'cafe', neighbors: [13] },

  // 16..21: Upper Avenue & NE Botanical Park West/North Paths
  { x: -46, z: 16, area: 'street', neighbors: [0, 29] },
  { x: 16, z: 106, area: 'street', neighbors: [14, 18, 20] },
  { x: 16, z: 54, area: 'street', neighbors: [1, 17, 19] },
  { x: 24, z: 26, area: 'park', neighbors: [18, 20, 21, 26] },
  { x: 24, z: 84, area: 'park', neighbors: [17, 19, 32] },
  { x: 52, z: 24, area: 'park', neighbors: [19, 33] },

  // 22..25: SE Farmers' Market & Plaza
  { x: 30, z: -28, area: 'cafe', neighbors: [3, 23, 27] },
  { x: 42, z: -56, area: 'cafe', neighbors: [5, 22, 24, 25] },
  { x: 70, z: -80, area: 'cafe', neighbors: [7, 23, 25] },
  { x: 42, z: -82, area: 'cafe', neighbors: [5, 23, 24] },

  // 26..31: E/W Boulevards & SW Canal Quays (strictly clear of sunken canal trench)
  { x: 52, z: 16, area: 'street', neighbors: [1, 19, 27] },
  { x: 86, z: 16, area: 'street', neighbors: [22, 26, 33] },
  { x: -48, z: -16, area: 'street', neighbors: [2, 29] },
  { x: -88, z: 16, area: 'street', neighbors: [16, 28] },
  { x: -56, z: -34, area: 'cafe', neighbors: [36, 34] },
  { x: -54, z: -74, area: 'cafe', neighbors: [37, 35] },

  // 32..37: NE Park Outer Loop, Canal Bridge Approaches & Quays
  { x: 78, z: 84, area: 'park', neighbors: [20, 33] },
  { x: 82, z: 48, area: 'park', neighbors: [21, 27, 32] },
  { x: -86, z: -34, area: 'cafe', neighbors: [30] },
  { x: -84, z: -76, area: 'cafe', neighbors: [31] },
  { x: -16, z: -34, area: 'street', neighbors: [2, 4, 30] },
  { x: -16, z: -74, area: 'street', neighbors: [4, 6, 31] },
];

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
  private readonly ragdollMatPool: THREE.MeshLambertNodeMaterial[] = [];

  private readonly styleGeos: CrowdStyleGeometries[] = [];
  private readonly pistolGeo: THREE.BufferGeometry;
  private readonly muzzleGeo: THREE.BufferGeometry;
  private readonly shadowGeo: THREE.BufferGeometry;
  private readonly enemyBulletGeo: THREE.BufferGeometry;
  private readonly prewarmGeos: THREE.BufferGeometry[] = [];
  private readonly prewarmMeshes: THREE.Mesh[] = [];

  private readonly slots: CrowdHumanSlot[] = [];
  private readonly activeRagdollQueue: number[] = [];
  private readonly freeRagdollMatIndices: number[] = [];
  private readonly enemyBullets: EnemyBulletSlot[] = [];
  private enemyBulletCursor = 0;

  private kills = 0;
  private birdHp = BIRD_MAX_HEALTH;
  private birdInvulnTimer = 0;
  private birdDownedTimer = 0;
  private mode: RebellionMode = 'peaceful';
  private screamCooldown = 0;
  private globalEnemyFireCooldown = 0;
  private hitSfxCooldown = 0;
  private disposed = false;

  constructor(
    private readonly scene: THREE.Scene,
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

    for (let i = 0; i < CROWD_STYLES.length; i++) {
      this.styleGeos.push(buildStyleGeometries(CROWD_STYLES[i]));
    }
    this.pistolGeo = buildEnemyPistolGeometry();
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
  }

  public getKills(): number {
    return this.kills;
  }

  public getBirdHp(): number {
    return this.birdHp;
  }

  public getMode(): RebellionMode {
    return this.mode;
  }

  public getHostileChance(): number {
    if (this.kills >= MAJOR_REBELLION_KILL_THRESHOLD) return 0.4;
    if (this.kills >= ESCALATION_KILL_THRESHOLD) return 0.1;
    return 0.0;
  }

  public getActiveRagdollCount(): number {
    return this.activeRagdollQueue.length;
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

    // Pick initial distributed node across WALK_GRAPH
    const nodeIdx = (index * 7) % WALK_GRAPH.length;
    const node = WALK_GRAPH[nodeIdx];
    const nextIdx =
      node.neighbors.length > 0
        ? node.neighbors[index % node.neighbors.length]
        : (nodeIdx + 1) % WALK_GRAPH.length;
    const targetNode = WALK_GRAPH[nextIdx];

    // Small lateral sidewalk spread so multiple walkers look natural
    const jitterAngle = (index * 2.39996) % (Math.PI * 2);
    const jitterR = 1.4 + (index % 3) * 1.15;
    const spawnX = node.x + Math.cos(jitterAngle) * jitterR;
    const spawnZ = node.z + Math.sin(jitterAngle) * jitterR;
    const groundY = this.sampleWalkGroundY(spawnX, spawnZ);
    const yaw = Math.atan2(targetNode.x - spawnX, targetNode.z - spawnZ);

    root.position.set(spawnX, groundY, spawnZ);
    root.rotation.y = yaw;

    return {
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
      shadowDisc,
      scale,
      baseHipY,
      voicePitch: 0.8 + ((index * 19) % 15) * 0.032,
      state: 'walking',
      rolledTier: 0,
      yaw,
      walkSpeed: 4.1 + ((index * 11) % 7) * 0.32,
      gaitPhase: (index * 1.17) % (Math.PI * 2),
      groundY,
      currentNodeIdx: nodeIdx,
      targetNodeIdx: nextIdx,
      fleeDirX: 0,
      fleeDirZ: 1,
      fleeTimer: 0,
      fireCooldown: 0.7 + ((index * 13) % 10) * 0.18,
      muzzleFlashTimer: 0,
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

    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i];
      if (slot.state === 'ragdoll') continue;

      const rx = slot.root.position.x;
      const ry = slot.root.position.y;
      const rz = slot.root.position.z;
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
        _hitPtScratch.set(cx, cy, cz);
      }
    }

    if (bestIndex < 0) return null;
    return {
      slotIndex: bestIndex,
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
  }

  /**
   * Called whenever the player fires their pistol (`gun:fired`).
   * - Below 5 kills: nearby NPCs scream and flee.
   * - At >= 5 kills: nearby NPCs roll 10% chance to turn hostile and shoot back.
   * - At >= 20 kills (MAJOR REBELLION): nearby/remaining NPCs roll to reach 40% hostile fighters.
   */
  public onPlayerShot(shotPos: THREE.Vector3, birdPos: THREE.Vector3): void {
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
      if (slot.state === 'ragdoll') continue;

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
    slot.gunGroup.visible = false;
    slot.muzzleFlash.visible = false;
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
    slot.currentNodeIdx = nodeIdx;
    slot.targetNodeIdx = nextIdx;
    slot.groundY = gy;
    slot.yaw = yaw;
    slot.fleeTimer = 0;
    slot.ragdollTimer = 0;
    slot.gunGroup.visible = false;
    slot.muzzleFlash.visible = false;
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

  private fireEnemyBullet(slot: CrowdHumanSlot, birdPos: THREE.Vector3): void {
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

    const bullet = this.enemyBullets[this.enemyBulletCursor];
    this.enemyBulletCursor = (this.enemyBulletCursor + 1) % this.enemyBullets.length;

    // Slight fair angular spread so an airborne, weaving sparrow can dodge gunfire
    const spreadX = (Math.random() - 0.5) * 0.085;
    const spreadY = (Math.random() - 0.5) * 0.065;
    const spreadZ = (Math.random() - 0.5) * 0.085;
    _bulletDir.set(
      _bulletDir.x + spreadX,
      _bulletDir.y + spreadY,
      _bulletDir.z + spreadZ
    ).normalize();

    bullet.active = true;
    bullet.age = 0;
    bullet.pos.copy(_muzzleWorld);
    bullet.prevPos.copy(_muzzleWorld);
    bullet.vel.copy(_bulletDir).multiplyScalar(ENEMY_BULLET_SPEED);
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
    this.birdHp = Math.max(0, this.birdHp - ENEMY_BULLET_DAMAGE);
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

  private stepEnemyBullets(dt: number, birdPos: THREE.Vector3): void {
    for (let i = 0; i < this.enemyBullets.length; i++) {
      const b = this.enemyBullets[i];
      if (!b.active) continue;

      b.age += dt;
      if (
        b.age >= ENEMY_BULLET_MAX_AGE ||
        Math.abs(b.pos.x) > 220 ||
        Math.abs(b.pos.z) > 220 ||
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
    let moveX = dirX;
    let moveZ = dirZ;

    // Lightweight waist-height obstacle whisker so NPCs slide smoothly around walls, benches & stalls
    _losOrigin.set(slot.root.position.x, slot.root.position.y + 3.2, slot.root.position.z);
    _losDir.set(moveX, 0, moveZ);
    const wall = this.physics.raycastGround(
      _losOrigin,
      _losDir,
      2.1 + dist,
      undefined,
      _losHit,
      COLLISION_GROUP_STATIC
    );
    if (wall.hit && wall.normal.y < 0.55) {
      const dot = moveX * wall.normal.x + moveZ * wall.normal.z;
      if (dot < 0) {
        moveX -= wall.normal.x * dot;
        moveZ -= wall.normal.z * dot;
        const nLen = Math.hypot(moveX, moveZ);
        if (nLen > 0.05) {
          moveX /= nLen;
          moveZ /= nLen;
        } else {
          // Turn cleanly perpendicular if dead-on into a flat facade
          moveX = -wall.normal.z;
          moveZ = wall.normal.x;
        }
        if (slot.state === 'fleeing') {
          slot.fleeDirX = moveX;
          slot.fleeDirZ = moveZ;
        }
      }
    }

    let nx = slot.root.position.x + moveX * dist;
    let nz = slot.root.position.z + moveZ * dist;

    // World bounds clamp
    if (nx < -152) nx = -152;
    if (nx > 152) nx = 152;
    if (nz < -152) nz = -152;
    if (nz > 152) nz = 152;

    // Avoid tram corridor hazard at z ≈ 0
    if (Math.abs(nz) < 4.8 && Math.abs(nx - tramX) < 19.0) {
      nz += nz >= 0 ? dist * 1.4 : -dist * 1.4;
    }

    // Reject moves into restricted water basins / central fountain
    if (this.isInsideRestrictedArea(nx, nz)) {
      if (slot.state === 'fleeing') {
        const tmp = slot.fleeDirX;
        slot.fleeDirX = -slot.fleeDirZ;
        slot.fleeDirZ = tmp;
      }
      return;
    }

    slot.root.position.x = nx;
    slot.root.position.z = nz;
  }

  public update(
    dt: number,
    elapsed: number,
    birdPos: THREE.Vector3,
    camera: THREE.Camera,
    tramX: number
  ): void {
    if (this.disposed) return;

    if (this.screamCooldown > 0) this.screamCooldown = Math.max(0, this.screamCooldown - dt);
    if (this.globalEnemyFireCooldown > 0) {
      this.globalEnemyFireCooldown = Math.max(0, this.globalEnemyFireCooldown - dt);
    }
    if (this.hitSfxCooldown > 0) this.hitSfxCooldown = Math.max(0, this.hitSfxCooldown - dt);
    if (this.birdInvulnTimer > 0) this.birdInvulnTimer = Math.max(0, this.birdInvulnTimer - dt);

    // Non-blocking downed recovery timer so game never soft-locks
    if (this.birdDownedTimer > 0) {
      this.birdDownedTimer = Math.max(0, this.birdDownedTimer - dt);
      if (this.birdDownedTimer <= 0) {
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

    // 1. Update all 45 pooled crowd NPCs
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i];

      if (slot.muzzleFlashTimer > 0) {
        slot.muzzleFlashTimer = Math.max(0, slot.muzzleFlashTimer - dt);
        if (slot.muzzleFlashTimer <= 0) {
          slot.muzzleFlash.visible = false;
        }
      }

      if (slot.state === 'ragdoll') {
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

      if (slot.state === 'hostile') {
        const dx = birdPos.x - slot.root.position.x;
        const dz = birdPos.z - slot.root.position.z;
        const horizDistSq = dx * dx + dz * dz;
        const desiredYaw = Math.atan2(dx, dz);

        // Smooth turn toward sparrow
        let yawDiff = desiredYaw - slot.yaw;
        while (yawDiff > Math.PI) yawDiff -= Math.PI * 2;
        while (yawDiff < -Math.PI) yawDiff += Math.PI * 2;
        slot.yaw += yawDiff * Math.min(1, dt * 8.5);
        slot.root.rotation.y = slot.yaw;

        // If bird moved far out of combat range (>96 SU), return to street patrol cleanly
        if (horizDistSq > HOSTILE_AGGRO_RADIUS_SQ) {
          slot.state = 'walking';
          slot.gunGroup.visible = false;
          slot.muzzleFlash.visible = false;
          continue;
        }

        const horizDist = Math.sqrt(horizDistSq) || 1;
        const firingBandSq = 18 * 18;
        const advanceSpeed = horizDistSq > firingBandSq ? slot.walkSpeed * 1.48 : 0;

        if (advanceSpeed > 0.1) {
          const inv = 1 / horizDist;
          this.moveHumanXZ(slot, dx * inv, dz * inv, advanceSpeed * dt, tramX);
          slot.gaitPhase += dt * 9.5;
          const stride = Math.sin(slot.gaitPhase) * 0.52;
          slot.legLPivot.rotation.x = stride;
          slot.legRPivot.rotation.x = -stride;
        } else {
          slot.legLPivot.rotation.x *= Math.max(0, 1 - dt * 10);
          slot.legRPivot.rotation.x *= Math.max(0, 1 - dt * 10);
        }

        // Raise gun arm toward the bird's altitude
        const dyAim = birdPos.y - (slot.root.position.y + 6.4 * slot.scale);
        const aimPitch = Math.max(-0.95, Math.min(0.65, Math.atan2(dyAim, horizDist)));
        slot.armRPivot.rotation.set(-Math.PI * 0.5 - aimPitch, 0, 0);
        slot.armLPivot.rotation.set(-0.28, 0, -0.14);

        slot.fireCooldown -= dt;
        if (
          slot.fireCooldown <= 0 &&
          this.globalEnemyFireCooldown <= 0 &&
          horizDistSq <= HOSTILE_FIRE_RANGE_SQ &&
          this.birdDownedTimer <= 0
        ) {
          slot.fireCooldown = majorMode
            ? 1.25 + Math.random() * 0.95
            : 1.7 + Math.random() * 1.15;
          this.globalEnemyFireCooldown = majorMode ? 0.16 : 0.28;
          this.fireEnemyBullet(slot, birdPos);
        }
        continue;
      }

      if (slot.state === 'fleeing') {
        slot.fleeTimer -= dt;
        const speed = slot.walkSpeed * 1.78;
        this.moveHumanXZ(slot, slot.fleeDirX, slot.fleeDirZ, speed * dt, tramX);
        slot.yaw = Math.atan2(slot.fleeDirX, slot.fleeDirZ);
        slot.root.rotation.y = slot.yaw;

        slot.gaitPhase += dt * 12.5;
        const stride = Math.sin(slot.gaitPhase) * 0.68;
        slot.legLPivot.rotation.x = stride;
        slot.legRPivot.rotation.x = -stride;
        // Flail arms overhead in panic
        const panicWave = Math.sin(elapsed * 14 + slot.index) * 0.45;
        slot.armLPivot.rotation.set(-2.3 + panicWave, 0, -0.35);
        slot.armRPivot.rotation.set(-2.3 - panicWave, 0, 0.35);

        if (slot.fleeTimer <= 0) {
          slot.state = 'walking';
        }
        continue;
      }

      // Default 'walking' patrol state across Park, Streets & Cafe areas
      const targetNode = WALK_GRAPH[slot.targetNodeIdx];
      const dx = targetNode.x - slot.root.position.x;
      const dz = targetNode.z - slot.root.position.z;
      const distSq = dx * dx + dz * dz;

      if (distSq < 4.2 * 4.2) {
        const arrivedIdx = slot.targetNodeIdx;
        const arrivedNode = WALK_GRAPH[arrivedIdx];
        const prevIdx = slot.currentNodeIdx;
        slot.currentNodeIdx = arrivedIdx;

        // Choose a neighbor (prefer not turning straight back unless dead-end)
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
      } else {
        const dist = Math.sqrt(distSq);
        const dirX = dx / dist;
        const dirZ = dz / dist;
        this.moveHumanXZ(slot, dirX, dirZ, slot.walkSpeed * dt, tramX);

        const desiredYaw = Math.atan2(dirX, dirZ);
        let yawDiff = desiredYaw - slot.yaw;
        while (yawDiff > Math.PI) yawDiff -= Math.PI * 2;
        while (yawDiff < -Math.PI) yawDiff += Math.PI * 2;
        slot.yaw += yawDiff * Math.min(1, dt * 6.5);
        slot.root.rotation.y = slot.yaw;

        slot.gaitPhase += dt * slot.walkSpeed * 1.65;
        const stride = Math.sin(slot.gaitPhase) * 0.46;
        slot.legLPivot.rotation.x = stride;
        slot.legRPivot.rotation.x = -stride;
        slot.armLPivot.rotation.set(-stride * 0.72, 0, -0.06);
        slot.armRPivot.rotation.set(stride * 0.72, 0, 0.06);
      }
    }

    // 2. Step pooled enemy bullets
    this.stepEnemyBullets(dt, birdPos);
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
    this.muzzleGeo.dispose();
    this.shadowGeo.dispose();
    this.enemyBulletGeo.dispose();

    this.shadowMat.dispose();
    this.muzzleMat.dispose();
    this.enemyBulletMat.dispose();
    for (let i = 0; i < this.ragdollMatPool.length; i++) {
      this.ragdollMatPool[i].dispose();
    }

    this.scene.remove(this.group);
  }
}
