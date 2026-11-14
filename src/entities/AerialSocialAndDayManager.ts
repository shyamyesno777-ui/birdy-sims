import * as THREE from 'three/webgpu';
import { PALETTE } from '../rendering/Palette.ts';
import {
  createPastelMaterial,
  createUnlitPastelFXMaterial,
  SHARED_NPC_LAMBERT_MAT,
} from '../rendering/StorybookMaterial.ts';
import {
  rbox,
  rcyl,
  smoothSphere,
  extrudeShape,
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
import type { EventBus, GameEventMap } from '../core/EventBus.ts';
import type { EnvironmentController } from '../environment/EnvironmentController.ts';

export const NEUTRAL_PERCH_BIRD_COUNT = 10;
export const RIVAL_INVADER_COUNT = 15;
export const MAX_RIVAL_POOL = 20;
export const MAX_KARMA_DEFENDERS = 12;
export const DAY_DURATION_SECONDS = 90.0;
export const INVASION_DURATION_SECONDS = 60.0;
export const MAX_DAYS = 5;
export const BEFRIEND_HOLD_SECONDS = 1.0;
export const COURT_MIN_LEVEL = 5;
export const COURT_SUCCESS_CHANCE = 0.2; // Exact 1-in-5 (20%) check
export const BACKUP_DURATION_SECONDS = 45.0;
export const XP_PER_LEVEL = 100;

export const MAX_ACTIVE_BULLETS = 50;
const AERIAL_BULLET_POOL_SIZE = 50;
const CRUMB_POOL_SIZE = 32;
const AERIAL_BULLET_MAX_AGE = 2.1;
const ENEMY_BULLET_SPEED = 58.0;
const ALLY_BULLET_SPEED = 86.0;
const BIRD_HURT_RADIUS = 0.72;
const AERIAL_ENEMY_DAMAGE = 8;
const COURT_RANGE_SQ = 15.5 * 15.5;
const PEACEFUL_KARMA_RANGE_SQ = 13.0 * 13.0;
const BIRD_HIT_RADIUS_SQ = 0.85 * 0.85;

type PerchBirdState = 'neutral' | 'ally' | 'hostile' | 'defeated';

interface BirdRigMeshes {
  root: THREE.Group;
  bodyGroup: THREE.Group;
  wingL: THREE.Group;
  wingR: THREE.Group;
  pistolGroup: THREE.Group;
  heartGroup: THREE.Group;
  sunglassesGroup: THREE.Group;
  muzzleFlash: THREE.Mesh;
}

interface PerchBirdSlot {
  id: string;
  index: number;
  name: string;
  perchPos: THREE.Vector3;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  yaw: number;
  state: PerchBirdState;
  isGf: boolean;
  hp: number;
  orbitAngle: number;
  orbitRadius: number;
  orbitHeight: number;
  fireCooldown: number;
  muzzleTimer: number;
  peacefulKarmaCooldown: number;
  flapPhase: number;
  rig: BirdRigMeshes;
}

type RivalAttackState = 'flocking' | 'swooping' | 'retreating';

interface RivalInvaderSlot {
  index: number;
  active: boolean;
  hp: number;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  yaw: number;
  attackState: RivalAttackState;
  attackCooldown: number;
  swoopTimer: number;
  hasFiredInSwoop: boolean;
  wanderPhase: number;
  muzzleTimer: number;
  flapPhase: number;
  rig: BirdRigMeshes;
}

interface KarmaDefenderSlot {
  index: number;
  active: boolean;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  yaw: number;
  orbitAngle: number;
  fireCooldown: number;
  muzzleTimer: number;
  flapPhase: number;
  rig: BirdRigMeshes;
}

interface AerialBulletSlot {
  active: boolean;
  owner: 'enemy' | 'ally';
  age: number;
  pos: THREE.Vector3;
  prevPos: THREE.Vector3;
  vel: THREE.Vector3;
  mesh: THREE.Mesh;
}

interface CrumbSlot {
  active: boolean;
  age: number;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  settled: boolean;
  mesh: THREE.Mesh;
}

export interface AerialContactEntry {
  id: string;
  slotIndex: number;
  label: string;
  role: 'GF' | 'Ally';
}

export interface AerialBulletHitCandidate {
  kind: 'perch' | 'rival' | 'scout';
  index: number;
  distance: number;
  point: THREE.Vector3;
}

// Reusable scratch vectors (zero allocations inside 60 FPS update loop)
const _downVec = new THREE.Vector3(0, -1, 0);
const _probeStart = new THREE.Vector3();
const _groundHit = createGroundRaycastHit();
const _bulletWallHit = createGroundRaycastHit();
const _segDir = new THREE.Vector3();
const _toTarget = new THREE.Vector3();
const _hitPtScratch = new THREE.Vector3();
const _bulletNext = new THREE.Vector3();
const _bulletRayDir = new THREE.Vector3();
const _bulletToBird = new THREE.Vector3();
const _bulletClosest = new THREE.Vector3();
const _desiredPos = new THREE.Vector3();
const _toDesired = new THREE.Vector3();
const _shootOrigin = new THREE.Vector3();
const _shootDir = new THREE.Vector3();
const _boidSep = new THREE.Vector3();
const _boidAlign = new THREE.Vector3();
const _boidCohes = new THREE.Vector3();
const _boidSteer = new THREE.Vector3();
const _boidDiff = new THREE.Vector3();
const _flockAnchor = new THREE.Vector3();
const _swoopTarget = new THREE.Vector3();

const NEUTRAL_PLUMAGE_HEXES: readonly number[] = [
  PALETTE.birdBlueTit,
  PALETTE.birdGoldfinch,
  PALETTE.birdRoseFinch,
  PALETTE.birdMintWarbler,
  PALETTE.birdRobinBreast,
];

const CONTACT_NAMES: readonly string[] = [
  'Pippa',
  'Colette',
  'Giselle',
  'Benoit',
  'Margaux',
  'Remy',
  'Noemie',
  'Camille',
  'Soren',
  'Lorette',
];

function buildSongbirdBodyGeometry(bodyHex: number, breastHex: number, crestHex?: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [
    // Torso
    transformGeo(smoothSphere(0.24, bodyHex, 12, 10, [0.85, 0.9, 1.32]), { pos: [0, 0.24, 0] }),
    // Plump breast highlight
    transformGeo(smoothSphere(0.19, breastHex, 10, 8, [0.88, 0.92, 0.95]), {
      pos: [0, 0.21, 0.1],
    }),
    // Head
    transformGeo(smoothSphere(0.155, bodyHex, 12, 10, [0.96, 0.94, 1.02]), {
      pos: [0, 0.44, 0.16],
    }),
    // Beak
    transformGeo(rcyl(0.01, 0.048, 0.14, PALETTE.croissantButter, 7), {
      rot: [Math.PI * 0.5, 0, 0],
      pos: [0, 0.43, 0.34],
    }),
    // Eyes
    transformGeo(smoothSphere(0.025, PALETTE.ironworkPlum, 6, 6), { pos: [-0.09, 0.47, 0.26] }),
    transformGeo(smoothSphere(0.025, PALETTE.ironworkPlum, 6, 6), { pos: [0.09, 0.47, 0.26] }),
    // Tail fan
    transformGeo(rbox(0.16, 0.03, 0.34, 0.012, PALETTE.sparrowWingTip), {
      rot: [0.22, 0, 0],
      pos: [0, 0.25, -0.34],
    }),
    // Tiny legs
    transformGeo(rcyl(0.015, 0.015, 0.14, PALETTE.sparrowLeg, 6), { pos: [-0.06, 0.07, 0] }),
    transformGeo(rcyl(0.015, 0.015, 0.14, PALETTE.sparrowLeg, 6), { pos: [0.06, 0.07, 0] }),
  ];

  if (crestHex !== undefined) {
    parts.push(
      transformGeo(rcyl(0.01, 0.065, 0.15, crestHex, 7), {
        rot: [-0.4, 0, 0],
        pos: [0, 0.58, 0.12],
      })
    );
  }
  return mergeParts(parts);
}

function buildSongbirdWingGeometry(wingHex: number, side: -1 | 1): THREE.BufferGeometry {
  return transformGeo(rbox(0.28, 0.032, 0.18, 0.014, wingHex), {
    pos: [side * 0.15, 0, -0.02],
  });
}

function buildTinyPistolGeometry(): THREE.BufferGeometry {
  return mergeParts([
    // Barrel & slide
    transformGeo(rbox(0.05, 0.06, 0.26, 0.015, PALETTE.ironworkPlum), { pos: [0, 0.03, 0.1] }),
    // Grip
    transformGeo(rbox(0.042, 0.11, 0.065, 0.012, PALETTE.woodWalnut), {
      rot: [0.28, 0, 0],
      pos: [0, -0.04, 0.01],
    }),
    // Brass sight tip
    transformGeo(rbox(0.025, 0.025, 0.03, 0.008, PALETTE.brassWarm), { pos: [0, 0.068, 0.2] }),
  ]);
}

function buildSunglassesGeometry(): THREE.BufferGeometry {
  return mergeParts([
    // Left dark lens + frame
    transformGeo(rbox(0.115, 0.075, 0.035, 0.014, PALETTE.ironworkPlum), {
      pos: [-0.08, 0, 0],
    }),
    // Right dark lens + frame
    transformGeo(rbox(0.115, 0.075, 0.035, 0.014, PALETTE.ironworkPlum), {
      pos: [0.08, 0, 0],
    }),
    // Nose bridge
    transformGeo(rbox(0.06, 0.022, 0.025, 0.006, PALETTE.brassWarm), {
      pos: [0, 0.015, 0],
    }),
    // Side temple arms
    transformGeo(rbox(0.02, 0.022, 0.18, 0.006, PALETTE.ironworkPlum), {
      pos: [-0.135, 0.01, -0.085],
    }),
    transformGeo(rbox(0.02, 0.022, 0.18, 0.006, PALETTE.ironworkPlum), {
      pos: [0.135, 0.01, -0.085],
    }),
  ]);
}

function buildHeartBadgeGeometry(): THREE.BufferGeometry {
  const heart = new THREE.Shape();
  heart.moveTo(0, -0.14);
  heart.bezierCurveTo(-0.08, -0.08, -0.18, 0.03, -0.15, 0.13);
  heart.bezierCurveTo(-0.12, 0.21, -0.02, 0.2, 0, 0.11);
  heart.bezierCurveTo(0.02, 0.2, 0.12, 0.21, 0.15, 0.13);
  heart.bezierCurveTo(0.18, 0.03, 0.08, -0.08, 0, -0.14);
  return extrudeShape(heart, 0.06, 0.018, 0xf2526e, 6);
}

function intersectSegmentSphere(
  prevPos: THREE.Vector3,
  nextPos: THREE.Vector3,
  center: THREE.Vector3,
  radiusSq: number,
  outPoint: THREE.Vector3
): number {
  _segDir.subVectors(nextPos, prevPos);
  const segLen = _segDir.length();
  if (segLen < 1e-5) return -1;
  _segDir.divideScalar(segLen);
  _toTarget.subVectors(center, prevPos);
  const proj = Math.max(0, Math.min(segLen, _toTarget.dot(_segDir)));
  outPoint.copy(prevPos).addScaledVector(_segDir, proj);
  if (outPoint.distanceToSquared(center) <= radiusSq) {
    return proj;
  }
  return -1;
}

/**
 * Modular Aerial Social, Phone Backup & 5-Day Karma Invasion subsystem.
 * Keeps all flight physics, 'G'-gun mechanics, and ground NPC crowd pooling untouched.
 */
export class AerialSocialAndDayManager {
  private readonly group = new THREE.Group();
  private readonly birdMat: THREE.Material;
  private readonly bulletMatEnemy: THREE.MeshBasicNodeMaterial;
  private readonly bulletMatAlly: THREE.MeshBasicNodeMaterial;
  private readonly muzzleMat: THREE.MeshBasicNodeMaterial;
  private readonly heartMat: THREE.MeshBasicNodeMaterial;
  private readonly crumbMat: THREE.NodeMaterial;

  private readonly wingLGeos: THREE.BufferGeometry[] = [];
  private readonly wingRGeos: THREE.BufferGeometry[] = [];
  private readonly bodyGeos: THREE.BufferGeometry[] = [];
  private readonly tinyPistolGeo: THREE.BufferGeometry;
  private readonly sunglassesGeo: THREE.BufferGeometry;
  private readonly heartGeo: THREE.BufferGeometry;
  private readonly muzzleGeo: THREE.BufferGeometry;
  private readonly bulletGeo: THREE.BufferGeometry;
  private readonly crumbGeo: THREE.BufferGeometry;

  private readonly perchBirds: PerchBirdSlot[] = [];
  private readonly rivalInvaders: RivalInvaderSlot[] = [];
  private readonly karmaDefenders: KarmaDefenderSlot[] = [];
  private readonly bullets: AerialBulletSlot[] = [];
  private readonly crumbs: CrumbSlot[] = [];
  private bulletCursor = 0;
  private crumbCursor = 0;

  // Day 4 Scout Pigeon
  private readonly scoutRig: BirdRigMeshes;
  private readonly scoutPos = new THREE.Vector3(-18, 19.05, 18);
  private scoutActive = false;
  private scoutFleeing = false;
  private scoutFleeVel = new THREE.Vector3();
  private scoutKarmaCooldown = 0;

  // Core Progression, Karma & 5-Day + Endless Survival Cycle State
  public level = 1;
  public xp = 0;
  public birdKarma = 0;
  public currentDay = 1;
  public dayElapsed = 0;
  public day5Triggered = false;
  public day5SurvivedAwarded = false;
  public invasionActive = false;
  public invasionElapsed = 0;
  public invasionWaveDay = 0;
  private globalRivalSwoopCooldown = 0;
  public backupTimer = 0;
  public phoneOpen = false;
  public active = false;
  public readonly contacts: AerialContactEntry[] = [];

  private holdingBefriendKey = false;
  private befriendHoldTime = 0;
  private befriendTriggeredDuringHold = false;
  private nearNeutralBirdCached = false;
  private gunEquipped = false;
  private crumbDropCooldown = 0;
  private lastKnownBirdHp = 100;
  private emittingHp = false;
  private birdInvulnTimer = 0;
  private activeDefenderCount = 0;
  private xpMultiplierFn: ((pos: THREE.Vector3) => number) | null = null;
  private toastTimer: number | null = null;
  private hudRefreshAccum = 0.25;
  private lastDayText = '';
  private lastPhaseText = '';
  private lastPhoneDayText = '';
  private lastLevelText = '';
  private lastXpPctStr = '';
  private lastCourtVisible = false;
  private lastCourtText = '';
  private readonly bulletHitScratch: AerialBulletHitCandidate = {
    kind: 'perch',
    index: 0,
    distance: 0,
    point: new THREE.Vector3(),
  };

  // DOM HUD & Bird Phone Elements
  private readonly topHudRoot: HTMLDivElement;
  private readonly dayTextEl: HTMLSpanElement;
  private readonly dayPhaseEl: HTMLSpanElement;
  private readonly levelTextEl: HTMLSpanElement;
  private readonly xpFillEl: HTMLDivElement;
  private readonly phoneHintBtn: HTMLButtonElement;
  private readonly courtPromptEl: HTMLDivElement;
  private readonly toastEl: HTMLDivElement;

  private readonly phoneRoot: HTMLDivElement;
  private readonly phoneDayEl: HTMLSpanElement;
  private readonly phoneContactCountEl: HTMLSpanElement;
  private readonly phoneContactsList: HTMLDivElement;
  private readonly phoneStatusEl: HTMLDivElement;
  private readonly phoneCallBtn: HTMLButtonElement;

  private readonly abortCtrl = new AbortController();
  private readonly unsubFns: Array<() => void> = [];

  constructor(
    scene: THREE.Scene,
    private readonly physics: PhysicsWorld,
    private readonly audio: AcousticSoundtrack,
    private readonly fx: WorldFX,
    private readonly events: EventBus<GameEventMap>,
    private readonly environment: EnvironmentController,
    parentContainer: HTMLElement,
    streetlampPositions: readonly THREE.Vector3[]
  ) {
    scene.add(this.group);

    this.birdMat = SHARED_NPC_LAMBERT_MAT;
    this.bulletMatEnemy = createUnlitPastelFXMaterial(0xff5b3d);
    this.bulletMatAlly = createUnlitPastelFXMaterial(0x7be3ff);
    this.muzzleMat = createUnlitPastelFXMaterial(0xffe178);
    this.heartMat = createUnlitPastelFXMaterial(0xf5627c);
    this.crumbMat = createPastelMaterial({
      vertexColors: true,
      rimStrength: 0.08,
      emissiveHex: 0xffc64d,
      emissiveIntensity: 0.78,
    });

    this.tinyPistolGeo = buildTinyPistolGeometry();
    this.sunglassesGeo = buildSunglassesGeometry();
    this.heartGeo = buildHeartBadgeGeometry();
    this.muzzleGeo = smoothSphere(0.11, 0xffe47a, 6, 5);
    this.bulletGeo = rbox(0.08, 0.08, 0.44, 0.02, 0xffffff);
    this.crumbGeo = smoothSphere(0.1, PALETTE.croissantButter, 6, 5);

    // Prebuild plumage geometry variants
    for (let i = 0; i < NEUTRAL_PLUMAGE_HEXES.length; i++) {
      const col = NEUTRAL_PLUMAGE_HEXES[i];
      this.bodyGeos.push(buildSongbirdBodyGeometry(col, PALETTE.sparrowBreast));
      this.wingLGeos.push(buildSongbirdWingGeometry(col, -1));
      this.wingRGeos.push(buildSongbirdWingGeometry(col, 1));
    }

    const rivalBodyGeo = buildSongbirdBodyGeometry(0x2d323e, 0xa82e38, 0xc9382e);
    const rivalWingLGeo = buildSongbirdWingGeometry(0x232730, -1);
    const rivalWingRGeo = buildSongbirdWingGeometry(0x232730, 1);

    const defenderBodyGeo = buildSongbirdBodyGeometry(0x4e96d9, PALETTE.porcelainWhite, PALETTE.goldGlow);
    const defenderWingLGeo = buildSongbirdWingGeometry(0x3f7fb8, -1);
    const defenderWingRGeo = buildSongbirdWingGeometry(0x3f7fb8, 1);

    const scoutBodyGeo = buildSongbirdBodyGeometry(
      PALETTE.pigeonSlate,
      PALETTE.pigeonNeckGreen
    );
    const scoutWingLGeo = buildSongbirdWingGeometry(PALETTE.pigeonWing, -1);
    const scoutWingRGeo = buildSongbirdWingGeometry(PALETTE.pigeonWing, 1);

    // 1. Spawn 10 Neutral Perch Birds on rooftops & lampposts
    const perchTargets = this.computePerchSpots(streetlampPositions);
    for (let i = 0; i < NEUTRAL_PERCH_BIRD_COUNT; i++) {
      const variant = i % NEUTRAL_PLUMAGE_HEXES.length;
      const rig = this.createBirdRig(
        this.bodyGeos[variant],
        this.wingLGeos[variant],
        this.wingRGeos[variant],
        1.15
      );
      const pos = perchTargets[i];
      rig.root.position.copy(pos);
      const yaw = (i * 1.37) % (Math.PI * 2);
      rig.root.rotation.y = yaw;

      this.perchBirds.push({
        id: `perch_bird_${i}`,
        index: i,
        name: CONTACT_NAMES[i % CONTACT_NAMES.length],
        perchPos: pos.clone(),
        pos: pos.clone(),
        vel: new THREE.Vector3(),
        yaw,
        state: 'neutral',
        isGf: false,
        hp: 1,
        orbitAngle: i * 0.72,
        orbitRadius: 11 + (i % 4) * 3.2,
        orbitHeight: 4.5 + (i % 3) * 2.1,
        fireCooldown: 1.2 + (i % 3) * 0.4,
        muzzleTimer: 0,
        peacefulKarmaCooldown: 0,
        flapPhase: i * 0.9,
        rig,
      });
    }

    // 2. Day 4 Scout Pigeon in sunglasses on central lamppost
    this.scoutRig = this.createBirdRig(scoutBodyGeo, scoutWingLGeo, scoutWingRGeo, 1.35);
    this.scoutRig.sunglassesGroup.visible = true;
    this.scoutRig.root.position.copy(this.scoutPos);
    this.scoutRig.root.visible = false;

    // 3. Pre-allocate Rival City Flock Invaders (Day 5 + Endless Waves)
    for (let i = 0; i < MAX_RIVAL_POOL; i++) {
      const rig = this.createBirdRig(rivalBodyGeo, rivalWingLGeo, rivalWingRGeo, 1.22);
      rig.pistolGroup.visible = true;
      rig.root.visible = false;
      this.rivalInvaders.push({
        index: i,
        active: false,
        hp: 1,
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        yaw: 0,
        attackState: 'flocking',
        attackCooldown: 1.5 + (i % 7) * 0.95,
        swoopTimer: 0,
        hasFiredInSwoop: false,
        wanderPhase: i * 1.17,
        muzzleTimer: 0,
        flapPhase: i * 0.65,
        rig,
      });
    }

    // 4. Pre-allocate up to 12 Friendly Karma Defenders (Day 5)
    for (let i = 0; i < MAX_KARMA_DEFENDERS; i++) {
      const rig = this.createBirdRig(defenderBodyGeo, defenderWingLGeo, defenderWingRGeo, 1.18);
      rig.heartGroup.visible = false;
      rig.root.visible = false;
      this.karmaDefenders.push({
        index: i,
        active: false,
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        yaw: 0,
        orbitAngle: (i / MAX_KARMA_DEFENDERS) * Math.PI * 2,
        fireCooldown: 0.4 + (i % 4) * 0.2,
        muzzleTimer: 0,
        flapPhase: i * 0.85,
        rig,
      });
    }

    // 5. Shared Aerial Projectile Pool (enemy & ally)
    for (let i = 0; i < AERIAL_BULLET_POOL_SIZE; i++) {
      const mesh = new THREE.Mesh(this.bulletGeo, this.bulletMatEnemy);
      mesh.visible = false;
      this.group.add(mesh);
      this.bullets.push({
        active: false,
        owner: 'enemy',
        age: 0,
        pos: new THREE.Vector3(),
        prevPos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        mesh,
      });
    }

    // 6. Pooled Breadcrumb Cluster ('C' key)
    for (let i = 0; i < CRUMB_POOL_SIZE; i++) {
      const mesh = new THREE.Mesh(this.crumbGeo, this.crumbMat);
      mesh.visible = false;
      mesh.castShadow = false;
      this.group.add(mesh);
      this.crumbs.push({
        active: false,
        age: 0,
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        settled: false,
        mesh,
      });
    }

    // 7. Build Top-Center Day / Bird Level HUD & Bottom-Right Bird Phone UI
    this.topHudRoot = document.createElement('div');
    this.topHudRoot.className = 'aerial-top-hud is-hidden';
    this.topHudRoot.setAttribute('aria-hidden', 'true');

    const dayChip = document.createElement('div');
    dayChip.className = 'aerial-hud-pill';
    this.dayTextEl = document.createElement('span');
    this.dayTextEl.className = 'aerial-hud-strong';
    this.dayTextEl.textContent = 'Day 1 / 5';
    this.dayPhaseEl = document.createElement('span');
    this.dayPhaseEl.className = 'aerial-hud-sub';
    this.dayPhaseEl.textContent = 'Morning';
    dayChip.appendChild(this.dayTextEl);
    dayChip.appendChild(this.dayPhaseEl);

    const levelChip = document.createElement('div');
    levelChip.className = 'aerial-hud-pill aerial-level-pill';
    this.levelTextEl = document.createElement('span');
    this.levelTextEl.className = 'aerial-hud-strong';
    this.levelTextEl.textContent = 'Bird Lv 1';
    const xpTrack = document.createElement('div');
    xpTrack.className = 'aerial-xp-track';
    this.xpFillEl = document.createElement('div');
    this.xpFillEl.className = 'aerial-xp-fill';
    xpTrack.appendChild(this.xpFillEl);
    levelChip.appendChild(this.levelTextEl);
    levelChip.appendChild(xpTrack);

    this.phoneHintBtn = document.createElement('button');
    this.phoneHintBtn.type = 'button';
    this.phoneHintBtn.className = 'aerial-hud-pill aerial-phone-toggle';
    this.phoneHintBtn.textContent = 'Phone [P / Tab]';
    this.phoneHintBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.togglePhone();
    });

    this.topHudRoot.appendChild(dayChip);
    this.topHudRoot.appendChild(levelChip);
    this.topHudRoot.appendChild(this.phoneHintBtn);
    parentContainer.appendChild(this.topHudRoot);

    this.courtPromptEl = document.createElement('div');
    this.courtPromptEl.className = 'aerial-court-prompt is-hidden';
    this.courtPromptEl.textContent = '[Hold E (1s) to Befriend]';
    parentContainer.appendChild(this.courtPromptEl);

    this.toastEl = document.createElement('div');
    this.toastEl.className = 'aerial-toast is-hidden';
    this.toastEl.setAttribute('role', 'status');
    parentContainer.appendChild(this.toastEl);

    // Mini Smartphone UI (Bottom-Right Corner)
    this.phoneRoot = document.createElement('div');
    this.phoneRoot.className = 'bird-phone is-hidden';
    this.phoneRoot.setAttribute('aria-hidden', 'true');
    this.phoneRoot.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.phoneRoot.addEventListener('click', (e) => e.stopPropagation());

    const notch = document.createElement('div');
    notch.className = 'bird-phone-notch';
    const speaker = document.createElement('span');
    speaker.className = 'bird-phone-speaker';
    notch.appendChild(speaker);

    const statusBar = document.createElement('div');
    statusBar.className = 'bird-phone-statusbar';
    this.phoneDayEl = document.createElement('span');
    this.phoneDayEl.textContent = 'Day 1';
    const carrier = document.createElement('span');
    carrier.textContent = 'FlockNet';
    statusBar.appendChild(this.phoneDayEl);
    statusBar.appendChild(carrier);

    const appHeader = document.createElement('div');
    appHeader.className = 'bird-phone-header';
    const appTitle = document.createElement('span');
    appTitle.className = 'bird-phone-title';
    appTitle.textContent = 'Contacts';
    this.phoneContactCountEl = document.createElement('span');
    this.phoneContactCountEl.className = 'bird-phone-count';
    this.phoneContactCountEl.textContent = '0';
    appHeader.appendChild(appTitle);
    appHeader.appendChild(this.phoneContactCountEl);

    this.phoneContactsList = document.createElement('div');
    this.phoneContactsList.className = 'bird-phone-list';

    this.phoneStatusEl = document.createElement('div');
    this.phoneStatusEl.className = 'bird-phone-status';
    this.phoneStatusEl.textContent = 'Standby';

    this.phoneCallBtn = document.createElement('button');
    this.phoneCallBtn.type = 'button';
    this.phoneCallBtn.className = 'bird-phone-call-btn';
    this.phoneCallBtn.textContent = 'Call Backup';
    this.phoneCallBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.activatePhoneBackup();
    });

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'bird-phone-close-btn';
    closeBtn.textContent = 'Hide [P / Tab]';
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.setPhoneOpen(false);
    });

    this.phoneRoot.appendChild(notch);
    this.phoneRoot.appendChild(statusBar);
    this.phoneRoot.appendChild(appHeader);
    this.phoneRoot.appendChild(this.phoneContactsList);
    this.phoneRoot.appendChild(this.phoneStatusEl);
    this.phoneRoot.appendChild(this.phoneCallBtn);
    this.phoneRoot.appendChild(closeBtn);
    parentContainer.appendChild(this.phoneRoot);

    this.renderContactsList();

    // 8. Event Subscriptions for XP & HP Sync (without touching CrowdRebellionManager)
    this.unsubFns.push(
      this.events.on('crowd:kill', () => {
        const mul = this.xpMultiplierFn ? Math.max(1, this.xpMultiplierFn(this.lastBirdPos)) : 1;
        this.awardXp(Math.round(50 * mul));
      }),
      this.events.on('crowd:intimidated', ({ respectGained }) => {
        this.awardXp(respectGained > 0 ? respectGained : 25);
      }),
      this.events.on('bird:healthChanged', ({ hp }) => {
        if (!this.emittingHp) {
          this.lastKnownBirdHp = hp;
        }
      })
    );

    // 9. Keyboard Bindings ('E' hold 1s to befriend, 'P', 'Tab', 'C')
    window.addEventListener(
      'keydown',
      (e) => {
        if (!this.active || e.metaKey || e.ctrlKey || e.altKey) return;
        if (e.code === 'KeyP' || e.code === 'Tab') {
          e.preventDefault();
          if (!e.repeat) {
            this.togglePhone();
          }
          return;
        }
        if (e.code === 'KeyE') {
          if (!e.repeat) {
            this.holdingBefriendKey = true;
            this.befriendHoldTime = 0;
            this.befriendTriggeredDuringHold = false;
            if (this.nearNeutralBirdCached && this.currentDay < MAX_DAYS) {
              this.befriendTriggeredDuringHold = true;
              this.audio.playSparrowMicroChirp('idle');
              this.showToast(
                'Chirp! You can only make birdy friends after surviving Day 5!',
                true,
                2500
              );
            }
          }
          return;
        }
        if (e.repeat) return;
        if (e.code === 'KeyC') {
          this.tryDropCrumbs();
        }
      },
      { signal: this.abortCtrl.signal }
    );

    window.addEventListener(
      'keyup',
      (e) => {
        if (e.code === 'KeyE') {
          this.holdingBefriendKey = false;
          this.befriendHoldTime = 0;
          this.befriendTriggeredDuringHold = false;
        }
      },
      { signal: this.abortCtrl.signal }
    );

    window.addEventListener(
      'blur',
      () => {
        this.holdingBefriendKey = false;
        this.befriendHoldTime = 0;
        this.befriendTriggeredDuringHold = false;
      },
      { signal: this.abortCtrl.signal }
    );
  }

  private computePerchSpots(streetlampPositions: readonly THREE.Vector3[]): THREE.Vector3[] {
    const chosen: THREE.Vector3[] = [];
    // Pick up to 8 central-to-mid streetlamp copper lantern caps (cap top sits +1.40 above lamp globe center y=17.65)
    const sorted = [...streetlampPositions].sort(
      (a, b) => a.x * a.x + a.z * a.z - (b.x * b.x + b.z * b.z)
    );
    for (let i = 0; i < sorted.length && chosen.length < 8; i++) {
      const lamp = sorted[i];
      // Leave (-18, 17.65, 18) open for Day 4 Scout Pigeon in sunglasses
      if (Math.abs(lamp.x - -18) < 1 && Math.abs(lamp.z - 18) < 1) continue;
      chosen.push(new THREE.Vector3(lamp.x, lamp.y + 1.4, lamp.z));
    }

    // Fill remaining up to 10 spots via downward raycasts onto prominent central rooftops
    const roofProbes: ReadonlyArray<readonly [number, number]> = [
      [-48, 42],
      [44, -46],
      [-52, -48],
      [48, 48],
    ];
    for (let i = 0; i < roofProbes.length && chosen.length < NEUTRAL_PERCH_BIRD_COUNT; i++) {
      const [rx, rz] = roofProbes[i];
      _probeStart.set(rx, 85, rz);
      const hit = this.physics.raycastGround(
        _probeStart,
        _downVec,
        80,
        undefined,
        _groundHit,
        COLLISION_GROUP_STATIC
      );
      if (hit.hit && hit.normal.y > 0.45 && hit.point.y > 8) {
        chosen.push(new THREE.Vector3(rx, hit.point.y + 0.04, rz));
      }
    }

    // Fallback safety positions if any spots remain
    while (chosen.length < NEUTRAL_PERCH_BIRD_COUNT) {
      const idx = chosen.length;
      chosen.push(new THREE.Vector3(18 * ((idx % 2) * 2 - 1), 19.05, 18 + idx * 14));
    }
    return chosen;
  }

  private createBirdRig(
    bodyGeo: THREE.BufferGeometry,
    wingLGeo: THREE.BufferGeometry,
    wingRGeo: THREE.BufferGeometry,
    scale: number
  ): BirdRigMeshes {
    const root = new THREE.Group();
    root.scale.setScalar(scale);

    const bodyGroup = new THREE.Group();
    const bodyMesh = new THREE.Mesh(bodyGeo, this.birdMat);
    bodyMesh.castShadow = false;
    bodyMesh.receiveShadow = true;
    bodyGroup.add(bodyMesh);

    const wingL = new THREE.Group();
    wingL.position.set(-0.14, 0.29, 0.02);
    const wingLMesh = new THREE.Mesh(wingLGeo, this.birdMat);
    wingLMesh.castShadow = false;
    wingL.add(wingLMesh);

    const wingR = new THREE.Group();
    wingR.position.set(0.14, 0.29, 0.02);
    const wingRMesh = new THREE.Mesh(wingRGeo, this.birdMat);
    wingRMesh.castShadow = false;
    wingR.add(wingRMesh);

    const pistolGroup = new THREE.Group();
    pistolGroup.position.set(0.16, 0.2, 0.22);
    pistolGroup.add(new THREE.Mesh(this.tinyPistolGeo, this.birdMat));
    pistolGroup.visible = false;

    const muzzleFlash = new THREE.Mesh(this.muzzleGeo, this.muzzleMat);
    muzzleFlash.position.set(0, 0.04, 0.28);
    muzzleFlash.visible = false;
    pistolGroup.add(muzzleFlash);

    const sunglassesGroup = new THREE.Group();
    sunglassesGroup.position.set(0, 0.47, 0.27);
    sunglassesGroup.add(new THREE.Mesh(this.sunglassesGeo, this.birdMat));
    sunglassesGroup.visible = false;

    const heartGroup = new THREE.Group();
    heartGroup.position.set(0, 0.96, 0);
    heartGroup.add(new THREE.Mesh(this.heartGeo, this.heartMat));
    heartGroup.visible = false;

    bodyGroup.add(wingL, wingR, pistolGroup, sunglassesGroup);
    root.add(bodyGroup, heartGroup);
    this.group.add(root);

    return {
      root,
      bodyGroup,
      wingL,
      wingR,
      pistolGroup,
      heartGroup,
      sunglassesGroup,
      muzzleFlash,
    };
  }

  public setActive(active: boolean): void {
    this.active = active;
    this.topHudRoot.classList.toggle('is-hidden', !active);
    this.topHudRoot.setAttribute('aria-hidden', active ? 'false' : 'true');
    if (active) {
      this.environment.setCyclePaused(true);
      this.refreshHudLabels();
    } else {
      this.holdingBefriendKey = false;
      this.befriendHoldTime = 0;
      this.befriendTriggeredDuringHold = false;
      this.setPhoneOpen(false);
    }
  }

  public togglePhone(): void {
    this.setPhoneOpen(!this.phoneOpen);
  }

  public setPhoneOpen(open: boolean): void {
    this.phoneOpen = open;
    this.phoneRoot.classList.toggle('is-hidden', !open);
    this.phoneRoot.setAttribute('aria-hidden', open ? 'false' : 'true');
    if (open && document.pointerLockElement) {
      document.exitPointerLock?.();
    }
  }

  public setXpMultiplierFn(fn: (pos: THREE.Vector3) => number): void {
    this.xpMultiplierFn = fn;
  }

  public awardExternalXp(baseAmount: number, reasonPos?: THREE.Vector3): void {
    const pos = reasonPos ?? this.lastBirdPos;
    const mul = this.xpMultiplierFn ? Math.max(1, this.xpMultiplierFn(pos)) : 1;
    this.awardXp(Math.round(baseAmount * mul));
  }

  private awardXp(amount: number): void {
    if (amount <= 0) return;
    const prevLevel = this.level;
    this.xp += amount;
    this.level = 1 + Math.floor(this.xp / XP_PER_LEVEL);
    this.refreshHudLabels();
    if (this.level > prevLevel) {
      this.showToast(`Bird Level Up! Lv ${this.level}`, true);
      this.audio.playSparrowMicroChirp('perch');
    }
  }

  private addKarma(delta: number, reason: string): void {
    this.birdKarma = Math.max(-100, Math.min(120, this.birdKarma + delta));
    this.showToast(`${reason} (${delta > 0 ? `+${delta}` : delta} Karma)`, delta > 0);
  }

  private readonly lastBirdPos = new THREE.Vector3();

  private tryDropCrumbs(): void {
    if (this.crumbDropCooldown > 0) return;
    this.crumbDropCooldown = 2.5;
    for (let i = 0; i < 6; i++) {
      const slot = this.crumbs[this.crumbCursor];
      this.crumbCursor = (this.crumbCursor + 1) % this.crumbs.length;
      slot.active = true;
      slot.age = 0;
      slot.settled = false;
      slot.pos.set(
        this.lastBirdPos.x + (Math.random() - 0.5) * 0.4,
        this.lastBirdPos.y - 0.12,
        this.lastBirdPos.z + (Math.random() - 0.5) * 0.4
      );
      const ang = (i / 6) * Math.PI * 2 + Math.random() * 0.4;
      slot.vel.set(Math.cos(ang) * 1.4, 0.9 + Math.random() * 0.8, Math.sin(ang) * 1.4);
      slot.mesh.position.copy(slot.pos);
      slot.mesh.visible = true;
    }
    this.fx.spawnBreadcrumbCrumbs(this.lastBirdPos, 8);
    this.audio.playSparrowMicroChirp('idle');
    this.addKarma(10, 'Dropped Breadcrumbs');
  }

  public tryCourtNearbyBird(bypassDayCheck = false): boolean {
    let best: PerchBirdSlot | null = null;
    let bestDistSq = COURT_RANGE_SQ;
    for (let i = 0; i < this.perchBirds.length; i++) {
      const b = this.perchBirds[i];
      if (b.state !== 'neutral') continue;
      const dSq = b.pos.distanceToSquared(this.lastBirdPos);
      if (dSq < bestDistSq) {
        bestDistSq = dSq;
        best = b;
      }
    }
    if (!best) return false;

    if (!bypassDayCheck && this.currentDay < MAX_DAYS) {
      this.showToast(
        'Chirp! You can only make birdy friends after surviving Day 5!',
        true,
        2500
      );
      this.audio.playSparrowMicroChirp('idle');
      return false;
    }

    // Exact 20% (1-in-5) recruitment check
    const accepted = Math.random() < COURT_SUCCESS_CHANCE;
    if (accepted) {
      best.state = 'ally';
      const hasGf = this.contacts.some((c) => c.role === 'GF');
      best.isGf = !hasGf;
      best.rig.heartGroup.visible = true;
      best.rig.pistolGroup.visible = false;
      const role: 'GF' | 'Ally' = best.isGf ? 'GF' : 'Ally';
      const label = best.isGf ? `${best.name} (GF ♥)` : `${best.name} (Ally)`;
      this.contacts.push({
        id: best.id,
        slotIndex: best.index,
        label,
        role,
      });
      this.renderContactsList();
      this.fx.spawnBurst(best.pos, 8, true, 3.2);
      this.audio.playSparrowMicroChirp('perch');
      this.showToast(
        best.isGf
          ? `${best.name} became your GF ♥! Added to Phone Contacts!`
          : `${best.name} joined as Ally ♥! Added to Contacts!`,
        true
      );
      return true;
    }

    // 80% rejection: pulls tiny pistol, flies, and shoots back!
    best.state = 'hostile';
    best.hp = 1;
    best.rig.pistolGroup.visible = true;
    best.rig.heartGroup.visible = false;
    best.fireCooldown = 0.85;
    this.fx.spawnFeatherBurst(best.pos, 6, 3.0);
    this.audio.playSparrowMicroChirp('mischief');
    this.showToast(`${best.name} rejected you & pulled a tiny pistol!`, false);
    return true;
  }

  public activatePhoneBackup(): boolean {
    if (this.contacts.length === 0) {
      this.showToast('No contacts yet! From Day 5+, hold [E] (1s) near perched birds.', false);
      return false;
    }
    this.backupTimer = BACKUP_DURATION_SECONDS;
    for (let i = 0; i < this.contacts.length; i++) {
      const slot = this.perchBirds[this.contacts[i].slotIndex];
      if (!slot) continue;
      slot.rig.pistolGroup.visible = true;
      slot.rig.heartGroup.visible = true;
      slot.fireCooldown = 0.25 + i * 0.15;
    }
    this.renderContactsList();
    this.audio.playSparrowMicroChirp('takeoff');
    this.showToast(`Backup Called! ${this.contacts.length} wingmates flying for 45s!`, true);
    return true;
  }

  private renderContactsList(): void {
    this.phoneContactCountEl.textContent = String(this.contacts.length);
    this.phoneContactsList.replaceChildren();

    if (this.contacts.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'bird-phone-empty';
      empty.textContent =
        'No contacts yet. From Day 5+, fly near perched birds & hold [E] (1s) to befriend!';
      this.phoneContactsList.appendChild(empty);
      this.phoneCallBtn.disabled = true;
      this.phoneStatusEl.textContent =
        this.currentDay < MAX_DAYS ? 'Unlocks on Day 5+' : 'Hold [E] (1s) near birds';
      return;
    }

    for (let i = 0; i < this.contacts.length; i++) {
      const c = this.contacts[i];
      const row = document.createElement('div');
      row.className = 'bird-phone-contact';

      const nameEl = document.createElement('span');
      nameEl.className = 'bird-phone-contact-name';
      nameEl.textContent = c.label;

      const stateEl = document.createElement('span');
      stateEl.className = 'bird-phone-contact-state';
      stateEl.textContent =
        this.backupTimer > 0 ? `Flying (${Math.ceil(this.backupTimer)}s)` : 'Ready';

      row.appendChild(nameEl);
      row.appendChild(stateEl);
      this.phoneContactsList.appendChild(row);
    }

    this.phoneCallBtn.disabled = false;
    this.phoneStatusEl.textContent =
      this.backupTimer > 0
        ? `Backup Active · ${Math.ceil(this.backupTimer)}s`
        : `${this.contacts.length} Wingmate${this.contacts.length > 1 ? 's' : ''} Ready`;
  }

  private refreshHudLabels(): void {
    this.hudRefreshAccum = 0;
    const progress = Math.min(1, this.dayElapsed / DAY_DURATION_SECONDS);
    let phaseLabel =
      progress < 0.2 ? 'Dawn' : progress < 0.6 ? 'Midday' : progress < 0.82 ? 'Sunset' : 'Night';
    if (this.invasionActive) {
      const secsLeft = Math.max(0, Math.ceil(INVASION_DURATION_SECONDS - this.invasionElapsed));
      phaseLabel = this.currentDay <= MAX_DAYS ? `Invasion · ${secsLeft}s` : `Wave · ${secsLeft}s`;
    }
    const nextDayText =
      this.currentDay <= MAX_DAYS ? `Day ${this.currentDay} / ${MAX_DAYS}` : `Day ${this.currentDay} · Endless`;
    if (nextDayText !== this.lastDayText) {
      this.lastDayText = nextDayText;
      this.dayTextEl.textContent = nextDayText;
    }
    if (phaseLabel !== this.lastPhaseText) {
      this.lastPhaseText = phaseLabel;
      this.dayPhaseEl.textContent = phaseLabel;
    }
    const nextPhoneDay =
      this.currentDay <= MAX_DAYS ? `Day ${this.currentDay}` : `Day ${this.currentDay} ∞`;
    if (nextPhoneDay !== this.lastPhoneDayText) {
      this.lastPhoneDayText = nextPhoneDay;
      this.phoneDayEl.textContent = nextPhoneDay;
    }
    const nextLevelText = `Bird Lv ${this.level}`;
    if (nextLevelText !== this.lastLevelText) {
      this.lastLevelText = nextLevelText;
      this.levelTextEl.textContent = nextLevelText;
    }
    const xpPct = Math.max(0, Math.min(100, this.xp % XP_PER_LEVEL));
    const nextXpPctStr = `${xpPct}%`;
    if (nextXpPctStr !== this.lastXpPctStr) {
      this.lastXpPctStr = nextXpPctStr;
      this.xpFillEl.style.width = nextXpPctStr;
    }
  }

  private showToast(msg: string, positive: boolean, durationMs = 3200): void {
    if (this.toastTimer !== null) {
      window.clearTimeout(this.toastTimer);
      this.toastTimer = null;
    }
    this.toastEl.textContent = msg;
    this.toastEl.classList.toggle('is-positive', positive);
    this.toastEl.classList.remove('is-hidden');
    this.toastTimer = window.setTimeout(() => {
      this.toastTimer = null;
      this.toastEl.classList.add('is-hidden');
    }, durationMs);
  }

  private spawnBullet(
    origin: THREE.Vector3,
    dir: THREE.Vector3,
    speed: number,
    owner: 'enemy' | 'ally'
  ): void {
    let slot = this.bullets[this.bulletCursor];
    if (slot.active) {
      let foundInactive = false;
      for (let i = 0; i < this.bullets.length; i++) {
        const idx = (this.bulletCursor + i) % this.bullets.length;
        if (!this.bullets[idx].active) {
          slot = this.bullets[idx];
          this.bulletCursor = (idx + 1) % this.bullets.length;
          foundInactive = true;
          break;
        }
      }
      if (!foundInactive) {
        this.bulletCursor = (this.bulletCursor + 1) % this.bullets.length;
      }
    } else {
      this.bulletCursor = (this.bulletCursor + 1) % this.bullets.length;
    }
    slot.active = true;
    slot.owner = owner;
    slot.age = 0;
    slot.pos.copy(origin);
    slot.prevPos.copy(origin);
    slot.vel.copy(dir).multiplyScalar(speed);
    slot.mesh.material = owner === 'enemy' ? this.bulletMatEnemy : this.bulletMatAlly;
    slot.mesh.position.copy(origin);
    slot.mesh.lookAt(origin.x + dir.x, origin.y + dir.y, origin.z + dir.z);
    slot.mesh.visible = true;
  }

  private applyPlayerDamage(): void {
    if (this.birdInvulnTimer > 0 || this.lastKnownBirdHp <= 0) return;
    const prevHp = this.lastKnownBirdHp;
    const nextHp = Math.max(0, prevHp - AERIAL_ENEMY_DAMAGE);
    this.lastKnownBirdHp = nextHp;
    this.birdInvulnTimer = 0.28;

    this.fx.spawnFeatherBurst(this.lastBirdPos, 7, 3.6);
    this.audio.playBirdHurt();

    const downed = nextHp <= 0;
    this.emittingHp = true;
    try {
      this.events.emit('bird:healthChanged', {
        hp: nextHp,
        maxHp: 100,
        delta: nextHp - prevHp,
        downed,
      });
    } finally {
      this.emittingHp = false;
    }

    if (downed) {
      this.birdInvulnTimer = 2.6;
      window.setTimeout(() => {
        if (this.lastKnownBirdHp <= 0) {
          this.lastKnownBirdHp = 100;
          this.emittingHp = true;
          try {
            this.events.emit('bird:healthChanged', {
              hp: 100,
              maxHp: 100,
              delta: 100,
              downed: false,
            });
          } finally {
            this.emittingHp = false;
          }
        }
      }, 2200);
    }
  }

  public reviveBird(): void {
    this.lastKnownBirdHp = 100;
    this.birdInvulnTimer = 2.4;
    for (let i = 0; i < this.bullets.length; i++) {
      this.bullets[i].active = false;
      this.bullets[i].mesh.visible = false;
    }
  }

  /**
   * Checks player pistol bullet intersection against aerial perch birds, Day 4 scout, and Day 5 invaders.
   */
  public findBulletHit(
    prevPos: THREE.Vector3,
    nextPos: THREE.Vector3
  ): AerialBulletHitCandidate | null {
    let best: AerialBulletHitCandidate | null = null;
    let bestDist = Infinity;

    for (let i = 0; i < this.perchBirds.length; i++) {
      const b = this.perchBirds[i];
      if (b.state === 'defeated' || b.state === 'ally') continue;
      const d = intersectSegmentSphere(prevPos, nextPos, b.pos, BIRD_HIT_RADIUS_SQ, _hitPtScratch);
      if (d >= 0 && d < bestDist) {
        bestDist = d;
        this.bulletHitScratch.kind = 'perch';
        this.bulletHitScratch.index = i;
        this.bulletHitScratch.distance = d;
        this.bulletHitScratch.point.copy(_hitPtScratch);
        best = this.bulletHitScratch;
      }
    }

    if (this.scoutActive && !this.scoutFleeing) {
      const d = intersectSegmentSphere(
        prevPos,
        nextPos,
        this.scoutPos,
        BIRD_HIT_RADIUS_SQ,
        _hitPtScratch
      );
      if (d >= 0 && d < bestDist) {
        bestDist = d;
        this.bulletHitScratch.kind = 'scout';
        this.bulletHitScratch.index = 0;
        this.bulletHitScratch.distance = d;
        this.bulletHitScratch.point.copy(_hitPtScratch);
        best = this.bulletHitScratch;
      }
    }

    for (let i = 0; i < this.rivalInvaders.length; i++) {
      const r = this.rivalInvaders[i];
      if (!r.active) continue;
      const d = intersectSegmentSphere(prevPos, nextPos, r.pos, BIRD_HIT_RADIUS_SQ, _hitPtScratch);
      if (d >= 0 && d < bestDist) {
        bestDist = d;
        this.bulletHitScratch.kind = 'rival';
        this.bulletHitScratch.index = i;
        this.bulletHitScratch.distance = d;
        this.bulletHitScratch.point.copy(_hitPtScratch);
        best = this.bulletHitScratch;
      }
    }

    return best;
  }

  public applyBulletHit(cand: AerialBulletHitCandidate): void {
    this.fx.spawnFeatherBurst(cand.point, 9, 3.8);
    this.audio.playSparrowMicroChirp('mischief');

    if (cand.kind === 'perch') {
      const b = this.perchBirds[cand.index];
      if (!b || b.state === 'defeated') return;
      if (b.state === 'neutral') {
        this.addKarma(-15, 'Shot Neutral Bird');
        b.state = 'hostile';
        b.rig.pistolGroup.visible = true;
        b.fireCooldown = 0.7;
      } else {
        b.hp -= 1;
        if (b.hp <= 0) {
          b.state = 'defeated';
          b.rig.root.visible = false;
          this.awardXp(50);
          this.showToast(`Downed ${b.name}! (+50 XP)`, true);
        }
      }
      return;
    }

    if (cand.kind === 'scout') {
      this.addKarma(-15, 'Shot Scout Pigeon');
      this.scoutFleeing = true;
      this.scoutFleeVel.set(9.5, 8.2, -9.5);
      return;
    }

    if (cand.kind === 'rival') {
      const r = this.rivalInvaders[cand.index];
      if (!r || !r.active) return;
      r.active = false;
      r.rig.root.visible = false;
      this.awardXp(50);
      this.showToast('Rival Invader Down! (+50 XP)', true);
    }
  }

  private findClosestHostileAerialTarget(
    fromPos: THREE.Vector3,
    maxRangeSq: number
  ): { pos: THREE.Vector3; kind: 'perch' | 'rival'; index: number } | null {
    let bestPos: THREE.Vector3 | null = null;
    let bestKind: 'perch' | 'rival' = 'rival';
    let bestIdx = -1;
    let bestDistSq = maxRangeSq;

    for (let i = 0; i < this.rivalInvaders.length; i++) {
      const r = this.rivalInvaders[i];
      if (!r.active || r.attackState === 'retreating') continue;
      const dSq = r.pos.distanceToSquared(fromPos);
      if (dSq < bestDistSq) {
        bestDistSq = dSq;
        bestPos = r.pos;
        bestKind = 'rival';
        bestIdx = i;
      }
    }

    for (let i = 0; i < this.perchBirds.length; i++) {
      const b = this.perchBirds[i];
      if (b.state !== 'hostile') continue;
      const dSq = b.pos.distanceToSquared(fromPos);
      if (dSq < bestDistSq) {
        bestDistSq = dSq;
        bestPos = b.pos;
        bestKind = 'perch';
        bestIdx = i;
      }
    }

    return bestPos ? { pos: bestPos, kind: bestKind, index: bestIdx } : null;
  }

  private triggerDay4Scout(): void {
    if (this.scoutActive) return;
    this.scoutActive = true;
    this.scoutFleeing = false;
    this.scoutRig.root.position.copy(this.scoutPos);
    this.scoutRig.root.visible = true;
    this.showToast('Day 4: A pigeon in sunglasses is watching from the lamppost...', false);
    this.audio.playSparrowMicroChirp('idle');
  }

  private triggerInvasionWave(waveDay: number, count: number): void {
    if (waveDay === 5 && this.day5Triggered) return;
    if (waveDay === 5) {
      this.day5Triggered = true;
    }

    // Retire Day 4 Scout cleanly
    this.scoutFleeing = true;
    this.scoutFleeVel.set(-8, 9, 8);

    this.invasionActive = true;
    this.invasionElapsed = 0;
    this.invasionWaveDay = waveDay;
    this.globalRivalSwoopCooldown = 0.9;

    const spawnCount = Math.min(this.rivalInvaders.length, Math.max(1, count));
    for (let i = 0; i < this.rivalInvaders.length; i++) {
      const r = this.rivalInvaders[i];
      if (i >= spawnCount) {
        r.active = false;
        r.rig.root.visible = false;
        continue;
      }
      const ang = (i / spawnCount) * Math.PI * 2 + Math.random() * 0.45;
      const rad = 28 + (i % 4) * 9 + Math.random() * 6;
      r.active = true;
      r.hp = 1;
      r.attackState = 'flocking';
      r.hasFiredInSwoop = false;
      r.swoopTimer = 0;
      r.wanderPhase = i * 1.17 + Math.random() * 2.0;
      r.pos.set(
        this.lastBirdPos.x + Math.cos(ang) * rad,
        Math.max(17, this.lastBirdPos.y + 9 + (i % 4) * 3.2),
        this.lastBirdPos.z + Math.sin(ang) * rad
      );
      // Tangential + slight inward starting flock velocity
      r.vel.set(
        -Math.sin(ang) * 14 + (Math.random() - 0.5) * 4,
        (Math.random() - 0.5) * 2.5,
        Math.cos(ang) * 14 + (Math.random() - 0.5) * 4
      );
      r.yaw = Math.atan2(r.vel.x, r.vel.z);
      // Staggered independent attack cooldowns so birds peel off one by one
      r.attackCooldown = 1.2 + i * 0.85 + Math.random() * 1.4;
      r.rig.root.position.copy(r.pos);
      r.rig.root.rotation.y = r.yaw;
      r.rig.bodyGroup.rotation.set(0, 0, 0);
      r.rig.root.visible = true;
    }

    // Automatically spawn 0-12 Friendly Defenders scaled by hidden birdKarma
    const clampedKarma = Math.max(0, Math.min(100, this.birdKarma));
    this.activeDefenderCount = Math.max(
      0,
      Math.min(MAX_KARMA_DEFENDERS, Math.round((clampedKarma / 100) * MAX_KARMA_DEFENDERS))
    );
    for (let i = 0; i < MAX_KARMA_DEFENDERS; i++) {
      const d = this.karmaDefenders[i];
      if (i < this.activeDefenderCount) {
        const ang = (i / Math.max(1, this.activeDefenderCount)) * Math.PI * 2;
        d.active = true;
        d.orbitAngle = ang;
        d.pos.set(
          this.lastBirdPos.x + Math.cos(ang) * 7.5,
          this.lastBirdPos.y + 2.5 + (i % 3) * 1.1,
          this.lastBirdPos.z + Math.sin(ang) * 7.5
        );
        d.fireCooldown = 0.25 + (i % 4) * 0.15;
        d.rig.root.position.copy(d.pos);
        d.rig.root.visible = true;
      } else {
        d.active = false;
        d.rig.root.visible = false;
      }
    }

    this.audio.playRebellionAlert(true);
    const waveLabel =
      waveDay === 5
        ? `DAY 5: RIVAL FLOCK INVASION (${spawnCount}) — Survive 60s!`
        : `DAY ${waveDay} ENDLESS WAVE (${spawnCount}) — Defend the skies!`;
    this.showToast(
      this.activeDefenderCount > 0
        ? `${waveLabel} (${this.activeDefenderCount} Friendly Defenders)`
        : waveLabel,
      this.activeDefenderCount > 0,
      3800
    );
  }

  private completeInvasionWave(clearedAll: boolean): void {
    if (!this.invasionActive) return;
    this.invasionActive = false;

    // Surviving rival birds peel off and fly away into the sky
    for (let i = 0; i < this.rivalInvaders.length; i++) {
      const r = this.rivalInvaders[i];
      if (!r.active) continue;
      r.attackState = 'retreating';
      r.swoopTimer = 4.5;
      const outX = r.pos.x - this.lastBirdPos.x;
      const outZ = r.pos.z - this.lastBirdPos.z;
      const outLen = Math.hypot(outX, outZ) || 1;
      r.vel.set((outX / outLen) * 20, 16 + (i % 4) * 2.5, (outZ / outLen) * 20);
    }

    // Friendly karma defenders return home smoothly once the wave is repelled
    for (let i = 0; i < this.karmaDefenders.length; i++) {
      this.karmaDefenders[i].active = false;
      this.karmaDefenders[i].rig.root.visible = false;
    }

    this.audio.playSparrowMicroChirp('takeoff');
    if (this.invasionWaveDay <= MAX_DAYS && !this.day5SurvivedAwarded) {
      this.day5SurvivedAwarded = true;
      const bonusXp = clearedAll ? 300 : 250;
      this.awardXp(bonusXp);
      this.birdKarma = Math.max(-100, Math.min(120, this.birdKarma + 15));
      this.renderContactsList();
      this.showToast(
        `Day 5 Survived! (+${bonusXp} XP Bonus) Hold [E] near perched birds to make friends!`,
        true,
        4200
      );
    } else {
      const bonusXp = 200 + Math.max(0, this.invasionWaveDay - MAX_DAYS) * 50;
      this.awardXp(bonusXp);
      this.showToast(
        `Day ${this.invasionWaveDay} Wave Survived! (+${bonusXp} XP Bonus)`,
        true,
        3600
      );
    }
    this.refreshHudLabels();
  }

  public update(
    rawDt: number,
    elapsed: number,
    birdPos: THREE.Vector3,
    gunEquipped: boolean,
    camPos?: THREE.Vector3
  ): void {
    const dt = Math.min(0.05, Math.max(0.0001, rawDt));
    this.lastBirdPos.copy(birdPos);
    this.gunEquipped = gunEquipped;

    if (this.crumbDropCooldown > 0) this.crumbDropCooldown = Math.max(0, this.crumbDropCooldown - dt);
    if (this.birdInvulnTimer > 0) this.birdInvulnTimer = Math.max(0, this.birdInvulnTimer - dt);
    if (this.globalRivalSwoopCooldown > 0) {
      this.globalRivalSwoopCooldown = Math.max(0, this.globalRivalSwoopCooldown - dt);
    }

    // 1. Advance Endless Day Cycle (90s per day, smooth day -> sunset lighting, Day 5 timed 60s + Endless Day 6+)
    if (this.active) {
      this.dayElapsed += dt;
      let dayChanged = false;
      if (this.dayElapsed >= DAY_DURATION_SECONDS) {
        this.dayElapsed -= DAY_DURATION_SECONDS;
        this.currentDay += 1;
        dayChanged = true;
        this.renderContactsList();

        if (this.currentDay === 4) {
          this.showToast('Day 4 Dawn', true);
          this.triggerDay4Scout();
        } else if (this.currentDay === 5) {
          this.triggerInvasionWave(5, RIVAL_INVADER_COUNT);
        } else if (this.currentDay > MAX_DAYS) {
          if (this.invasionActive) {
            this.completeInvasionWave(false);
          }
          const endlessCount = Math.min(MAX_RIVAL_POOL, 12 + (this.currentDay - MAX_DAYS) * 2);
          this.triggerInvasionWave(this.currentDay, endlessCount);
        } else {
          this.showToast(`Day ${this.currentDay} Dawn`, true);
        }
      }

      if (this.invasionActive) {
        this.invasionElapsed += dt;
        let remainingRivals = 0;
        for (let i = 0; i < this.rivalInvaders.length; i++) {
          const r = this.rivalInvaders[i];
          if (r.active && r.attackState !== 'retreating') {
            remainingRivals++;
          }
        }
        if (remainingRivals === 0 || this.invasionElapsed >= INVASION_DURATION_SECONDS) {
          this.completeInvasionWave(remainingRivals === 0);
        }
      }

      const dayProg = Math.min(1, this.dayElapsed / DAY_DURATION_SECONDS);
      this.environment.setTimeOfDay(dayProg);
      this.hudRefreshAccum += dt;
      if (dayChanged || this.hudRefreshAccum >= 0.25) {
        this.refreshHudLabels();
      }
    }

    // 2. Backup Timer Countdown
    const backupActive = this.backupTimer > 0;
    if (backupActive) {
      this.backupTimer = Math.max(0, this.backupTimer - dt);
      if (Math.floor(this.backupTimer + dt) !== Math.floor(this.backupTimer) || this.backupTimer === 0) {
        this.renderContactsList();
      }
      if (this.backupTimer === 0) {
        for (let i = 0; i < this.contacts.length; i++) {
          const slot = this.perchBirds[this.contacts[i].slotIndex];
          if (slot) {
            slot.rig.pistolGroup.visible = false;
            slot.pos.copy(slot.perchPos);
            slot.rig.root.position.copy(slot.perchPos);
            slot.rig.wingL.rotation.z = 0;
            slot.rig.wingR.rotation.z = 0;
          }
        }
        this.showToast('Backup team returned to perches.', false);
      }
    }

    // 3. Update 10 Perch Birds (Neutral, Ally/GF Backup, Hostile Rejected)
    let nearNeutralPrompt = false;
    for (let i = 0; i < this.perchBirds.length; i++) {
      const b = this.perchBirds[i];
      if (b.state === 'defeated') continue;
      if (b.peacefulKarmaCooldown > 0) {
        b.peacefulKarmaCooldown = Math.max(0, b.peacefulKarmaCooldown - dt);
      }
      if (b.muzzleTimer > 0) {
        b.muzzleTimer -= dt;
        if (b.muzzleTimer <= 0) b.rig.muzzleFlash.visible = false;
      }

      if (b.state === 'neutral') {
        const dSq = b.pos.distanceToSquared(birdPos);
        if (dSq <= COURT_RANGE_SQ) {
          nearNeutralPrompt = true;
        }
        if (
          this.active &&
          !this.gunEquipped &&
          dSq <= PEACEFUL_KARMA_RANGE_SQ &&
          b.peacefulKarmaCooldown <= 0
        ) {
          b.peacefulKarmaCooldown = 14.0;
          this.addKarma(10, 'Peaceful Bird Flyby');
        }
        // Subtle attentive head/body turn toward Birdy when nearby; pause far idle bobbing for 60 FPS
        const farIdle = camPos ? b.pos.distanceToSquared(camPos) > 105 * 105 : false;
        if (!farIdle) {
          if (dSq < 28 * 28) {
            b.yaw = Math.atan2(birdPos.x - b.pos.x, birdPos.z - b.pos.z);
            b.rig.root.rotation.y = b.yaw;
          }
          b.rig.bodyGroup.position.y = Math.sin(elapsed * 3.1 + b.flapPhase) * 0.03;
        }
      } else if (b.state === 'ally') {
        b.rig.heartGroup.rotation.y = elapsed * 2.4 + b.index;
        b.rig.heartGroup.position.y = 0.96 + Math.sin(elapsed * 3.6 + b.index) * 0.08;

        if (backupActive) {
          // Wingman formation flight beside Birdy + auto-shoot hostiles!
          b.orbitAngle += dt * 1.45;
          const slotIdx = i % 5;
          _desiredPos.set(
            birdPos.x + Math.cos(b.orbitAngle + slotIdx * 1.25) * (3.6 + slotIdx * 0.8),
            birdPos.y + 0.9 + Math.sin(elapsed * 2.2 + slotIdx) * 0.7,
            birdPos.z + Math.sin(b.orbitAngle + slotIdx * 1.25) * (3.6 + slotIdx * 0.8)
          );
          _toDesired.subVectors(_desiredPos, b.pos);
          b.pos.addScaledVector(_toDesired, Math.min(1, dt * 4.5));
          b.yaw = Math.atan2(_toDesired.x || 0.001, _toDesired.z || 1);
          b.rig.root.position.copy(b.pos);
          b.rig.root.rotation.y = b.yaw;

          const flap = Math.sin(elapsed * 18 + b.flapPhase) * 0.65;
          b.rig.wingL.rotation.z = flap;
          b.rig.wingR.rotation.z = -flap;

          b.fireCooldown -= dt;
          if (b.fireCooldown <= 0) {
            const target = this.findClosestHostileAerialTarget(b.pos, 72 * 72);
            if (target) {
              b.fireCooldown = 0.55;
              _shootOrigin.set(b.pos.x, b.pos.y + 0.25, b.pos.z);
              _shootDir.subVectors(target.pos, _shootOrigin).normalize();
              b.yaw = Math.atan2(_shootDir.x, _shootDir.z);
              b.rig.root.rotation.y = b.yaw;
              this.spawnBullet(_shootOrigin, _shootDir, ALLY_BULLET_SPEED, 'ally');
              b.rig.muzzleFlash.visible = true;
              b.muzzleTimer = 0.06;
              this.audio.playGunshot(_shootOrigin);
            } else {
              b.fireCooldown = 0.2;
            }
          }
        } else {
          b.rig.wingL.rotation.z = 0;
          b.rig.wingR.rotation.z = 0;
        }
      } else if (b.state === 'hostile') {
        b.orbitAngle += dt * 1.35;
        _desiredPos.set(
          birdPos.x + Math.cos(b.orbitAngle) * b.orbitRadius,
          Math.max(8, birdPos.y + b.orbitHeight + Math.sin(elapsed * 2.0 + b.index) * 1.4),
          birdPos.z + Math.sin(b.orbitAngle) * b.orbitRadius
        );
        _toDesired.subVectors(_desiredPos, b.pos);
        b.pos.addScaledVector(_toDesired, Math.min(1, dt * 2.6));
        b.yaw = Math.atan2(birdPos.x - b.pos.x, birdPos.z - b.pos.z);
        b.rig.root.position.copy(b.pos);
        b.rig.root.rotation.y = b.yaw;

        const flap = Math.sin(elapsed * 19 + b.flapPhase) * 0.68;
        b.rig.wingL.rotation.z = flap;
        b.rig.wingR.rotation.z = -flap;

        b.fireCooldown -= dt;
        if (b.fireCooldown <= 0 && b.pos.distanceToSquared(birdPos) < 62 * 62) {
          b.fireCooldown = 1.65 + Math.random() * 0.5;
          _shootOrigin.set(b.pos.x, b.pos.y + 0.25, b.pos.z);
          _shootDir.subVectors(birdPos, _shootOrigin);
          _shootDir.x += (Math.random() - 0.5) * 0.14;
          _shootDir.y += (Math.random() - 0.5) * 0.12;
          _shootDir.z += (Math.random() - 0.5) * 0.14;
          _shootDir.normalize();
          this.spawnBullet(_shootOrigin, _shootDir, ENEMY_BULLET_SPEED, 'enemy');
          b.rig.muzzleFlash.visible = true;
          b.muzzleTimer = 0.06;
          this.audio.playGunshot(_shootOrigin);
        }
      }
    }

    // Update contextual Hold-'E' friendship prompt & progress (diff-checked so DOM is untouched on steady frames)
    this.nearNeutralBirdCached = nearNeutralPrompt;
    if (!nearNeutralPrompt) {
      this.befriendHoldTime = 0;
    } else if (
      this.active &&
      this.holdingBefriendKey &&
      !this.befriendTriggeredDuringHold &&
      this.currentDay >= MAX_DAYS
    ) {
      this.befriendHoldTime += dt;
      if (this.befriendHoldTime >= BEFRIEND_HOLD_SECONDS) {
        this.befriendHoldTime = 0;
        this.befriendTriggeredDuringHold = true;
        this.tryCourtNearbyBird(true);
      }
    }

    const showCourtPrompt = this.active && nearNeutralPrompt;
    if (showCourtPrompt) {
      let nextCourtText = '[Hold E (1s) to Befriend]';
      if (this.currentDay >= MAX_DAYS && this.holdingBefriendKey && this.befriendHoldTime > 0.04) {
        const pct = Math.min(100, Math.round((this.befriendHoldTime / BEFRIEND_HOLD_SECONDS) * 100));
        nextCourtText = `[Holding E... ${pct}%]`;
      }
      if (nextCourtText !== this.lastCourtText) {
        this.lastCourtText = nextCourtText;
        this.courtPromptEl.textContent = nextCourtText;
      }
    }
    if (showCourtPrompt !== this.lastCourtVisible) {
      this.lastCourtVisible = showCourtPrompt;
      this.courtPromptEl.classList.toggle('is-hidden', !showCourtPrompt);
    }

    // 4. Day 4 Scout Pigeon in Sunglasses
    if (this.scoutActive) {
      if (this.scoutFleeing) {
        this.scoutPos.addScaledVector(this.scoutFleeVel, dt);
        this.scoutRig.root.position.copy(this.scoutPos);
        const flap = Math.sin(elapsed * 20) * 0.72;
        this.scoutRig.wingL.rotation.z = flap;
        this.scoutRig.wingR.rotation.z = -flap;
        if (this.scoutPos.y > 140) {
          this.scoutActive = false;
          this.scoutRig.root.visible = false;
        }
      } else {
        if (this.scoutKarmaCooldown > 0) this.scoutKarmaCooldown -= dt;
        const dSq = this.scoutPos.distanceToSquared(birdPos);
        if (!this.gunEquipped && dSq <= PEACEFUL_KARMA_RANGE_SQ && this.scoutKarmaCooldown <= 0) {
          this.scoutKarmaCooldown = 14.0;
          this.addKarma(10, 'Peaceful Near Scout');
        }
        this.scoutRig.root.rotation.y = Math.atan2(
          birdPos.x - this.scoutPos.x,
          birdPos.z - this.scoutPos.z
        );
      }
    }

    // 5. Rival City Flock Invaders: Boids Steering + Staggered One-by-One Swoop Attacks
    // Loose drifting airspace centroid above/around the player (no stiff circular ring or single-file conga line)
    _flockAnchor.set(
      birdPos.x + Math.sin(elapsed * 0.34) * 18.0,
      Math.max(16.0, birdPos.y + 11.5 + Math.cos(elapsed * 0.52) * 3.5),
      birdPos.z + Math.cos(elapsed * 0.29) * 18.0
    );

    const escalationBoost =
      this.currentDay > MAX_DAYS ? Math.min(4.5, (this.currentDay - MAX_DAYS) * 0.85) : 0;

    for (let i = 0; i < this.rivalInvaders.length; i++) {
      const r = this.rivalInvaders[i];
      if (!r.active) continue;
      if (r.muzzleTimer > 0) {
        r.muzzleTimer -= dt;
        if (r.muzzleTimer <= 0) r.rig.muzzleFlash.visible = false;
      }

      if (r.attackState === 'retreating') {
        r.swoopTimer -= dt;
        r.vel.y = Math.min(24.0, r.vel.y + 12.0 * dt);
        r.pos.addScaledVector(r.vel, dt);
        r.yaw = Math.atan2(r.vel.x || 0.001, r.vel.z || 1);
        r.rig.root.position.copy(r.pos);
        r.rig.root.rotation.y = r.yaw;
        r.rig.bodyGroup.rotation.set(-0.35, 0, 0);
        const fastFlap = Math.sin(elapsed * 26 + r.flapPhase) * 0.78;
        r.rig.wingL.rotation.z = fastFlap;
        r.rig.wingR.rotation.z = -fastFlap;
        if (r.pos.y > 155 || r.swoopTimer <= 0) {
          r.active = false;
          r.rig.root.visible = false;
        }
        continue;
      }

      // Compute lightweight Boids forces (separation, alignment, cohesion) against nearby flockmates
      _boidSep.set(0, 0, 0);
      _boidAlign.set(0, 0, 0);
      _boidCohes.set(0, 0, 0);
      let neighborCount = 0;

      for (let j = 0; j < this.rivalInvaders.length; j++) {
        if (i === j) continue;
        const other = this.rivalInvaders[j];
        if (!other.active || other.attackState === 'retreating') continue;

        _boidDiff.subVectors(r.pos, other.pos);
        const distSq = _boidDiff.lengthSq();
        if (distSq > 0.0001 && distSq < 6.8 * 6.8) {
          const dist = Math.sqrt(distSq);
          const weight = (6.8 - dist) / 6.8;
          _boidSep.addScaledVector(_boidDiff, weight / dist);
        }
        if (distSq < 20.0 * 20.0) {
          _boidAlign.add(other.vel);
          _boidCohes.add(other.pos);
          neighborCount++;
        }
      }

      _boidSteer.set(0, 0, 0);

      if (r.attackState === 'flocking') {
        r.attackCooldown -= dt;
        if (r.attackCooldown <= 0 && this.globalRivalSwoopCooldown <= 0) {
          // Peel off from the swarm individually to execute a swoop attack pass
          r.attackState = 'swooping';
          r.swoopTimer = 1.85;
          r.hasFiredInSwoop = false;
          this.globalRivalSwoopCooldown = Math.max(0.55, 1.05 - escalationBoost * 0.08);
        }
      }

      if (r.attackState === 'swooping') {
        r.swoopTimer -= dt;
        // Dive on an offset intercept pass near Birdy rather than head-on stacking
        const passOffX = Math.sin(r.wanderPhase + elapsed * 0.5) * 4.2;
        const passOffZ = Math.cos(r.wanderPhase + elapsed * 0.5) * 4.2;
        _swoopTarget.set(
          birdPos.x + passOffX,
          Math.max(4.8, birdPos.y + 1.1),
          birdPos.z + passOffZ
        );
        _toDesired.subVectors(_swoopTarget, r.pos);
        const distToTarget = _toDesired.length();
        if (distToTarget > 0.01) {
          _toDesired.divideScalar(distToTarget);
          _boidSteer.addScaledVector(_toDesired, 36.0 + escalationBoost * 2.0);
        }
        // Keep mild personal separation even during swoops
        _boidSteer.addScaledVector(_boidSep, 14.0);

        if (!r.hasFiredInSwoop && r.swoopTimer <= 1.35 && distToTarget < 64.0) {
          r.hasFiredInSwoop = true;
          _shootOrigin.set(r.pos.x, r.pos.y + 0.25, r.pos.z);
          _shootDir.subVectors(birdPos, _shootOrigin);
          _shootDir.x += (Math.random() - 0.5) * 0.14;
          _shootDir.y += (Math.random() - 0.5) * 0.11;
          _shootDir.z += (Math.random() - 0.5) * 0.14;
          _shootDir.normalize();
          this.spawnBullet(_shootOrigin, _shootDir, ENEMY_BULLET_SPEED, 'enemy');
          r.rig.muzzleFlash.visible = true;
          r.muzzleTimer = 0.06;
          this.audio.playGunshot(_shootOrigin);
        }

        if (r.swoopTimer <= 0 || distToTarget < 4.5) {
          r.attackState = 'flocking';
          r.vel.y = Math.max(r.vel.y + 4.5, 9.0);
          r.attackCooldown =
            Math.max(2.4, 4.4 - escalationBoost * 0.35) +
            Math.random() * 4.2 +
            (i % 4) * 0.65;
        }
      } else {
        // Boids flocking steering: Separation + Alignment + Cohesion + General Airspace Drift
        _boidSteer.addScaledVector(_boidSep, 30.0);

        if (neighborCount > 0) {
          const invN = 1 / neighborCount;
          _boidAlign.multiplyScalar(invN);
          const alignLen = _boidAlign.length();
          if (alignLen > 0.01) {
            _boidAlign.multiplyScalar((16.5 + escalationBoost) / alignLen).sub(r.vel);
            _boidSteer.addScaledVector(_boidAlign, 1.35);
          }

          _boidCohes.multiplyScalar(invN).sub(r.pos);
          const cohLen = _boidCohes.length();
          if (cohLen > 0.01) {
            _boidCohes.multiplyScalar(1 / cohLen);
            _boidSteer.addScaledVector(_boidCohes, 8.5);
          }
        }

        // Gentle guidance toward a personal drifting pocket in the player's general airspace
        _desiredPos.set(
          _flockAnchor.x + Math.cos(elapsed * 0.58 + r.wanderPhase) * 24.0,
          _flockAnchor.y + Math.sin(elapsed * 1.15 + r.wanderPhase * 1.7) * 5.2,
          _flockAnchor.z + Math.sin(elapsed * 0.51 + r.wanderPhase * 1.3) * 24.0
        );
        _toDesired.subVectors(_desiredPos, r.pos);
        const homeDist = _toDesired.length();
        if (homeDist > 0.01) {
          const pullStrength = homeDist > 42.0 ? 24.0 : 12.0;
          _boidSteer.addScaledVector(_toDesired, pullStrength / homeDist);
        }
      }

      // Clamp steering acceleration & integrate velocity
      const steerSq = _boidSteer.lengthSq();
      const maxAccel = r.attackState === 'swooping' ? 46.0 : 32.0;
      if (steerSq > maxAccel * maxAccel) {
        _boidSteer.multiplyScalar(maxAccel / Math.sqrt(steerSq));
      }
      r.vel.addScaledVector(_boidSteer, dt);

      const speedSq = r.vel.lengthSq();
      const minSpd = 9.0;
      const maxSpd = r.attackState === 'swooping' ? 27.0 + escalationBoost : 19.5 + escalationBoost;
      if (speedSq < minSpd * minSpd && speedSq > 0.0001) {
        r.vel.multiplyScalar(minSpd / Math.sqrt(speedSq));
      } else if (speedSq > maxSpd * maxSpd) {
        r.vel.multiplyScalar(maxSpd / Math.sqrt(speedSq));
      }

      r.pos.addScaledVector(r.vel, dt);
      if (r.pos.y < 7.5) {
        r.pos.y = 7.5;
        if (r.vel.y < 2.0) r.vel.y = 4.0;
      }

      const targetYaw =
        r.attackState === 'swooping'
          ? Math.atan2(birdPos.x - r.pos.x, birdPos.z - r.pos.z)
          : Math.atan2(r.vel.x || 0.001, r.vel.z || 1);
      let dyaw = targetYaw - r.yaw;
      while (dyaw > Math.PI) dyaw -= Math.PI * 2;
      while (dyaw < -Math.PI) dyaw += Math.PI * 2;
      r.yaw += dyaw * Math.min(1, dt * 7.0);

      r.rig.root.position.copy(r.pos);
      r.rig.root.rotation.y = r.yaw;
      // Natural aerodynamic bank & pitch tilt
      const targetBank = Math.max(-0.55, Math.min(0.55, -dyaw * 0.45));
      const targetPitch = Math.max(-0.48, Math.min(0.48, -r.vel.y * 0.032));
      r.rig.bodyGroup.rotation.z += (targetBank - r.rig.bodyGroup.rotation.z) * Math.min(1, dt * 8.0);
      r.rig.bodyGroup.rotation.x += (targetPitch - r.rig.bodyGroup.rotation.x) * Math.min(1, dt * 8.0);

      const flapSpeed = r.attackState === 'swooping' ? 24 : 18.5;
      const flap = Math.sin(elapsed * flapSpeed + r.flapPhase) * 0.68;
      r.rig.wingL.rotation.z = flap;
      r.rig.wingR.rotation.z = -flap;
    }

    // 6. Day 5 Friendly Karma Defenders (0-12)
    for (let i = 0; i < this.karmaDefenders.length; i++) {
      const d = this.karmaDefenders[i];
      if (!d.active) continue;
      if (d.muzzleTimer > 0) {
        d.muzzleTimer -= dt;
        if (d.muzzleTimer <= 0) d.rig.muzzleFlash.visible = false;
      }
      d.orbitAngle += dt * 1.65;
      _desiredPos.set(
        birdPos.x + Math.cos(d.orbitAngle) * (6.2 + (i % 3) * 1.8),
        Math.max(7, birdPos.y + 1.8 + Math.sin(elapsed * 2.5 + i) * 1.2),
        birdPos.z + Math.sin(d.orbitAngle) * (6.2 + (i % 3) * 1.8)
      );
      _toDesired.subVectors(_desiredPos, d.pos);
      d.pos.addScaledVector(_toDesired, Math.min(1, dt * 4.2));
      d.yaw = Math.atan2(_toDesired.x || 0.001, _toDesired.z || 1);
      d.rig.root.position.copy(d.pos);
      d.rig.root.rotation.y = d.yaw;

      const flap = Math.sin(elapsed * 18 + d.flapPhase) * 0.65;
      d.rig.wingL.rotation.z = flap;
      d.rig.wingR.rotation.z = -flap;

      d.fireCooldown -= dt;
      if (d.fireCooldown <= 0) {
        const target = this.findClosestHostileAerialTarget(d.pos, 85 * 85);
        if (target) {
          d.fireCooldown = 0.52;
          _shootOrigin.set(d.pos.x, d.pos.y + 0.25, d.pos.z);
          _shootDir.subVectors(target.pos, _shootOrigin).normalize();
          d.yaw = Math.atan2(_shootDir.x, _shootDir.z);
          d.rig.root.rotation.y = d.yaw;
          this.spawnBullet(_shootOrigin, _shootDir, ALLY_BULLET_SPEED, 'ally');
          d.rig.muzzleFlash.visible = true;
          d.muzzleTimer = 0.06;
          this.audio.playGunshot(_shootOrigin);
        } else {
          d.fireCooldown = 0.25;
        }
      }
    }

    // 7. Step Pooled Aerial Bullets
    for (let i = 0; i < this.bullets.length; i++) {
      const bl = this.bullets[i];
      if (!bl.active) continue;
      bl.age += dt;
      if (bl.age >= AERIAL_BULLET_MAX_AGE) {
        bl.active = false;
        bl.mesh.visible = false;
        continue;
      }

      bl.prevPos.copy(bl.pos);
      _bulletNext.copy(bl.pos).addScaledVector(bl.vel, dt);
      _bulletRayDir.subVectors(_bulletNext, bl.prevPos);
      const segLen = _bulletRayDir.length();
      if (segLen > 1e-5) {
        _bulletRayDir.divideScalar(segLen);
        const wallHit = this.physics.raycastGround(
          bl.prevPos,
          _bulletRayDir,
          segLen + 0.05,
          undefined,
          _bulletWallHit,
          COLLISION_GROUP_STATIC
        );
        const maxTravel = wallHit.hit ? wallHit.distance : segLen;

        if (bl.owner === 'enemy') {
          _bulletToBird.subVectors(birdPos, bl.prevPos);
          const proj = Math.max(0, Math.min(maxTravel, _bulletToBird.dot(_bulletRayDir)));
          _bulletClosest.copy(bl.prevPos).addScaledVector(_bulletRayDir, proj);
          if (_bulletClosest.distanceToSquared(birdPos) <= BIRD_HURT_RADIUS * BIRD_HURT_RADIUS) {
            bl.active = false;
            bl.mesh.visible = false;
            this.applyPlayerDamage();
            continue;
          }
        } else {
          // Ally bullet vs hostile aerial targets
          let hitAllyTarget = false;
          for (let rIdx = 0; rIdx < this.rivalInvaders.length; rIdx++) {
            const r = this.rivalInvaders[rIdx];
            if (!r.active) continue;
            const d = intersectSegmentSphere(
              bl.prevPos,
              _bulletNext,
              r.pos,
              BIRD_HIT_RADIUS_SQ * 1.4,
              _hitPtScratch
            );
            if (d >= 0 && d <= maxTravel) {
              bl.active = false;
              bl.mesh.visible = false;
              r.active = false;
              r.rig.root.visible = false;
              this.fx.spawnFeatherBurst(r.pos, 9, 3.8);
              this.awardExternalXp(50, r.pos);
              hitAllyTarget = true;
              break;
            }
          }
          if (!hitAllyTarget) {
            for (let pIdx = 0; pIdx < this.perchBirds.length; pIdx++) {
              const b = this.perchBirds[pIdx];
              if (b.state !== 'hostile') continue;
              const d = intersectSegmentSphere(
                bl.prevPos,
                _bulletNext,
                b.pos,
                BIRD_HIT_RADIUS_SQ * 1.4,
                _hitPtScratch
              );
              if (d >= 0 && d <= maxTravel) {
                bl.active = false;
                bl.mesh.visible = false;
                b.state = 'defeated';
                b.rig.root.visible = false;
                this.fx.spawnFeatherBurst(b.pos, 9, 3.8);
                this.awardExternalXp(50, b.pos);
                hitAllyTarget = true;
                break;
              }
            }
          }
          if (hitAllyTarget) continue;
        }

        if (wallHit.hit) {
          bl.active = false;
          bl.mesh.visible = false;
          continue;
        }
      }

      bl.pos.copy(_bulletNext);
      bl.mesh.position.copy(bl.pos);
    }

    // 8. Step Pooled Breadcrumbs ('C' Key)
    for (let i = 0; i < this.crumbs.length; i++) {
      const c = this.crumbs[i];
      if (!c.active) continue;
      c.age += dt;
      if (c.age > 8.0) {
        c.active = false;
        c.mesh.visible = false;
        continue;
      }
      if (!c.settled) {
        c.vel.y -= 14.0 * dt;
        c.pos.addScaledVector(c.vel, dt);
        if (c.pos.y <= 0.12) {
          c.pos.y = 0.12;
          c.settled = true;
        }
        c.mesh.position.copy(c.pos);
      }
    }
  }

  public dispose(): void {
    this.abortCtrl.abort();
    for (let i = 0; i < this.unsubFns.length; i++) {
      this.unsubFns[i]();
    }
    this.unsubFns.length = 0;
    if (this.toastTimer !== null) {
      window.clearTimeout(this.toastTimer);
      this.toastTimer = null;
    }
    this.topHudRoot.remove();
    this.courtPromptEl.remove();
    this.toastEl.remove();
    this.phoneRoot.remove();
    this.group.parent?.remove(this.group);

    for (const g of this.bodyGeos) g.dispose();
    for (const g of this.wingLGeos) g.dispose();
    for (const g of this.wingRGeos) g.dispose();
    this.tinyPistolGeo.dispose();
    this.sunglassesGeo.dispose();
    this.heartGeo.dispose();
    this.muzzleGeo.dispose();
    this.bulletGeo.dispose();
    this.crumbGeo.dispose();
    this.bulletMatEnemy.dispose();
    this.bulletMatAlly.dispose();
    this.muzzleMat.dispose();
    this.heartMat.dispose();
    this.crumbMat.dispose();
  }
}
