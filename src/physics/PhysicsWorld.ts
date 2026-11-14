import * as CANNON from 'cannon-es';
import * as THREE from 'three/webgpu';
import { SpatialGrid2D } from '../core/SpatialGrid2D.ts';
import { WORLD_CONFIG } from '../core/WorldConfig.ts';

export const COLLISION_GROUP_STATIC = 1;
export const COLLISION_GROUP_DYNAMIC = 2;
export const COLLISION_GROUP_KINEMATIC = 4;

export type PropKind =
  | 'seed'
  | 'sugar_cube'
  | 'croissant'
  | 'shiny_coin'
  | 'brass_key'
  | 'eyeglasses'
  | 'berry'
  | 'flower_sprig'
  | 'twig'
  | 'ribbon'
  | 'velvet_down'
  | 'coffee_cup'
  | 'paper_airplane'
  | 'pinecone'
  | 'apple'
  | 'gelato_cone'
  | 'baguette'
  | 'ceramic_mug'
  | 'teacup'
  | 'porcelain_plate'
  | 'pigment_jar'
  | 'terracotta_pot'
  | 'glass_carafe'
  | 'ceramic_vase'
  | 'studio_book';

export interface BreakableSpec {
  /** Normal contact velocity (SU/s) on collision required to shatter this prop */
  impactSpeedThreshold: number;
  /** Number of direct beak pecks required to crack/shatter this prop */
  peckHitsToBreak: number;
  /** Glazed shard color hex */
  shardHex: number;
  onBreak?: (prop: InteractiveProp, pos: THREE.Vector3) => void;
}

export interface InteractiveProp {
  id: string;
  kind: PropKind;
  mesh: THREE.Object3D;
  body: CANNON.Body;
  grabbable: boolean;
  /** Approximate bounding radius for bird body-pushing & beak contact */
  pushRadius: number;
  /** Weight factor when held in beak (0 = featherlight, 1 = heavy eyeglasses/key/croissant) */
  beakWeight: number;
  /** Local offset from beak tip when carried */
  carryOffset: THREE.Vector3;
  carried: boolean;
  consumed: boolean;
  broken: boolean;
  homePos: THREE.Vector3;
  tintHex?: number;
  isNestMaterial?: boolean;
  glideLift?: boolean;
  splashCooldown: number;
  pushCooldown: number;
  toppled: boolean;
  onTopple?: (prop: InteractiveProp, pos: THREE.Vector3) => void;
  breakable?: BreakableSpec;
  peckHitsRemaining: number;
  pendingImpactSpeed: number;
  pendingCollisionSfxSpeed: number;
  impactSfxCooldown: number;
  waterRespawnTimer?: number;
  inWater?: boolean;
  buoyant?: boolean;
  waterRippleTimer?: number;
  syncedWhileSleeping?: boolean;
}

export interface TrampolineZone {
  id: string;
  center: THREE.Vector3;
  halfExtents: THREE.Vector3;
  bounceSpeed: number;
  meshToSquash?: THREE.Object3D;
  squashPhase: number;
  baseScaleY: number;
}

export interface UpdraftZone {
  id: string;
  x: number;
  z: number;
  yMin: number;
  yMax: number;
  radius: number;
  liftAccel: number;
  active: boolean;
}

export interface LiquidBasin {
  id: string;
  center: THREE.Vector3;
  radius: number;
  /** Optional inner exclusion radius (e.g. around a fountain central column) */
  innerRadius?: number;
  /** Optional rectangular canal half-extents (when set, overrides circular radius check) */
  boxHalfX?: number;
  boxHalfZ?: number;
  surfaceY: number;
  onPropSplash?: (prop: InteractiveProp) => void;
}

function basinContainsXZ(b: LiquidBasin, x: number, z: number): boolean {
  if (b.boxHalfX !== undefined && b.boxHalfZ !== undefined) {
    return Math.abs(x - b.center.x) <= b.boxHalfX && Math.abs(z - b.center.z) <= b.boxHalfZ;
  }
  const dx = x - b.center.x;
  const dz = z - b.center.z;
  const dSq = dx * dx + dz * dz;
  if (dSq > b.radius * b.radius) return false;
  if (b.innerRadius !== undefined && dSq < b.innerRadius * b.innerRadius) return false;
  return true;
}

export interface PeckSwitch {
  id: string;
  position: THREE.Vector3;
  radius: number;
  cooldown: number;
  onPeck: () => void;
}

export interface BumpMetadata {
  surface: 'wood' | 'metal' | 'foliage' | 'human' | 'stone' | 'ceramic';
  /** If false, bumping plays a cute nudge instead of knocking the bird dizzy (e.g. trees, humans, props) */
  causesDizzy?: boolean;
  onBump?: (hitPoint: THREE.Vector3, impactSpeed: number) => void;
}

export interface GroundRaycastHit {
  hit: boolean;
  point: THREE.Vector3;
  normal: THREE.Vector3;
  distance: number;
  body: CANNON.Body | null;
}

/** Allocates a reusable `out` target for raycastGround. */
export function createGroundRaycastHit(): GroundRaycastHit {
  return {
    hit: false,
    point: new THREE.Vector3(),
    normal: new THREE.Vector3(0, 1, 0),
    distance: 0,
    body: null,
  };
}

export interface StaticCameraHit {
  hit: boolean;
  distance: number;
  normal: THREE.Vector3;
}

const _bumpPush = new THREE.Vector3();
const _impulseVec = new CANNON.Vec3();
const _worldPtVec = new CANNON.Vec3();
const _liftForceVec = new CANNON.Vec3();
const _shatterPos = new THREE.Vector3();
const _ripplePos = new THREE.Vector3();
const _updraftPos = new THREE.Vector3();
const _eulerQuat = new THREE.Quaternion();

export type NoWalkZoneCategory = 'water' | 'bridge_edge' | 'building' | 'outer_wall';

export type StaticObstacle2D =
  | {
      kind: 'circle';
      category?: NoWalkZoneCategory;
      x: number;
      z: number;
      radius: number;
      minX: number;
      maxX: number;
      minZ: number;
      maxZ: number;
    }
  | {
      kind: 'box';
      category?: NoWalkZoneCategory;
      x: number;
      z: number;
      hx: number;
      hz: number;
      cosYaw: number;
      sinYaw: number;
      minX: number;
      maxX: number;
      minZ: number;
      maxZ: number;
    };

const OBSTACLE_CELL_SIZE = 16;
const OUTER_WALK_BOUND = WORLD_CONFIG.perimeterSoftMargin - 8.5; // 311.5 SU strictly inside ±316 SU perimeter facades
function packCellKey(cx: number, cz: number): number {
  return ((cx + 512) << 12) | ((cz + 512) & 0xfff);
}

/**
 * Manages cannon-es rigid-body simulation across the multi-block European neighborhood (~300 x 300 SU),
 * static & kinematic colliders, contextual bump reactions, bouncy awnings, thermal updrafts,
 * canal & fountain basins, peckable switches, body-pushable clutter, and destructible ceramic/glass props.
 */
export class PhysicsWorld {
  public readonly world: CANNON.World;
  public readonly defaultMat: CANNON.Material;
  public readonly bouncyMat: CANNON.Material;

  public props: InteractiveProp[] = [];
  public trampolines: TrampolineZone[] = [];
  public updrafts: UpdraftZone[] = [];
  public basins: LiquidBasin[] = [];
  public peckSwitches: PeckSwitch[] = [];

  private bumpMap = new WeakMap<CANNON.Body, BumpMetadata>();
  private attachMap = new WeakMap<CANNON.Body, THREE.Object3D>();
  private propByBody = new WeakMap<CANNON.Body, InteractiveProp>();
  private propsNeedCompact = false;

  private readonly propGrid = new SpatialGrid2D<InteractiveProp>(WORLD_CONFIG.spatialGridCellSize);
  private readonly peckSwitchGrid = new SpatialGrid2D<PeckSwitch>(8.0);
  private readonly propsByKind = new Map<PropKind, InteractiveProp[]>();
  private readonly nestMaterialProps: InteractiveProp[] = [];
  private readonly glideLiftProps: InteractiveProp[] = [];
  private readonly buoyantProps: InteractiveProp[] = [];
  private readonly activeSquashTrampolines: TrampolineZone[] = [];
  private readonly obstacleCells = new Map<number, StaticObstacle2D[]>();
  private readonly staticObstacles: StaticObstacle2D[] = [];
  private readonly noWalkCells = new Map<number, StaticObstacle2D[]>();
  private readonly noWalkZones: StaticObstacle2D[] = [];
  private readonly preStepHandler: () => void;

  private rayFrom = new CANNON.Vec3();
  private rayTo = new CANNON.Vec3();
  private rayResult = new CANNON.RaycastResult();
  private rayOptions = { skipBackfaces: true, collisionFilterMask: -1 };
  private staticRayOptions = {
    skipBackfaces: true,
    collisionFilterMask: COLLISION_GROUP_STATIC | COLLISION_GROUP_KINEMATIC,
  };
  private staticCamHit: StaticCameraHit = {
    hit: false,
    distance: 0,
    normal: new THREE.Vector3(0, 1, 0),
  };

  private simElapsed = 0;
  public onPropShatter?: (
    prop: InteractiveProp,
    pos: THREE.Vector3,
    shardHex: number
  ) => void;
  public onPropImpact?: (
    prop: InteractiveProp,
    pos: THREE.Vector3,
    impactSpeed: number
  ) => void;
  public onPropWaterSplosh?: (
    prop: InteractiveProp,
    pos: THREE.Vector3,
    impactSpeed: number
  ) => void;

  constructor() {
    this.world = new CANNON.World({
      gravity: new CANNON.Vec3(0, -24.0, 0),
      allowSleep: true,
    });

    const solver = new CANNON.GSSolver();
    solver.iterations = 8;
    solver.tolerance = 0.001;
    this.world.solver = solver;
    this.world.broadphase = new CANNON.SAPBroadphase(this.world);

    this.defaultMat = new CANNON.Material('default');
    this.bouncyMat = new CANNON.Material('bouncy');

    this.world.defaultContactMaterial.friction = 0.48;
    this.world.defaultContactMaterial.restitution = 0.22;

    this.world.addContactMaterial(
      new CANNON.ContactMaterial(this.defaultMat, this.bouncyMat, {
        friction: 0.25,
        restitution: 0.78,
      })
    );

    // Apply aerodynamic glide & thermal forces inside preStep so 60/120/240Hz substeps all receive the force.
    this.preStepHandler = () => {
      for (let i = 0; i < this.glideLiftProps.length; i++) {
        const p = this.glideLiftProps[i];
        if (p.consumed || p.carried || p.waterRespawnTimer !== undefined) continue;
        if (p.body.velocity.lengthSquared() <= 1.5) continue;

        const horizSpeed = Math.hypot(p.body.velocity.x, p.body.velocity.z);
        const lift = Math.min(21.5, horizSpeed * 2.1);
        _updraftPos.set(p.body.position.x, p.body.position.y, p.body.position.z);
        const upLift = this.sampleUpdraftLift(_updraftPos);
        const totalLiftAccel = lift + (upLift > 0 ? upLift * 0.7 : 0);
        _liftForceVec.set(0, totalLiftAccel * p.body.mass, 0);
        p.body.applyForce(_liftForceVec, p.body.position);
      }
    };
    this.world.addEventListener('preStep', this.preStepHandler);
  }

  public setBumpMetadata(body: CANNON.Body, meta: BumpMetadata): void {
    this.bumpMap.set(body, meta);
  }

  public getBumpMetadata(body: CANNON.Body | null): BumpMetadata | undefined {
    if (!body) return undefined;
    return this.bumpMap.get(body);
  }

  public addStaticBox(
    center: THREE.Vector3,
    halfExtents: THREE.Vector3,
    rotationEuler?: THREE.Euler,
    bouncy = false
  ): CANNON.Body {
    const body = new CANNON.Body({
      mass: 0,
      type: CANNON.Body.STATIC,
      material: bouncy ? this.bouncyMat : this.defaultMat,
      collisionFilterGroup: COLLISION_GROUP_STATIC,
      collisionFilterMask: -1,
    });
    body.addShape(new CANNON.Box(new CANNON.Vec3(halfExtents.x, halfExtents.y, halfExtents.z)));
    body.position.set(center.x, center.y, center.z);
    if (rotationEuler) {
      _eulerQuat.setFromEuler(rotationEuler);
      body.quaternion.set(_eulerQuat.x, _eulerQuat.y, _eulerQuat.z, _eulerQuat.w);
    }
    this.world.addBody(body);

    // Auto-register ground-level static walls, benches, planters & facades into the 2D NPC obstacle grid.
    // Skip thin/elevated bridges & balconies (bottomY >= 2.2) and broad ground slabs (both half-extents > 42 SU).
    const bottomY = center.y - halfExtents.y;
    const topY = center.y + halfExtents.y;
    const isGroundSlab = halfExtents.x > 42 && halfExtents.z > 42;
    const isFlatPaving = halfExtents.y <= 0.35 && topY <= 0.52;
    const hasSignificantTilt =
      rotationEuler !== undefined &&
      (Math.abs(rotationEuler.x) > 0.14 || Math.abs(rotationEuler.z) > 0.14);
    if (!isGroundSlab && !isFlatPaving && !hasSignificantTilt && bottomY < 2.2 && topY > 0.65) {
      const yaw = rotationEuler ? rotationEuler.y : 0;
      const cosYaw = Math.cos(yaw);
      const sinYaw = Math.sin(yaw);
      const absCos = Math.abs(cosYaw);
      const absSin = Math.abs(sinYaw);
      const aabbHx = halfExtents.x * absCos + halfExtents.z * absSin;
      const aabbHz = halfExtents.x * absSin + halfExtents.z * absCos;
      const isBuildingFootprint =
        topY >= 6.0 && (halfExtents.x >= 2.0 || halfExtents.z >= 2.0);
      const obs: StaticObstacle2D = {
        kind: 'box',
        category: isBuildingFootprint ? 'building' : undefined,
        x: center.x,
        z: center.z,
        hx: halfExtents.x,
        hz: halfExtents.z,
        cosYaw,
        sinYaw,
        minX: center.x - aabbHx,
        maxX: center.x + aabbHx,
        minZ: center.z - aabbHz,
        maxZ: center.z + aabbHz,
      };
      this.insertStaticObstacle2D(obs);
      if (isBuildingFootprint) {
        this.insertNoWalkZone2D(obs);
      }
    }
    return body;
  }

  public addStaticCylinder(
    center: THREE.Vector3,
    rTop: number,
    rBottom: number,
    height: number,
    segments = 12
  ): CANNON.Body {
    const body = new CANNON.Body({
      mass: 0,
      type: CANNON.Body.STATIC,
      material: this.defaultMat,
      collisionFilterGroup: COLLISION_GROUP_STATIC,
      collisionFilterMask: -1,
    });
    body.addShape(new CANNON.Cylinder(rTop, rBottom, height, segments));
    body.position.set(center.x, center.y, center.z);
    this.world.addBody(body);

    const bottomY = center.y - height * 0.5;
    const topY = center.y + height * 0.5;
    const rad = Math.max(rTop, rBottom);
    if (bottomY < 2.2 && topY > 0.65 && height > 0.45 && rad > 0.12 && rad < 42) {
      const isBuildingFootprint = topY >= 6.0 && rad >= 2.2;
      const obs: StaticObstacle2D = {
        kind: 'circle',
        category: isBuildingFootprint ? 'building' : undefined,
        x: center.x,
        z: center.z,
        radius: rad,
        minX: center.x - rad,
        maxX: center.x + rad,
        minZ: center.z - rad,
        maxZ: center.z + rad,
      };
      this.insertStaticObstacle2D(obs);
      if (isBuildingFootprint) {
        this.insertNoWalkZone2D(obs);
      }
    }
    return body;
  }

  public insertStaticObstacle2D(obs: StaticObstacle2D): void {
    this.staticObstacles.push(obs);
    const minCx = Math.floor(obs.minX / OBSTACLE_CELL_SIZE);
    const maxCx = Math.floor(obs.maxX / OBSTACLE_CELL_SIZE);
    const minCz = Math.floor(obs.minZ / OBSTACLE_CELL_SIZE);
    const maxCz = Math.floor(obs.maxZ / OBSTACLE_CELL_SIZE);
    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cz = minCz; cz <= maxCz; cz++) {
        const key = packCellKey(cx, cz);
        let bucket = this.obstacleCells.get(key);
        if (!bucket) {
          bucket = [];
          this.obstacleCells.set(key, bucket);
        }
        bucket.push(obs);
      }
    }
  }

  private insertNoWalkZone2D(zone: StaticObstacle2D): void {
    this.noWalkZones.push(zone);
    const minCx = Math.floor(zone.minX / OBSTACLE_CELL_SIZE);
    const maxCx = Math.floor(zone.maxX / OBSTACLE_CELL_SIZE);
    const minCz = Math.floor(zone.minZ / OBSTACLE_CELL_SIZE);
    const maxCz = Math.floor(zone.maxZ / OBSTACLE_CELL_SIZE);
    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cz = minCz; cz <= maxCz; cz++) {
        const key = packCellKey(cx, cz);
        let bucket = this.noWalkCells.get(key);
        if (!bucket) {
          bucket = [];
          this.noWalkCells.set(key, bucket);
        }
        bucket.push(zone);
      }
    }
  }

  public registerNoWalkBox(
    category: NoWalkZoneCategory,
    centerX: number,
    centerZ: number,
    halfX: number,
    halfZ: number,
    yaw = 0,
    alsoAddObstacle = true
  ): void {
    const cosYaw = Math.cos(yaw);
    const sinYaw = Math.sin(yaw);
    const absCos = Math.abs(cosYaw);
    const absSin = Math.abs(sinYaw);
    const aabbHx = halfX * absCos + halfZ * absSin;
    const aabbHz = halfX * absSin + halfZ * absCos;
    const zone: StaticObstacle2D = {
      kind: 'box',
      category,
      x: centerX,
      z: centerZ,
      hx: halfX,
      hz: halfZ,
      cosYaw,
      sinYaw,
      minX: centerX - aabbHx,
      maxX: centerX + aabbHx,
      minZ: centerZ - aabbHz,
      maxZ: centerZ + aabbHz,
    };
    this.insertNoWalkZone2D(zone);
    if (alsoAddObstacle) {
      this.insertStaticObstacle2D(zone);
    }
  }

  public registerNoWalkCircle(
    category: NoWalkZoneCategory,
    centerX: number,
    centerZ: number,
    radius: number,
    alsoAddObstacle = true
  ): void {
    const zone: StaticObstacle2D = {
      kind: 'circle',
      category,
      x: centerX,
      z: centerZ,
      radius,
      minX: centerX - radius,
      maxX: centerX + radius,
      minZ: centerZ - radius,
      maxZ: centerZ + radius,
    };
    this.insertNoWalkZone2D(zone);
    if (alsoAddObstacle) {
      this.insertStaticObstacle2D(zone);
    }
  }

  private static shapeOverlapsCircle2D(
    o: StaticObstacle2D,
    x: number,
    z: number,
    radius: number
  ): boolean {
    if (
      x + radius < o.minX ||
      x - radius > o.maxX ||
      z + radius < o.minZ ||
      z - radius > o.maxZ
    ) {
      return false;
    }
    if (o.kind === 'circle') {
      const dx = x - o.x;
      const dz = z - o.z;
      const sumR = o.radius + radius;
      return dx * dx + dz * dz < sumR * sumR;
    }
    const dx = x - o.x;
    const dz = z - o.z;
    const lx = dx * o.cosYaw - dz * o.sinYaw;
    const lz = dx * o.sinYaw + dz * o.cosYaw;
    const cxLocal = Math.max(-o.hx, Math.min(o.hx, lx));
    const czLocal = Math.max(-o.hz, Math.min(o.hz, lz));
    const ex = lx - cxLocal;
    const ez = lz - czLocal;
    return ex * ex + ez * ez < radius * radius;
  }

  /**
   * Checks strict No-Walk Zones (water, bridge edges, buildings, outer map walls).
   * When `includeAllStaticObstacles` is true, also rejects points overlapping trees/benches/props.
   */
  public isInNoWalkZone(
    x: number,
    z: number,
    radius = 0.75,
    includeAllStaticObstacles = false
  ): boolean {
    if (
      Math.abs(x) >= OUTER_WALK_BOUND - radius ||
      Math.abs(z) >= OUTER_WALK_BOUND - radius
    ) {
      return true;
    }

    const minCx = Math.floor((x - radius) / OBSTACLE_CELL_SIZE);
    const maxCx = Math.floor((x + radius) / OBSTACLE_CELL_SIZE);
    const minCz = Math.floor((z - radius) / OBSTACLE_CELL_SIZE);
    const maxCz = Math.floor((z + radius) / OBSTACLE_CELL_SIZE);

    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cz = minCz; cz <= maxCz; cz++) {
        const key = packCellKey(cx, cz);
        const nwBucket = this.noWalkCells.get(key);
        if (nwBucket) {
          for (let i = 0; i < nwBucket.length; i++) {
            if (PhysicsWorld.shapeOverlapsCircle2D(nwBucket[i], x, z, radius)) {
              return true;
            }
          }
        }
        if (includeAllStaticObstacles) {
          const obsBucket = this.obstacleCells.get(key);
          if (obsBucket) {
            for (let i = 0; i < obsBucket.length; i++) {
              if (PhysicsWorld.shapeOverlapsCircle2D(obsBucket[i], x, z, radius)) {
                return true;
              }
            }
          }
        }
      }
    }
    return false;
  }

  public isSegmentBlockedByNoWalkZone(
    x1: number,
    z1: number,
    x2: number,
    z2: number,
    radius = 0.72
  ): boolean {
    const len = Math.hypot(x2 - x1, z2 - z1);
    const steps = Math.max(3, Math.ceil(len / 4.0));
    for (let s = 1; s < steps; s++) {
      const t = s / steps;
      const sx = x1 + (x2 - x1) * t;
      const sz = z1 + (z2 - z1) * t;
      if (this.isInNoWalkZone(sx, sz, radius, false)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Computes a zero-allocation 2D outward unit normal pointing directly away from the nearest
   * obstacle, water zone, bridge edge, building, or outer map wall within `maxRange`.
   */
  public findNearestNoWalkNormal(
    x: number,
    z: number,
    maxRange: number,
    out: { x: number; z: number }
  ): boolean {
    let bestDist = maxRange;
    let bestNx = 0;
    let bestNz = 0;
    let found = false;

    // Check outer perimeter walls
    const dPosX = OUTER_WALK_BOUND - x;
    if (dPosX < bestDist) {
      bestDist = dPosX;
      bestNx = -1;
      bestNz = 0;
      found = true;
    }
    const dNegX = x + OUTER_WALK_BOUND;
    if (dNegX < bestDist) {
      bestDist = dNegX;
      bestNx = 1;
      bestNz = 0;
      found = true;
    }
    const dPosZ = OUTER_WALK_BOUND - z;
    if (dPosZ < bestDist) {
      bestDist = dPosZ;
      bestNx = 0;
      bestNz = -1;
      found = true;
    }
    const dNegZ = z + OUTER_WALK_BOUND;
    if (dNegZ < bestDist) {
      bestDist = dNegZ;
      bestNx = 0;
      bestNz = 1;
      found = true;
    }

    const minCx = Math.floor((x - maxRange) / OBSTACLE_CELL_SIZE);
    const maxCx = Math.floor((x + maxRange) / OBSTACLE_CELL_SIZE);
    const minCz = Math.floor((z - maxRange) / OBSTACLE_CELL_SIZE);
    const maxCz = Math.floor((z + maxRange) / OBSTACLE_CELL_SIZE);

    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cz = minCz; cz <= maxCz; cz++) {
        const key = packCellKey(cx, cz);
        const bucket = this.obstacleCells.get(key);
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i++) {
          const o = bucket[i];
          if (
            x + maxRange < o.minX ||
            x - maxRange > o.maxX ||
            z + maxRange < o.minZ ||
            z - maxRange > o.maxZ
          ) {
            continue;
          }

          let nx = 0;
          let nz = 0;
          let dist = Infinity;
          if (o.kind === 'circle') {
            const dx = x - o.x;
            const dz = z - o.z;
            const centerDist = Math.hypot(dx, dz);
            dist = centerDist - o.radius;
            if (centerDist > 1e-4) {
              nx = dx / centerDist;
              nz = dz / centerDist;
            } else {
              nx = 1;
              nz = 0;
            }
          } else {
            const dx = x - o.x;
            const dz = z - o.z;
            const lx = dx * o.cosYaw - dz * o.sinYaw;
            const lz = dx * o.sinYaw + dz * o.cosYaw;
            const cxLocal = Math.max(-o.hx, Math.min(o.hx, lx));
            const czLocal = Math.max(-o.hz, Math.min(o.hz, lz));
            const ex = lx - cxLocal;
            const ez = lz - czLocal;
            const edgeDist = Math.hypot(ex, ez);
            if (edgeDist > 1e-4) {
              dist = edgeDist;
              const lnx = ex / edgeDist;
              const lnz = ez / edgeDist;
              nx = lnx * o.cosYaw + lnz * o.sinYaw;
              nz = -lnx * o.sinYaw + lnz * o.cosYaw;
            } else {
              const penX = o.hx - Math.abs(lx);
              const penZ = o.hz - Math.abs(lz);
              const lnx = penX < penZ ? (lx >= 0 ? 1 : -1) : 0;
              const lnz = penX < penZ ? 0 : (lz >= 0 ? 1 : -1);
              dist = -Math.min(penX, penZ);
              nx = lnx * o.cosYaw + lnz * o.sinYaw;
              nz = -lnx * o.sinYaw + lnz * o.cosYaw;
            }
          }

          if (dist < bestDist) {
            bestDist = dist;
            bestNx = nx;
            bestNz = nz;
            found = true;
          }
        }
      }
    }

    if (found) {
      out.x = bestNx;
      out.z = bestNz;
      return true;
    }
    return false;
  }

  /**
   * Returns true if circle (x, z, radius) overlaps any registered static ground obstacle.
   */
  public isPointBlocked2D(x: number, z: number, radius = 0.55): boolean {
    const minCx = Math.floor((x - radius) / OBSTACLE_CELL_SIZE);
    const maxCx = Math.floor((x + radius) / OBSTACLE_CELL_SIZE);
    const minCz = Math.floor((z - radius) / OBSTACLE_CELL_SIZE);
    const maxCz = Math.floor((z + radius) / OBSTACLE_CELL_SIZE);
    const rSq = radius * radius;

    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cz = minCz; cz <= maxCz; cz++) {
        const bucket = this.obstacleCells.get(packCellKey(cx, cz));
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i++) {
          const o = bucket[i];
          if (
            x + radius < o.minX ||
            x - radius > o.maxX ||
            z + radius < o.minZ ||
            z - radius > o.maxZ
          ) {
            continue;
          }
          if (o.kind === 'circle') {
            const dx = x - o.x;
            const dz = z - o.z;
            const sumR = o.radius + radius;
            if (dx * dx + dz * dz < sumR * sumR) return true;
          } else {
            const dx = x - o.x;
            const dz = z - o.z;
            // Transform into obstacle local frame (inverse yaw rotation)
            const lx = dx * o.cosYaw - dz * o.sinYaw;
            const lz = dx * o.sinYaw + dz * o.cosYaw;
            const cxLocal = Math.max(-o.hx, Math.min(o.hx, lx));
            const czLocal = Math.max(-o.hz, Math.min(o.hz, lz));
            const ex = lx - cxLocal;
            const ez = lz - czLocal;
            if (ex * ex + ez * ez < rSq) return true;
          }
        }
      }
    }
    return false;
  }

  /**
   * Resolves 2D circle/OBB obstacle overlap AND computes a smooth tangential slide steering vector
   * so NPCs glide around tree trunks, benches, and building corners instead of walking through or sticking.
   */
  public steerAndResolve2D(
    x: number,
    z: number,
    dirX: number,
    dirZ: number,
    agentRadius: number,
    lookAheadDist: number,
    out: { x: number; z: number; steerX: number; steerZ: number; collided: boolean }
  ): void {
    let rx = x;
    let rz = z;
    let steerX = dirX;
    let steerZ = dirZ;
    let collided = false;

    const searchR = agentRadius + lookAheadDist;
    const minCx = Math.floor((rx - searchR) / OBSTACLE_CELL_SIZE);
    const maxCx = Math.floor((rx + searchR) / OBSTACLE_CELL_SIZE);
    const minCz = Math.floor((rz - searchR) / OBSTACLE_CELL_SIZE);
    const maxCz = Math.floor((rz + searchR) / OBSTACLE_CELL_SIZE);
    const lookR = agentRadius + lookAheadDist;

    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cz = minCz; cz <= maxCz; cz++) {
        const bucket = this.obstacleCells.get(packCellKey(cx, cz));
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i++) {
          const o = bucket[i];
          if (
            rx + searchR < o.minX ||
            rx - searchR > o.maxX ||
            rz + searchR < o.minZ ||
            rz - searchR > o.maxZ
          ) {
            continue;
          }

          let nx = 0;
          let nz = 0;
          let dist = 0;
          let effRadius = agentRadius;

          if (o.kind === 'circle') {
            const dx = rx - o.x;
            const dz = rz - o.z;
            dist = Math.hypot(dx, dz);
            effRadius = o.radius + agentRadius;
            if (dist >= effRadius + lookAheadDist) continue;
            if (dist > 1e-4) {
              nx = dx / dist;
              nz = dz / dist;
            } else {
              nx = 1;
              nz = 0;
              dist = 0;
            }
          } else {
            const dx = rx - o.x;
            const dz = rz - o.z;
            const lx = dx * o.cosYaw - dz * o.sinYaw;
            const lz = dx * o.sinYaw + dz * o.cosYaw;
            const cxLocal = Math.max(-o.hx, Math.min(o.hx, lx));
            const czLocal = Math.max(-o.hz, Math.min(o.hz, lz));
            const ex = lx - cxLocal;
            const ez = lz - czLocal;
            dist = Math.hypot(ex, ez);

            if (dist > 1e-4) {
              if (dist >= lookR) continue;
              const lnx = ex / dist;
              const lnz = ez / dist;
              // Rotate normal back to world space
              nx = lnx * o.cosYaw + lnz * o.sinYaw;
              nz = -lnx * o.sinYaw + lnz * o.cosYaw;
              effRadius = agentRadius;
            } else {
              // Center lies inside OBB footprint; eject along shallowest axis
              const penX = o.hx - Math.abs(lx);
              const penZ = o.hz - Math.abs(lz);
              const lnx = penX < penZ ? (lx >= 0 ? 1 : -1) : 0;
              const lnz = penX < penZ ? 0 : (lz >= 0 ? 1 : -1);
              nx = lnx * o.cosYaw + lnz * o.sinYaw;
              nz = -lnx * o.sinYaw + lnz * o.cosYaw;
              const penDepth = Math.min(penX, penZ) + agentRadius;
              rx += nx * penDepth;
              rz += nz * penDepth;
              collided = true;
              const dotDir = steerX * nx + steerZ * nz;
              if (dotDir < 0) {
                steerX -= nx * dotDir;
                steerZ -= nz * dotDir;
              }
              continue;
            }
          }

          // Smooth anticipatory steering if obstacle lies ahead
          const towardObstacle = -(dirX * nx + dirZ * nz);
          if (towardObstacle > -0.15 && dist < effRadius + lookAheadDist) {
            const proximity = 1 - Math.max(0, dist - effRadius) / Math.max(0.1, lookAheadDist);
            // Tangent choice biased consistently toward moving direction around obstacle
            const t1x = -nz;
            const t1z = nx;
            const sign = dirX * t1x + dirZ * t1z >= 0 ? 1 : -1;
            const tx = t1x * sign;
            const tz = t1z * sign;
            const avoidWeight = Math.max(0, towardObstacle + 0.15) * proximity * 1.45;
            steerX += (tx * 0.92 + nx * 0.55) * avoidWeight;
            steerZ += (tz * 0.92 + nz * 0.55) * avoidWeight;
          }

          // Hard non-overlapping separation
          if (dist < effRadius) {
            const push = effRadius - dist + 0.015;
            rx += nx * push;
            rz += nz * push;
            collided = true;
            const inward = steerX * nx + steerZ * nz;
            if (inward < 0) {
              steerX -= nx * inward * 1.05;
              steerZ -= nz * inward * 1.05;
            }
          }
        }
      }
    }

    const sLen = Math.hypot(steerX, steerZ);
    if (sLen > 1e-4) {
      steerX /= sLen;
      steerZ /= sLen;
    } else {
      steerX = dirX;
      steerZ = dirZ;
    }

    out.x = rx;
    out.z = rz;
    out.steerX = steerX;
    out.steerZ = steerZ;
    out.collided = collided;
  }

  public addKinematicCylinder(
    center: THREE.Vector3,
    rTop: number,
    rBottom: number,
    height: number,
    segments = 10
  ): CANNON.Body {
    const body = new CANNON.Body({
      mass: 0,
      type: CANNON.Body.KINEMATIC,
      material: this.defaultMat,
      allowSleep: false,
      collisionFilterGroup: COLLISION_GROUP_KINEMATIC,
      collisionFilterMask: -1,
    });
    body.addShape(new CANNON.Cylinder(rTop, rBottom, height, segments));
    body.position.set(center.x, center.y, center.z);
    this.world.addBody(body);
    return body;
  }

  public addKinematicBox(
    center: THREE.Vector3,
    halfExtents: THREE.Vector3
  ): CANNON.Body {
    const body = new CANNON.Body({
      mass: 0,
      type: CANNON.Body.KINEMATIC,
      material: this.defaultMat,
      allowSleep: false,
      collisionFilterGroup: COLLISION_GROUP_KINEMATIC,
      collisionFilterMask: -1,
    });
    body.addShape(new CANNON.Box(new CANNON.Vec3(halfExtents.x, halfExtents.y, halfExtents.z)));
    body.position.set(center.x, center.y, center.z);
    this.world.addBody(body);
    return body;
  }

  public registerTrampoline(zone: Omit<TrampolineZone, 'squashPhase' | 'baseScaleY'>): TrampolineZone {
    const full: TrampolineZone = {
      ...zone,
      squashPhase: 0,
      baseScaleY: zone.meshToSquash ? zone.meshToSquash.scale.y : 1.0,
    };
    this.trampolines.push(full);
    return full;
  }

  public triggerTrampolineSquash(zone: TrampolineZone): void {
    const wasActive = zone.squashPhase > 0.001;
    zone.squashPhase = 1.0;
    if (!wasActive && this.activeSquashTrampolines.indexOf(zone) === -1) {
      this.activeSquashTrampolines.push(zone);
    }
  }

  public registerUpdraft(zone: UpdraftZone): UpdraftZone {
    this.updrafts.push(zone);
    return zone;
  }

  public registerBasin(basin: LiquidBasin): LiquidBasin {
    this.basins.push(basin);
    // Register ground-level water basins & canal borders as strict No-Walk Zones and 2D steering obstacles
    if (basin.surfaceY < 4.0) {
      const margin = 1.65;
      if (basin.boxHalfX !== undefined && basin.boxHalfZ !== undefined) {
        this.registerNoWalkBox(
          'water',
          basin.center.x,
          basin.center.z,
          basin.boxHalfX + margin,
          basin.boxHalfZ + margin,
          0,
          true
        );
      } else {
        this.registerNoWalkCircle(
          'water',
          basin.center.x,
          basin.center.z,
          basin.radius + margin,
          true
        );
      }
    }
    return basin;
  }

  public isPointInBasin(x: number, y: number, z: number, yTolerance = 0.55): LiquidBasin | null {
    let best: LiquidBasin | null = null;
    let bestDy = yTolerance;
    for (let i = 0; i < this.basins.length; i++) {
      const b = this.basins[i];
      const dy = Math.abs(y - b.surfaceY);
      if (dy > bestDy) continue;
      if (basinContainsXZ(b, x, z)) {
        best = b;
        bestDy = dy;
      }
    }
    return best;
  }

  public getBasinAtXZ(x: number, z: number, refY?: number): LiquidBasin | null {
    if (refY === undefined) {
      let lowest: LiquidBasin | null = null;
      for (let i = 0; i < this.basins.length; i++) {
        const b = this.basins[i];
        if (!basinContainsXZ(b, x, z)) continue;
        if (!lowest || b.surfaceY < lowest.surfaceY) {
          lowest = b;
        }
      }
      return lowest;
    }

    let bestBelow: LiquidBasin | null = null;
    let closestAny: LiquidBasin | null = null;
    let closestDy = Infinity;
    for (let i = 0; i < this.basins.length; i++) {
      const b = this.basins[i];
      if (!basinContainsXZ(b, x, z)) continue;
      if (b.surfaceY <= refY + 1.15) {
        if (!bestBelow || b.surfaceY > bestBelow.surfaceY) {
          bestBelow = b;
        }
      }
      const dy = Math.abs(refY - b.surfaceY);
      if (dy < closestDy) {
        closestDy = dy;
        closestAny = b;
      }
    }
    return bestBelow ?? closestAny;
  }

  public setBodyAttachTarget(body: CANNON.Body, target: THREE.Object3D): void {
    this.attachMap.set(body, target);
  }

  public getBodyAttachTarget(body: CANNON.Body | null | undefined): THREE.Object3D | undefined {
    return body ? this.attachMap.get(body) : undefined;
  }

  public registerPeckSwitch(sw: PeckSwitch): PeckSwitch {
    this.peckSwitches.push(sw);
    this.peckSwitchGrid.insertPoint(sw, sw.position.x, sw.position.z);
    return sw;
  }

  public queryPeckSwitchesInRadius(
    x: number,
    z: number,
    radius: number,
    visitor: (sw: PeckSwitch) => boolean | void
  ): void {
    this.peckSwitchGrid.queryRadius(x, z, radius, visitor);
  }

  public queryPropsInRadius(
    x: number,
    z: number,
    radius: number,
    visitor: (prop: InteractiveProp) => boolean | void
  ): void {
    this.propGrid.queryRadius(x, z, radius, visitor);
  }

  public getPropsByKind(kind: PropKind): readonly InteractiveProp[] {
    return this.propsByKind.get(kind) ?? [];
  }

  public getNestMaterialProps(): readonly InteractiveProp[] {
    return this.nestMaterialProps;
  }

  public countActivePropsByKind(kind: PropKind): number {
    const list = this.propsByKind.get(kind);
    if (!list) return 0;
    let count = 0;
    for (let i = 0; i < list.length; i++) {
      if (!list[i].consumed) count++;
    }
    return count;
  }

  public countActiveNestMaterials(): number {
    let count = 0;
    for (let i = 0; i < this.nestMaterialProps.length; i++) {
      if (!this.nestMaterialProps[i].consumed) count++;
    }
    return count;
  }

  public syncPropSpatialPosition(prop: InteractiveProp): void {
    if (prop.consumed) return;
    this.propGrid.updatePoint(prop, prop.mesh.position.x, prop.mesh.position.z);
  }

  public spawnProp(opts: {
    id: string;
    kind: PropKind;
    mesh: THREE.Object3D;
    position: THREE.Vector3;
    shape: CANNON.Shape;
    mass?: number;
    pushRadius?: number;
    grabbable?: boolean;
    beakWeight?: number;
    carryOffset?: THREE.Vector3;
    linearDamping?: number;
    tintHex?: number;
    isNestMaterial?: boolean;
    glideLift?: boolean;
    buoyant?: boolean;
    onTopple?: (prop: InteractiveProp, pos: THREE.Vector3) => void;
    breakable?: BreakableSpec;
  }): InteractiveProp {
    const body = new CANNON.Body({
      mass: opts.mass ?? 0.35,
      material: this.defaultMat,
      linearDamping: opts.linearDamping ?? 0.24,
      angularDamping: 0.38,
      allowSleep: true,
      sleepSpeedLimit: 0.12,
      sleepTimeLimit: 0.85,
      collisionFilterGroup: COLLISION_GROUP_DYNAMIC,
      collisionFilterMask: -1,
    });
    body.addShape(opts.shape);
    body.position.set(opts.position.x, opts.position.y, opts.position.z);
    body.interpolatedPosition.set(opts.position.x, opts.position.y, opts.position.z);
    opts.mesh.position.copy(opts.position);
    this.world.addBody(body);

    const isCeramic =
      opts.kind === 'ceramic_mug' ||
      opts.kind === 'teacup' ||
      opts.kind === 'porcelain_plate' ||
      opts.kind === 'pigment_jar' ||
      opts.kind === 'terracotta_pot' ||
      opts.kind === 'glass_carafe' ||
      opts.kind === 'ceramic_vase';

    const defaultPushRadius =
      opts.pushRadius ??
      (isCeramic || opts.kind === 'coffee_cup'
        ? 0.56
        : opts.kind === 'studio_book' || opts.kind === 'baguette'
          ? 0.62
          : 0.38);

    const prop: InteractiveProp = {
      id: opts.id,
      kind: opts.kind,
      mesh: opts.mesh,
      body,
      grabbable: opts.grabbable ?? !isCeramic,
      pushRadius: defaultPushRadius,
      beakWeight: opts.beakWeight ?? 0.15,
      carryOffset: opts.carryOffset ?? new THREE.Vector3(0, -0.06, 0.24),
      carried: false,
      consumed: false,
      broken: false,
      homePos: opts.position.clone(),
      tintHex: opts.tintHex,
      isNestMaterial: opts.isNestMaterial ?? false,
      glideLift: opts.glideLift ?? false,
      buoyant: opts.buoyant ?? false,
      waterRippleTimer: 0,
      splashCooldown: 0,
      pushCooldown: 0,
      toppled: false,
      onTopple: opts.onTopple,
      breakable: opts.breakable,
      peckHitsRemaining: opts.breakable?.peckHitsToBreak ?? 999,
      pendingImpactSpeed: 0,
      pendingCollisionSfxSpeed: 0,
      impactSfxCooldown: 0,
      syncedWhileSleeping: false,
    };
    this.attachMap.set(body, opts.mesh);
    this.propByBody.set(body, prop);

    body.addEventListener('collide', (ev: { contact: CANNON.ContactEquation }) => {
      if (
        prop.consumed ||
        prop.carried ||
        prop.waterRespawnTimer !== undefined ||
        this.simElapsed <= 0.65
      ) {
        return;
      }
      const impactVel = Math.abs(ev.contact.getImpactVelocityAlongNormal());
      if (opts.breakable && impactVel > prop.pendingImpactSpeed) {
        prop.pendingImpactSpeed = impactVel;
      }
      if (impactVel > 1.25 && impactVel > prop.pendingCollisionSfxSpeed) {
        prop.pendingCollisionSfxSpeed = impactVel;
      }
    });

    const surf: BumpMetadata['surface'] =
      opts.kind === 'shiny_coin' || opts.kind === 'brass_key'
        ? 'metal'
        : isCeramic
          ? 'ceramic'
          : 'wood';

    this.setBumpMetadata(body, {
      surface: surf,
      causesDizzy: false,
      onBump: (hitPt, speed) => {
        body.wakeUp();
        _bumpPush.set(body.position.x - hitPt.x, 0.28, body.position.z - hitPt.z).normalize();
        const imp = Math.min(8.5, 2.6 + speed * 0.42);
        _impulseVec.set(_bumpPush.x * imp, imp * 0.45, _bumpPush.z * imp);
        _worldPtVec.set(body.position.x, body.position.y + 0.24, body.position.z);
        body.applyImpulse(_impulseVec, _worldPtVec);
        if (prop.breakable && speed > 13.5) {
          this.shatterProp(prop);
        }
      },
    });

    this.props.push(prop);
    this.propGrid.insertPoint(prop, prop.mesh.position.x, prop.mesh.position.z);
    let kindBucket = this.propsByKind.get(prop.kind);
    if (!kindBucket) {
      kindBucket = [];
      this.propsByKind.set(prop.kind, kindBucket);
    }
    kindBucket.push(prop);
    if (prop.isNestMaterial) {
      this.nestMaterialProps.push(prop);
    }
    if (prop.glideLift) {
      this.glideLiftProps.push(prop);
    }
    if (prop.buoyant) {
      this.buoyantProps.push(prop);
    }
    return prop;
  }

  private disposePropVisual(prop: InteractiveProp): void {
    prop.mesh.visible = false;
    prop.mesh.removeFromParent();
    prop.mesh.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        const g = (child as THREE.Mesh).geometry;
        if (g && !g.userData?.sharedCached) {
          g.dispose();
        }
      }
    });
  }

  public resetPropToHome(prop: InteractiveProp): void {
    if (prop.consumed) return;
    prop.carried = false;
    prop.inWater = false;
    prop.syncedWhileSleeping = false;
    prop.body.wakeUp();
    prop.body.position.set(prop.homePos.x, prop.homePos.y + 0.35, prop.homePos.z);
    prop.body.interpolatedPosition.set(prop.homePos.x, prop.homePos.y + 0.35, prop.homePos.z);
    prop.body.quaternion.set(0, 0, 0, 1);
    prop.body.interpolatedQuaternion.set(0, 0, 0, 1);
    prop.body.velocity.set(0, 0, 0);
    prop.body.angularVelocity.set(0, 0, 0);
    prop.mesh.position.set(prop.homePos.x, prop.homePos.y + 0.35, prop.homePos.z);
    prop.mesh.quaternion.set(0, 0, 0, 1);
    this.propGrid.updatePoint(prop, prop.mesh.position.x, prop.mesh.position.z);
  }

  public shatterProp(prop: InteractiveProp): boolean {
    if (prop.consumed || prop.broken) return false;
    prop.broken = true;
    prop.consumed = true;
    prop.carried = false;
    _shatterPos.set(prop.body.position.x, prop.body.position.y, prop.body.position.z);
    this.propGrid.remove(prop);
    this.disposePropVisual(prop);
    this.world.removeBody(prop.body);
    this.propsNeedCompact = true;

    if (!prop.toppled && prop.onTopple) {
      prop.toppled = true;
      prop.onTopple(prop, _shatterPos);
    }
    const shardHex = prop.breakable?.shardHex ?? prop.tintHex ?? 0xf6f1e6;
    prop.breakable?.onBreak?.(prop, _shatterPos);
    this.onPropShatter?.(prop, _shatterPos, shardHex);
    return true;
  }

  /**
   * Continuous Sparrow body-contact pushing: hopping, walking, or flying into mugs, teacups,
   * plates, jars, pots, books, apples, or cones wakes and physically shoves/tips them.
   */
  public pushPropsWithBirdBody(
    birdPos: THREE.Vector3,
    birdVel: THREE.Vector3,
    birdRadius = 0.48,
    forwardFallback?: THREE.Vector3
  ): InteractiveProp | null {
    let pushedProp: InteractiveProp | null = null;
    const bSpeedXZ = Math.hypot(birdVel.x, birdVel.z);
    const bSpeedTotal = birdVel.length();

    this.propGrid.queryRadius(birdPos.x, birdPos.z, birdRadius + 1.25, (p) => {
      if (p.consumed || p.carried || p.waterRespawnTimer !== undefined) return;
      const dx = p.body.position.x - birdPos.x;
      const dy = p.body.position.y - birdPos.y;
      const dz = p.body.position.z - birdPos.z;
      if (Math.abs(dy) > p.pushRadius + 0.68) return;

      const minSep = birdRadius + p.pushRadius;
      const distSq = dx * dx + dz * dz;
      if (distSq >= minSep * minSep) return;

      const dist = Math.sqrt(distSq);
      let nx = 0;
      let nz = 1;
      if (dist > 0.001) {
        nx = dx / dist;
        nz = dz / dist;
      } else if (forwardFallback && forwardFallback.lengthSq() > 0.001) {
        nx = forwardFallback.x;
        nz = forwardFallback.z;
      }

      const overlap = minSep - dist;
      if (bSpeedTotal < 0.25 && overlap < 0.08) return;

      p.body.wakeUp();
      const targetSpeed = Math.max(2.9, Math.min(11.5, bSpeedXZ * 0.95 + overlap * 6.5));
      const curAlong = p.body.velocity.x * nx + p.body.velocity.z * nz;
      if (curAlong < targetSpeed) {
        const boost = (targetSpeed - curAlong) * 0.78;
        p.body.velocity.x += nx * boost;
        p.body.velocity.z += nz * boost;
        p.body.velocity.y = Math.max(p.body.velocity.y, 0.45 + Math.min(1.6, bSpeedXZ * 0.14));
        p.body.angularVelocity.x += -nz * boost * 0.85;
        p.body.angularVelocity.z += nx * boost * 0.85;
      }

      if (p.pushCooldown <= 0) {
        p.pushCooldown = 0.18;
        pushedProp = p;
      }

      if (p.breakable && bSpeedTotal > 14.0) {
        this.shatterProp(p);
      }
    });

    return pushedProp;
  }

  /**
   * Direct close-range beak peck against dynamic props (jostles/slides props or cracks/shatters fragile ceramics).
   */
  public strikePropsWithPeck(
    beakPos: THREE.Vector3,
    forwardDir: THREE.Vector3,
    reach = 1.45
  ): { prop: InteractiveProp; shattered: boolean } | null {
    let best: InteractiveProp | null = null;
    let bestD = reach;

    this.propGrid.queryRadius(beakPos.x, beakPos.z, reach + 1.0, (p) => {
      if (p.consumed || p.carried || p.waterRespawnTimer !== undefined) return;
      const d = Math.hypot(
        p.body.position.x - beakPos.x,
        (p.body.position.y - beakPos.y) * 0.85,
        p.body.position.z - beakPos.z
      );
      const effD = Math.max(0, d - p.pushRadius * 0.55);
      if (effD < bestD) {
        bestD = effD;
        best = p;
      }
    });

    const struck = best as InteractiveProp | null;
    if (!struck) return null;

    struck.body.wakeUp();
    if (struck.breakable) {
      struck.peckHitsRemaining -= 1;
      if (struck.peckHitsRemaining <= 0) {
        this.shatterProp(struck);
        return { prop: struck, shattered: true };
      }
      struck.body.velocity.x += forwardDir.x * 1.15;
      struck.body.velocity.z += forwardDir.z * 1.15;
      struck.body.velocity.y = Math.max(struck.body.velocity.y, 0.85);
      struck.body.angularVelocity.set(-forwardDir.z * 3.2, 0, forwardDir.x * 3.2);
      return { prop: struck, shattered: false };
    }

    const imp = Math.max(1.8, Math.min(5.6, 3.6 / Math.max(0.35, struck.body.mass)));
    struck.body.velocity.x += forwardDir.x * imp;
    struck.body.velocity.z += forwardDir.z * imp;
    struck.body.velocity.y = Math.max(struck.body.velocity.y, 1.35);
    struck.body.angularVelocity.set(
      -forwardDir.z * 4.8 + (Math.random() - 0.5) * 2.0,
      (Math.random() - 0.5) * 3.0,
      forwardDir.x * 4.8 + (Math.random() - 0.5) * 2.0
    );
    return { prop: struck, shattered: false };
  }

  public strikeBodyWithBullet(
    body: CANNON.Body | null,
    hitPoint: THREE.Vector3,
    dir: THREE.Vector3
  ): { prop?: InteractiveProp; shattered?: boolean; surface: 'ceramic' | 'wood' | 'stone' } {
    const meta = body ? this.bumpMap.get(body) : undefined;
    const surf = meta?.surface === 'ceramic' ? 'ceramic' : meta?.surface === 'wood' ? 'wood' : 'stone';
    if (!body) return { surface: surf };

    const prop = this.propByBody.get(body);
    if (prop && !prop.consumed && !prop.carried) {
      if (prop.breakable) {
        this.shatterProp(prop);
        return { prop, shattered: true, surface: 'ceramic' };
      }
      prop.body.wakeUp();
      prop.syncedWhileSleeping = false;
      const imp = Math.max(3.8, Math.min(13.5, 5.2 / Math.max(0.28, prop.body.mass)));
      prop.body.velocity.x += dir.x * imp;
      prop.body.velocity.y = Math.max(prop.body.velocity.y + 1.8, 3.0 + dir.y * imp * 0.45);
      prop.body.velocity.z += dir.z * imp;
      prop.body.angularVelocity.set(
        -dir.z * 7.5 + (Math.random() - 0.5) * 4.0,
        (Math.random() - 0.5) * 6.0,
        dir.x * 7.5 + (Math.random() - 0.5) * 4.0
      );
      return { prop, shattered: false, surface: surf };
    }

    if (body.mass > 0) {
      body.wakeUp();
      const imp = Math.max(3.2, Math.min(11.0, 4.8 / Math.max(0.3, body.mass)));
      _impulseVec.set(dir.x * imp, Math.max(1.5, dir.y * imp + 2.0), dir.z * imp);
      _worldPtVec.set(hitPoint.x, hitPoint.y, hitPoint.z);
      body.applyImpulse(_impulseVec, _worldPtVec);
    } else if (meta?.onBump) {
      meta.onBump(hitPoint, 10.0);
    }

    return { surface: surf };
  }

  public removeProp(prop: InteractiveProp): void {
    if (prop.consumed) return;
    prop.consumed = true;
    prop.carried = false;
    prop.waterRespawnTimer = undefined;
    this.propGrid.remove(prop);
    this.disposePropVisual(prop);
    this.world.removeBody(prop.body);
    this.propsNeedCompact = true;
  }

  /**
   * Makes a prop splosh and immediately vanish beneath the water surface.
   * Normal props are removed permanently; irreplaceable quest items stay hidden underwater
   * for ~3.2s so they clearly disappear on splosh, then quietly respawn at homePos so quests never soft-lock.
   */
  public vanishPropIntoWater(prop: InteractiveProp, preserveForQuest = false): void {
    if (prop.consumed) return;
    if (!preserveForQuest) {
      this.removeProp(prop);
      return;
    }
    prop.carried = false;
    prop.inWater = true;
    prop.mesh.visible = false;
    prop.waterRespawnTimer = 3.2;
    prop.pendingImpactSpeed = 0;
    prop.pendingCollisionSfxSpeed = 0;
    prop.body.velocity.set(0, 0, 0);
    prop.body.angularVelocity.set(0, 0, 0);
    prop.body.position.set(prop.homePos.x, -80.0, prop.homePos.z);
    prop.body.interpolatedPosition.set(prop.homePos.x, -80.0, prop.homePos.z);
    prop.body.sleep();
    prop.syncedWhileSleeping = true;
  }

  public sampleUpdraftLift(pos: THREE.Vector3): number {
    let lift = 0;
    for (let i = 0; i < this.updrafts.length; i++) {
      const u = this.updrafts[i];
      if (!u.active) continue;
      if (pos.y < u.yMin || pos.y > u.yMax) continue;
      const dx = pos.x - u.x;
      const dz = pos.z - u.z;
      const dSq = dx * dx + dz * dz;
      if (dSq < u.radius * u.radius) {
        const radialFade = 1.0 - Math.sqrt(dSq) / u.radius;
        const topFade = Math.min(1.0, (u.yMax - pos.y) / 6.0);
        lift = Math.max(lift, u.liftAccel * (0.45 + 0.55 * radialFade) * topFade);
      }
    }
    return lift;
  }

  public raycastGround(
    origin: THREE.Vector3,
    direction: THREE.Vector3,
    maxDist: number,
    ignoreBody?: CANNON.Body,
    out?: GroundRaycastHit,
    collisionFilterMask = -1
  ): GroundRaycastHit {
    if (
      !Number.isFinite(maxDist) ||
      maxDist <= 1e-5 ||
      !Number.isFinite(origin.x) ||
      !Number.isFinite(origin.y) ||
      !Number.isFinite(origin.z) ||
      !Number.isFinite(direction.x) ||
      !Number.isFinite(direction.y) ||
      !Number.isFinite(direction.z)
    ) {
      if (out) {
        out.hit = false;
        out.point.set(0, 0, 0);
        out.normal.set(0, 1, 0);
        out.distance = maxDist > 0 ? maxDist : 0;
        out.body = null;
        return out;
      }
      return {
        hit: false,
        point: new THREE.Vector3(),
        normal: new THREE.Vector3(0, 1, 0),
        distance: maxDist > 0 ? maxDist : 0,
        body: null,
      };
    }

    this.rayFrom.set(origin.x, origin.y, origin.z);
    this.rayTo.set(
      origin.x + direction.x * maxDist,
      origin.y + direction.y * maxDist,
      origin.z + direction.z * maxDist
    );
    this.rayResult.reset();

    const prevGroup = ignoreBody ? ignoreBody.collisionFilterGroup : 1;
    if (ignoreBody) ignoreBody.collisionFilterGroup = 0;

    this.rayOptions.collisionFilterMask = collisionFilterMask;
    this.world.raycastClosest(
      this.rayFrom,
      this.rayTo,
      this.rayOptions,
      this.rayResult
    );

    if (ignoreBody) ignoreBody.collisionFilterGroup = prevGroup;

    if (this.rayResult.hasHit && this.rayResult.body !== ignoreBody) {
      if (out) {
        out.hit = true;
        out.point.set(
          this.rayResult.hitPointWorld.x,
          this.rayResult.hitPointWorld.y,
          this.rayResult.hitPointWorld.z
        );
        out.normal.set(
          this.rayResult.hitNormalWorld.x,
          this.rayResult.hitNormalWorld.y,
          this.rayResult.hitNormalWorld.z
        );
        out.distance = this.rayResult.distance;
        out.body = this.rayResult.body;
        return out;
      }
      return {
        hit: true,
        point: new THREE.Vector3(
          this.rayResult.hitPointWorld.x,
          this.rayResult.hitPointWorld.y,
          this.rayResult.hitPointWorld.z
        ),
        normal: new THREE.Vector3(
          this.rayResult.hitNormalWorld.x,
          this.rayResult.hitNormalWorld.y,
          this.rayResult.hitNormalWorld.z
        ),
        distance: this.rayResult.distance,
        body: this.rayResult.body,
      };
    }

    if (out) {
      out.hit = false;
      out.point.set(0, 0, 0);
      out.normal.set(0, 1, 0);
      out.distance = maxDist;
      out.body = null;
      return out;
    }

    return {
      hit: false,
      point: new THREE.Vector3(),
      normal: new THREE.Vector3(0, 1, 0),
      distance: maxDist,
      body: null,
    };
  }

  /**
   * Allocation-free closest raycast against static architecture & kinematic vehicles
   * via `COLLISION_GROUP_STATIC | COLLISION_GROUP_KINEMATIC` (ignoring small dynamic tabletop props).
   */
  public raycastStaticCameraObstacle(
    origin: THREE.Vector3,
    direction: THREE.Vector3,
    maxDist: number
  ): StaticCameraHit {
    if (
      !Number.isFinite(maxDist) ||
      maxDist <= 1e-5 ||
      !Number.isFinite(origin.x) ||
      !Number.isFinite(origin.y) ||
      !Number.isFinite(origin.z) ||
      !Number.isFinite(direction.x) ||
      !Number.isFinite(direction.y) ||
      !Number.isFinite(direction.z)
    ) {
      this.staticCamHit.hit = false;
      this.staticCamHit.distance = maxDist > 0 ? maxDist : 0;
      this.staticCamHit.normal.set(0, 1, 0);
      return this.staticCamHit;
    }

    this.rayFrom.set(origin.x, origin.y, origin.z);
    this.rayTo.set(
      origin.x + direction.x * maxDist,
      origin.y + direction.y * maxDist,
      origin.z + direction.z * maxDist
    );
    this.rayResult.reset();

    this.world.raycastClosest(
      this.rayFrom,
      this.rayTo,
      this.staticRayOptions,
      this.rayResult
    );

    if (this.rayResult.hasHit) {
      this.staticCamHit.hit = true;
      this.staticCamHit.distance = this.rayResult.distance;
      this.staticCamHit.normal.set(
        this.rayResult.hitNormalWorld.x,
        this.rayResult.hitNormalWorld.y,
        this.rayResult.hitNormalWorld.z
      );
    } else {
      this.staticCamHit.hit = false;
      this.staticCamHit.distance = maxDist;
      this.staticCamHit.normal.set(0, 1, 0);
    }
    return this.staticCamHit;
  }

  private compactArrayInPlace(list: InteractiveProp[]): void {
    let writeIdx = 0;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (!p.consumed) {
        list[writeIdx++] = p;
      }
    }
    list.length = writeIdx;
  }

  private compactPropsInPlace(): void {
    this.compactArrayInPlace(this.props);
    this.compactArrayInPlace(this.nestMaterialProps);
    this.compactArrayInPlace(this.glideLiftProps);
    this.compactArrayInPlace(this.buoyantProps);
    for (const [, list] of this.propsByKind) {
      this.compactArrayInPlace(list);
    }
    this.propsNeedCompact = false;
  }

  /**
   * Imparts an aerodynamic wind impulse from high-speed sparrow flybys or wing-flaps
   * onto nearby featherlight props (paper airplanes, ribbons, down, flowers, twigs, seeds).
   */
  public applyWindGustAt(
    origin: THREE.Vector3,
    gustVel: THREE.Vector3,
    radius = 3.8,
    strength = 1.0
  ): void {
    const rSq = radius * radius;
    this.propGrid.queryRadius(origin.x, origin.z, radius + 0.8, (p) => {
      if (p.consumed || p.carried || p.waterRespawnTimer !== undefined) return;
      if (
        p.kind !== 'paper_airplane' &&
        p.kind !== 'velvet_down' &&
        p.kind !== 'ribbon' &&
        p.kind !== 'flower_sprig' &&
        p.kind !== 'twig' &&
        p.kind !== 'seed'
      ) {
        return;
      }
      const dx = p.body.position.x - origin.x;
      const dy = p.body.position.y - origin.y;
      const dz = p.body.position.z - origin.z;
      const dSq = dx * dx + dy * dy + dz * dz;
      if (dSq >= rSq || dSq < 1e-4) return;
      const dist = Math.sqrt(dSq);
      const falloff = (1.0 - dist / radius) * strength;
      p.body.wakeUp();
      p.syncedWhileSleeping = false;
      const invMass = Math.min(3.5, 0.5 / Math.max(0.12, p.body.mass));
      p.body.velocity.x += (gustVel.x * 0.16 + (dx / dist) * 1.4) * falloff * invMass;
      p.body.velocity.y += Math.max(0.25, 0.95 * falloff * invMass);
      p.body.velocity.z += (gustVel.z * 0.16 + (dz / dist) * 1.4) * falloff * invMass;
      p.body.angularVelocity.y += (Math.random() - 0.5) * 3.2 * falloff;
    });
  }

  /**
   * Nudges buoyant floating canal props in the bow/stern wake of passing wooden canal launches.
   */
  public nudgeBuoyantPropsFromBoat(
    boatX: number,
    boatZ: number,
    boatVx: number,
    dt: number
  ): void {
    for (let i = 0; i < this.buoyantProps.length; i++) {
      const p = this.buoyantProps[i];
      if (p.consumed || p.carried || !p.inWater) continue;
      const dx = p.body.position.x - boatX;
      const dz = p.body.position.z - boatZ;
      if (Math.abs(dx) > 13.5 || Math.abs(dz) > 6.8) continue;
      p.body.wakeUp();
      const pushZ = dz >= 0 ? 1 : -1;
      p.body.velocity.z += pushZ * 4.8 * dt;
      p.body.velocity.x += boatVx * 0.35 * dt;
      p.body.velocity.y += 1.6 * dt;
      p.body.angularVelocity.x += pushZ * 2.4 * dt;
    }
  }

  public update(dt: number, onRipple?: (pos: THREE.Vector3, scale: number) => void): void {
    if (!Number.isFinite(dt) || dt <= 0) return;
    const clamped = Math.min(0.05, dt);
    this.simElapsed += clamped;

    this.world.step(1 / 60, clamped, 3);

    for (let i = this.activeSquashTrampolines.length - 1; i >= 0; i--) {
      const tz = this.activeSquashTrampolines[i];
      if (tz.squashPhase > 0.001) {
        tz.squashPhase = Math.max(0, tz.squashPhase - clamped * 3.4);
        if (tz.meshToSquash) {
          const osc = Math.sin(tz.squashPhase * Math.PI * 3.5) * tz.squashPhase * 0.22;
          tz.meshToSquash.scale.y = tz.baseScaleY * (1.0 - osc);
        }
      }
      if (tz.squashPhase <= 0.001) {
        tz.squashPhase = 0;
        if (tz.meshToSquash) {
          tz.meshToSquash.scale.y = tz.baseScaleY;
        }
        const last = this.activeSquashTrampolines.length - 1;
        if (i < last) {
          this.activeSquashTrampolines[i] = this.activeSquashTrampolines[last];
        }
        this.activeSquashTrampolines.pop();
      }
    }

    for (let i = 0; i < this.peckSwitches.length; i++) {
      const sw = this.peckSwitches[i];
      if (sw.cooldown > 0) sw.cooldown = Math.max(0, sw.cooldown - clamped);
    }

    const halfExtent = WORLD_CONFIG.worldHalfExtent;
    const minFailSafeY = WORLD_CONFIG.propFailSafeMinY;
    const maxLinSpeedSq = 48.0 * 48.0;
    const maxAngSpeedSq = 28.0 * 28.0;

    for (let i = 0; i < this.props.length; i++) {
      const p = this.props[i];
      if (p.consumed) continue;
      if (p.splashCooldown > 0) p.splashCooldown -= clamped;
      if (p.pushCooldown > 0) p.pushCooldown -= clamped;
      if (p.impactSfxCooldown > 0) p.impactSfxCooldown -= clamped;

      if (p.waterRespawnTimer !== undefined) {
        p.waterRespawnTimer -= clamped;
        if (p.waterRespawnTimer <= 0) {
          p.waterRespawnTimer = undefined;
          p.mesh.visible = true;
          this.resetPropToHome(p);
        }
        continue;
      }

      if (!p.carried) {
        if (p.breakable && p.pendingImpactSpeed > 0) {
          const hitSpeed = p.pendingImpactSpeed;
          p.pendingImpactSpeed = 0;
          if (hitSpeed >= p.breakable.impactSpeedThreshold) {
            p.pendingCollisionSfxSpeed = 0;
            this.shatterProp(p);
            continue;
          }
        }

        if (p.pendingCollisionSfxSpeed > 0) {
          const sfxSpeed = p.pendingCollisionSfxSpeed;
          p.pendingCollisionSfxSpeed = 0;
          if (p.impactSfxCooldown <= 0 && sfxSpeed > 1.25) {
            p.impactSfxCooldown = 0.085;
            _shatterPos.set(p.body.position.x, p.body.position.y, p.body.position.z);
            this.onPropImpact?.(p, _shatterPos, sfxSpeed);
          }
        }

        const isAwake = p.body.sleepState !== CANNON.Body.SLEEPING;
        if (!isAwake && p.syncedWhileSleeping) {
          continue;
        }

        const bPos = p.body.position;
        const bVel = p.body.velocity;
        const bAng = p.body.angularVelocity;
        const bQuat = p.body.quaternion;

        // Self-heal any non-finite or out-of-bounds physics state
        if (
          !Number.isFinite(bPos.x) ||
          !Number.isFinite(bPos.y) ||
          !Number.isFinite(bPos.z) ||
          !Number.isFinite(bVel.x) ||
          !Number.isFinite(bVel.y) ||
          !Number.isFinite(bVel.z) ||
          !Number.isFinite(bQuat.x) ||
          !Number.isFinite(bQuat.y) ||
          !Number.isFinite(bQuat.z) ||
          !Number.isFinite(bQuat.w) ||
          bPos.y < minFailSafeY ||
          bPos.y > 280.0 ||
          Math.abs(bPos.x) > halfExtent ||
          Math.abs(bPos.z) > halfExtent
        ) {
          this.resetPropToHome(p);
        } else if (isAwake) {
          // Clamp extreme linear/angular impulses under heavy physics load
          const vSq = bVel.x * bVel.x + bVel.y * bVel.y + bVel.z * bVel.z;
          if (vSq > maxLinSpeedSq) {
            const s = 48.0 / Math.sqrt(vSq);
            bVel.x *= s;
            bVel.y *= s;
            bVel.z *= s;
          }
          const aSq = bAng.x * bAng.x + bAng.y * bAng.y + bAng.z * bAng.z;
          if (aSq > maxAngSpeedSq) {
            const s = 28.0 / Math.sqrt(aSq);
            bAng.x *= s;
            bAng.y *= s;
            bAng.z *= s;
          }
        }

        const srcPos = isAwake ? p.body.interpolatedPosition : p.body.position;
        const srcQuat = isAwake ? p.body.interpolatedQuaternion : p.body.quaternion;

        p.mesh.position.set(srcPos.x, srcPos.y, srcPos.z);
        p.mesh.quaternion.set(srcQuat.x, srcQuat.y, srcQuat.z, srcQuat.w);
        p.syncedWhileSleeping = !isAwake;
        this.propGrid.updatePoint(p, srcPos.x, srcPos.z);

        // Detect tabletop topples (e.g. Coffee Cup Bowling, Gelato Cone Topple, Apple Pyramid Avalanche)
        if (!p.toppled && p.onTopple) {
          const droppedY = p.homePos.y - p.body.position.y;
          const movedXZ = Math.hypot(
            p.body.position.x - p.homePos.x,
            p.body.position.z - p.homePos.z
          );
          const minDrop = p.kind === 'apple' ? 0.52 : 1.35;
          const minMove = p.kind === 'apple' ? 0.82 : 2.2;
          if (droppedY > minDrop || movedXZ > minMove) {
            p.toppled = true;
            p.onTopple(p, p.mesh.position);
          }
        }

        const basin = this.getBasinAtXZ(
          p.mesh.position.x,
          p.mesh.position.z,
          p.mesh.position.y
        );
        if (
          basin &&
          p.mesh.position.y <= basin.surfaceY + 0.36 &&
          p.mesh.position.y >= basin.surfaceY - 3.2
        ) {
          const splashSpeed = Math.hypot(
            p.body.velocity.x,
            p.body.velocity.y,
            p.body.velocity.z
          );
          _ripplePos.set(p.mesh.position.x, basin.surfaceY, p.mesh.position.z);
          if (this.onPropWaterSplosh) {
            this.onPropWaterSplosh(p, _ripplePos, splashSpeed);
          } else {
            onRipple?.(_ripplePos, 2.8);
          }
          if (basin.onPropSplash) {
            basin.onPropSplash(p);
          } else {
            this.removeProp(p);
          }
          continue;
        }
      } else {
        p.inWater = false;
        p.syncedWhileSleeping = false;
        this.propGrid.updatePoint(p, p.mesh.position.x, p.mesh.position.z);
      }
    }

    if (this.propsNeedCompact) {
      this.compactPropsInPlace();
    }
  }

  public dispose(): void {
    this.world.removeEventListener('preStep', this.preStepHandler);
    while (this.world.bodies.length > 0) {
      this.world.removeBody(this.world.bodies[this.world.bodies.length - 1]);
    }
    this.propGrid.clear();
    this.peckSwitchGrid.clear();
    this.propsByKind.clear();
    this.nestMaterialProps.length = 0;
    this.glideLiftProps.length = 0;
    this.buoyantProps.length = 0;
    this.activeSquashTrampolines.length = 0;
    this.props.length = 0;
    this.trampolines.length = 0;
    this.updrafts.length = 0;
    this.basins.length = 0;
    this.peckSwitches.length = 0;
    this.obstacleCells.clear();
    this.staticObstacles.length = 0;
    this.noWalkCells.clear();
    this.noWalkZones.length = 0;
  }
}
