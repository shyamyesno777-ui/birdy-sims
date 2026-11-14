import * as THREE from 'three/webgpu';
import type * as CANNON from 'cannon-es';
import type { PhysicsWorld } from '../physics/PhysicsWorld.ts';
import type { AcousticSoundtrack } from '../audio/AcousticSoundtrack.ts';
import type { WorldFX } from '../rendering/WorldFX.ts';
import {
  createPastelMaterial,
  createUnlitPastelFXMaterial,
  SHARED_NPC_LAMBERT_MAT,
} from '../rendering/StorybookMaterial.ts';
import {
  rbox,
  rcyl,
  smoothSphere,
  transformGeo,
  mergeParts,
  buildBaguetteGeometry,
} from '../geometry/Sculptor.ts';
import { PALETTE } from '../rendering/Palette.ts';

const CRASH_INTERVAL_SEC = 120.0;
const CRASH_DURATION_SEC = 35.0;
const LOAF_COUNT = 16;
const SWARM_PIGEON_COUNT = 15;
const CRASH_BONUS_RADIUS = 64.0;
const CRASH_BONUS_RADIUS_SQ = CRASH_BONUS_RADIUS * CRASH_BONUS_RADIUS;
const LOAF_PICKUP_RADIUS_SQ = 2.65 * 2.65;
const FAR_ANIM_PAUSE_DIST_SQ = 105.0 * 105.0;

// Street intersections clear of the central z=0 tram corridor (x in [-108..+108])
const SAFE_CRASH_INTERSECTIONS: ReadonlyArray<{ x: number; z: number; yaw: number; label: string }> = [
  { x: 0, z: 124, yaw: 0.42, label: 'South Fountain Blvd' },
  { x: 0, z: -124, yaw: -2.65, label: 'North Gallery Crosswalk' },
  { x: 192, z: 0, yaw: 1.95, label: 'East Market Avenue' },
  { x: -192, z: 0, yaw: -1.18, label: 'West Conservatory Way' },
  { x: 0, z: 224, yaw: 0.65, label: 'Outer South Ring' },
  { x: 0, z: -224, yaw: -2.42, label: 'Outer North Ring' },
  { x: 228, z: 0, yaw: 1.72, label: 'Outer East Boulevard' },
  { x: -228, z: 0, yaw: -1.42, label: 'Outer West Boulevard' },
];

interface PooledLoaf {
  mesh: THREE.Mesh;
  halo: THREE.Mesh;
  pos: THREE.Vector3;
  baseRotY: number;
  baseRotZ: number;
  phase: number;
  available: boolean;
}

interface PooledSwarmPigeon {
  root: THREE.Group;
  wingL: THREE.Mesh;
  wingR: THREE.Mesh;
  homePos: THREE.Vector3;
  targetPos: THREE.Vector3;
  pos: THREE.Vector3;
  yaw: number;
  phase: number;
  hopTimer: number;
  peckTimer: number;
  flapSpeed: number;
}

function buildTippedBakeryTruckGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];

  // Truck chassis / underbody
  const chassis = rbox(3.1, 0.45, 7.6, 0.06, PALETTE.ironworkPlum, 2);
  transformGeo(chassis, { pos: [0, 0.55, 0] });
  parts.push(chassis);

  // Cream bakery cargo box
  const cargo = rbox(3.25, 2.35, 5.2, 0.14, PALETTE.wallCreamTrim, 2);
  transformGeo(cargo, { pos: [0, 1.95, -1.05] });
  parts.push(cargo);

  // Golden bakery belt stripe
  const goldStripe = rbox(3.32, 0.34, 5.05, 0.04, PALETTE.goldGlow, 1);
  transformGeo(goldStripe, { pos: [0, 1.92, -1.05] });
  parts.push(goldStripe);

  // Mint/Coral scalloped side awning accents on cargo box
  const awningLeft = rbox(0.28, 0.42, 4.4, 0.06, PALETTE.awningCoral, 1);
  transformGeo(awningLeft, { pos: [-1.72, 2.62, -1.05] });
  parts.push(awningLeft);

  const awningRight = rbox(0.28, 0.42, 4.4, 0.06, PALETTE.awningCoral, 1);
  transformGeo(awningRight, { pos: [1.72, 2.62, -1.05] });
  parts.push(awningRight);

  // Cute round-edged mint bakery cab
  const cab = rbox(2.92, 1.85, 2.15, 0.18, PALETTE.awningMint, 2);
  transformGeo(cab, { pos: [0, 1.65, 2.65] });
  parts.push(cab);

  // Cab windshield pane
  const windshield = rbox(2.4, 0.72, 0.14, 0.04, PALETTE.windowGlass, 1);
  transformGeo(windshield, { pos: [0, 2.02, 3.72] });
  parts.push(windshield);

  // Cab roof sign board (tilted bakery badge)
  const roofSign = rbox(1.9, 0.52, 0.34, 0.07, PALETTE.goldGlow, 1);
  transformGeo(roofSign, { pos: [0, 2.82, 2.45] });
  parts.push(roofSign);

  // 4 Wheels + hubcaps
  const wheelCoords: ReadonlyArray<[number, number]> = [
    [-1.55, 2.45],
    [1.55, 2.45],
    [-1.55, -2.25],
    [1.55, -2.25],
  ];
  for (let i = 0; i < wheelCoords.length; i++) {
    const [wx, wz] = wheelCoords[i];
    const tire = rcyl(0.56, 0.56, 0.38, PALETTE.ironworkPlum, 12);
    transformGeo(tire, { rot: [0, 0, Math.PI * 0.5], pos: [wx, 0.56, wz] });
    parts.push(tire);

    const hub = rcyl(0.28, 0.28, 0.42, PALETTE.porcelainWhite, 10);
    transformGeo(hub, { rot: [0, 0, Math.PI * 0.5], pos: [wx, 0.56, wz] });
    parts.push(hub);
  }

  // Open rear doors showing spilled bakery interior
  const doorL = rbox(0.14, 1.85, 1.25, 0.04, PALETTE.woodOak, 1);
  transformGeo(doorL, { rot: [0, -0.65, 0], pos: [-1.42, 1.88, -4.05] });
  parts.push(doorL);

  const doorR = rbox(0.14, 1.85, 1.25, 0.04, PALETTE.woodOak, 1);
  transformGeo(doorR, { rot: [0, 0.48, 0], pos: [1.48, 1.88, -3.95] });
  parts.push(doorR);

  return mergeParts(parts);
}

function buildSwarmPigeonParts(): {
  body: THREE.BufferGeometry;
  wingL: THREE.BufferGeometry;
  wingR: THREE.BufferGeometry;
} {
  const bodyParts: THREE.BufferGeometry[] = [];

  const torso = smoothSphere(0.19, PALETTE.pigeonWing, 10, 8, [1.0, 0.88, 1.28]);
  transformGeo(torso, { pos: [0, 0.22, 0] });
  bodyParts.push(torso);

  const neck = rcyl(0.095, 0.125, 0.14, PALETTE.pigeonNeckGreen, 8);
  transformGeo(neck, { rot: [0.24, 0, 0], pos: [0, 0.34, 0.11] });
  bodyParts.push(neck);

  const head = smoothSphere(0.1, PALETTE.pigeonSlate, 9, 7);
  transformGeo(head, { pos: [0, 0.43, 0.16] });
  bodyParts.push(head);

  const beak = rcyl(0.008, 0.032, 0.09, PALETTE.awningGold, 6);
  transformGeo(beak, { rot: [Math.PI * 0.5, 0, 0], pos: [0, 0.41, 0.27] });
  bodyParts.push(beak);

  const tail = rbox(0.16, 0.035, 0.24, 0.015, PALETTE.pigeonSlate, 1);
  transformGeo(tail, { rot: [-0.26, 0, 0], pos: [0, 0.2, -0.26] });
  bodyParts.push(tail);

  const wingBaseL = rbox(0.28, 0.035, 0.18, 0.015, PALETTE.pigeonWing, 1);
  transformGeo(wingBaseL, { pos: [-0.14, 0, 0] });

  const wingBaseR = rbox(0.28, 0.035, 0.18, 0.015, PALETTE.pigeonWing, 1);
  transformGeo(wingBaseR, { pos: [0.14, 0, 0] });

  return {
    body: mergeParts(bodyParts),
    wingL: wingBaseL,
    wingR: wingBaseR,
  };
}

/**
 * Modular "Bread Truck Crash" Surprise Event Manager (Phase 6 Web Launch Upgrade).
 * - Triggers every 120 seconds for 35 seconds (or via debug trigger).
 * - Spawns a tipped-over delivery truck at a tram-safe intersection surrounded by 16 glowing
 *   golden bread loaves & 15 swarming pooled neutral pigeons.
 * - Grants 2x XP & Respect within 64 SU of the crash site, plus XP for scooping golden loaves.
 * - Strictly zero runtime shader/geometry allocations and zero innerHTML usage.
 */
export class BreadTruckCrashManager {
  private readonly scene: THREE.Scene;
  private readonly physics: PhysicsWorld;
  private readonly audio: AcousticSoundtrack;
  private readonly fx: WorldFX;
  private readonly awardXpFn: (baseAmount: number, pos: THREE.Vector3) => void;

  private readonly truckRoot = new THREE.Group();
  private readonly truckMesh: THREE.Mesh;
  private readonly truckCollider: CANNON.Body;
  private readonly truckGeo: THREE.BufferGeometry;
  private readonly sharedCelMat: THREE.Material;

  private readonly loafGeo: THREE.BufferGeometry;
  private readonly loafMat: THREE.NodeMaterial;
  private readonly loafHaloGeo: THREE.BufferGeometry;
  private readonly loafHaloMat: THREE.MeshBasicNodeMaterial;
  private readonly loaves: PooledLoaf[] = [];

  private readonly pigeonBodyGeo: THREE.BufferGeometry;
  private readonly pigeonWingLGeo: THREE.BufferGeometry;
  private readonly pigeonWingRGeo: THREE.BufferGeometry;
  private readonly pigeons: PooledSwarmPigeon[] = [];

  // Safe DOM banner (top-center pill below HUD, zero innerHTML, zero backdrop-filter)
  private readonly bannerEl: HTMLDivElement;
  private readonly bannerBadgeEl: HTMLSpanElement;
  private readonly bannerTitleEl: HTMLDivElement;
  private readonly bannerSubEl: HTMLDivElement;
  private readonly bannerZoneEl: HTMLSpanElement;
  private readonly bannerTimerEl: HTMLSpanElement;

  private started = false;
  private active = false;
  private cooldownTimer = CRASH_INTERVAL_SEC;
  private activeTimer = 0;
  private lastIntersectionIdx = -1;
  private readonly crashCenter = new THREE.Vector3(0, 0.03, 124);
  private crashYaw = 0;
  private lastDisplayedSec = -1;
  private lastInZoneUi = false;

  private readonly _tmpVec = new THREE.Vector3();
  private readonly _upAxis = new THREE.Vector3(0, 1, 0);
  private readonly _tmpQuat = new THREE.Quaternion();

  constructor(
    scene: THREE.Scene,
    physics: PhysicsWorld,
    audio: AcousticSoundtrack,
    fx: WorldFX,
    uiRoot: HTMLElement,
    awardXpFn: (baseAmount: number, pos: THREE.Vector3) => void
  ) {
    this.scene = scene;
    this.physics = physics;
    this.audio = audio;
    this.fx = fx;
    this.awardXpFn = awardXpFn;

    this.sharedCelMat = SHARED_NPC_LAMBERT_MAT;

    // Tipped bakery truck mesh + parked off-screen kinematic collider
    this.truckGeo = buildTippedBakeryTruckGeometry();
    this.truckMesh = new THREE.Mesh(this.truckGeo, this.sharedCelMat);
    this.truckMesh.castShadow = false;
    this.truckMesh.receiveShadow = true;
    // Tipped onto its left side (~59 deg)
    this.truckMesh.rotation.z = 1.03;
    this.truckMesh.position.set(0, 1.02, 0);
    this.truckRoot.add(this.truckMesh);
    this.truckRoot.visible = false;
    this.truckRoot.position.set(0, -200, 0);
    this.scene.add(this.truckRoot);

    this.truckCollider = this.physics.addKinematicBox(
      new THREE.Vector3(0, -200, 0),
      new THREE.Vector3(1.5, 1.4, 3.6)
    );

    // Pre-allocate 16 glowing golden bread loaves (shared geo + glowing gold cel mat)
    this.loafGeo = buildBaguetteGeometry();
    this.loafGeo.scale(1.65, 1.65, 1.65);
    this.loafMat = createPastelMaterial({
      vertexColors: true,
      emissiveHex: 0xffc642,
      emissiveIntensity: 0.8,
      rimStrength: 0.16,
    });
    this.loafHaloGeo = new THREE.CircleGeometry(0.75, 12);
    this.loafHaloGeo.rotateX(-Math.PI * 0.5);
    this.loafHaloMat = createUnlitPastelFXMaterial(0xffe169, 0.36, true);

    for (let i = 0; i < LOAF_COUNT; i++) {
      const mesh = new THREE.Mesh(this.loafGeo, this.loafMat);
      mesh.castShadow = false;
      mesh.visible = false;
      mesh.position.set(0, -200, 0);
      this.scene.add(mesh);

      const halo = new THREE.Mesh(this.loafHaloGeo, this.loafHaloMat);
      halo.visible = false;
      halo.position.set(0, -200, 0);
      this.scene.add(halo);

      this.loaves.push({
        mesh,
        halo,
        pos: new THREE.Vector3(0, -200, 0),
        baseRotY: (i * 1.17) % (Math.PI * 2),
        baseRotZ: ((i % 3) - 1) * 0.14,
        phase: i * 0.71,
        available: false,
      });
    }

    // Pre-allocate 15 swarming neutral pigeons (shared geometries & shared pastel material)
    const pigParts = buildSwarmPigeonParts();
    this.pigeonBodyGeo = pigParts.body;
    this.pigeonWingLGeo = pigParts.wingL;
    this.pigeonWingRGeo = pigParts.wingR;

    for (let i = 0; i < SWARM_PIGEON_COUNT; i++) {
      const root = new THREE.Group();
      const body = new THREE.Mesh(this.pigeonBodyGeo, this.sharedCelMat);
      body.castShadow = false;
      root.add(body);

      const wingL = new THREE.Mesh(this.pigeonWingLGeo, this.sharedCelMat);
      wingL.position.set(-0.14, 0.28, 0.02);
      root.add(wingL);

      const wingR = new THREE.Mesh(this.pigeonWingRGeo, this.sharedCelMat);
      wingR.position.set(0.14, 0.28, 0.02);
      root.add(wingR);

      root.visible = false;
      root.position.set(0, -180, 0);
      this.scene.add(root);

      this.pigeons.push({
        root,
        wingL,
        wingR,
        homePos: new THREE.Vector3(),
        targetPos: new THREE.Vector3(),
        pos: new THREE.Vector3(0, -180, 0),
        yaw: (i * 0.9) % (Math.PI * 2),
        phase: i * 0.83,
        hopTimer: (i * 0.29) % 1.4,
        peckTimer: (i * 0.41) % 2.1,
        flapSpeed: 12.5 + (i % 4) * 1.6,
      });
    }

    // Top-screen Breaking News Banner (safe createElement + textContent only)
    this.bannerEl = document.createElement('div');
    this.bannerEl.className = 'bread-crash-banner is-hidden';
    this.bannerEl.setAttribute('aria-live', 'polite');

    const topRow = document.createElement('div');
    topRow.className = 'bread-crash-top';

    this.bannerBadgeEl = document.createElement('span');
    this.bannerBadgeEl.className = 'bread-crash-badge';
    this.bannerBadgeEl.textContent = 'BREAKING NEWS';

    this.bannerTitleEl = document.createElement('div');
    this.bannerTitleEl.className = 'bread-crash-title';
    this.bannerTitleEl.textContent = 'BREAD TRUCK CRASH!';

    this.bannerTimerEl = document.createElement('span');
    this.bannerTimerEl.className = 'bread-crash-timer';
    this.bannerTimerEl.textContent = '35s';

    topRow.appendChild(this.bannerBadgeEl);
    topRow.appendChild(this.bannerTitleEl);
    topRow.appendChild(this.bannerTimerEl);

    const bottomRow = document.createElement('div');
    bottomRow.className = 'bread-crash-bottom';

    this.bannerSubEl = document.createElement('div');
    this.bannerSubEl.className = 'bread-crash-sub';
    this.bannerSubEl.textContent = 'Golden loaves spilled! Fight or extort nearby for 2x XP & Respect!';

    this.bannerZoneEl = document.createElement('span');
    this.bannerZoneEl.className = 'bread-crash-zone';
    this.bannerZoneEl.textContent = '2x ZONE';

    bottomRow.appendChild(this.bannerSubEl);
    bottomRow.appendChild(this.bannerZoneEl);

    this.bannerEl.appendChild(topRow);
    this.bannerEl.appendChild(bottomRow);
    uiRoot.appendChild(this.bannerEl);
  }

  public setStarted(started: boolean): void {
    this.started = started;
  }

  public isActive(): boolean {
    return this.active;
  }

  /**
   * Temporarily moves one instance of every pooled Bread Truck asset (tipped truck,
   * golden loaf + halo, and swarming pigeon) into the active camera view during startup
   * loading so `renderer.compile(scene, camera)` compiles all shaders beforehand.
   */
  public setPrewarmMode(prewarming: boolean, camera?: THREE.Camera): void {
    if (this.active) return;
    if (prewarming && camera) {
      camera.getWorldDirection(this._tmpVec);
      const px = camera.position.x + this._tmpVec.x * 12.0;
      const py = camera.position.y + this._tmpVec.y * 12.0;
      const pz = camera.position.z + this._tmpVec.z * 12.0;

      this.truckRoot.position.set(px, py, pz);
      this.truckRoot.visible = true;
      this.truckRoot.traverse((child) => {
        child.frustumCulled = false;
      });

      if (this.loaves.length > 0) {
        const loaf = this.loaves[0];
        loaf.mesh.position.set(px + 1.5, py, pz);
        loaf.mesh.visible = true;
        loaf.mesh.frustumCulled = false;
        loaf.halo.position.set(px + 1.5, py - 0.1, pz);
        loaf.halo.visible = true;
        loaf.halo.frustumCulled = false;
      }

      if (this.pigeons.length > 0) {
        const pig = this.pigeons[0];
        pig.root.position.set(px - 1.5, py, pz);
        pig.root.visible = true;
        pig.root.traverse((child) => {
          child.frustumCulled = false;
        });
      }
      return;
    }

    this.truckRoot.visible = false;
    this.truckRoot.position.set(0, -200, 0);
    this.truckRoot.traverse((child) => {
      child.frustumCulled = true;
    });

    for (let i = 0; i < this.loaves.length; i++) {
      this.loaves[i].mesh.visible = false;
      this.loaves[i].mesh.position.set(0, -200, 0);
      this.loaves[i].mesh.frustumCulled = true;
      this.loaves[i].halo.visible = false;
      this.loaves[i].halo.position.set(0, -200, 0);
      this.loaves[i].halo.frustumCulled = true;
    }

    for (let i = 0; i < this.pigeons.length; i++) {
      this.pigeons[i].root.visible = false;
      this.pigeons[i].root.position.set(0, -180, 0);
      this.pigeons[i].root.traverse((child) => {
        child.frustumCulled = true;
      });
    }
  }

  public getCooldownRemaining(): number {
    return this.cooldownTimer;
  }

  public isNearCrashSite(pos: THREE.Vector3): boolean {
    if (!this.active) return false;
    const dx = pos.x - this.crashCenter.x;
    const dz = pos.z - this.crashCenter.z;
    return dx * dx + dz * dz <= CRASH_BONUS_RADIUS_SQ;
  }

  public getXpMultiplier(pos: THREE.Vector3): number {
    return this.isNearCrashSite(pos) ? 2 : 1;
  }

  public triggerCrashNow(forcedIndex?: number): void {
    let idx =
      forcedIndex !== undefined &&
      forcedIndex >= 0 &&
      forcedIndex < SAFE_CRASH_INTERSECTIONS.length
        ? forcedIndex
        : Math.floor(Math.random() * SAFE_CRASH_INTERSECTIONS.length);
    if (forcedIndex === undefined && idx === this.lastIntersectionIdx) {
      idx = (idx + 1) % SAFE_CRASH_INTERSECTIONS.length;
    }
    this.lastIntersectionIdx = idx;

    const spot = SAFE_CRASH_INTERSECTIONS[idx];
    this.crashCenter.set(spot.x, 0.03, spot.z);
    this.crashYaw = spot.yaw;

    this.active = true;
    this.activeTimer = CRASH_DURATION_SEC;
    this.lastDisplayedSec = Math.ceil(CRASH_DURATION_SEC);

    // Position tipped truck & sync kinematic box collider
    this.truckRoot.position.copy(this.crashCenter);
    this.truckRoot.rotation.set(0, this.crashYaw, 0);
    this.truckRoot.visible = true;

    this.truckCollider.position.set(this.crashCenter.x, 1.45, this.crashCenter.z);
    this._tmpQuat.setFromAxisAngle(this._upAxis, this.crashYaw);
    this.truckCollider.quaternion.set(
      this._tmpQuat.x,
      this._tmpQuat.y,
      this._tmpQuat.z,
      this._tmpQuat.w
    );

    // Scatter 16 glowing golden bread loaves in an inviting spill ring
    for (let i = 0; i < this.loaves.length; i++) {
      const loaf = this.loaves[i];
      const angle = (i / LOAF_COUNT) * Math.PI * 2 + (i % 2 === 0 ? 0.14 : -0.11);
      const radius = 4.6 + (i % 4) * 2.15 + Math.sin(i * 1.9) * 0.7;
      const lx = this.crashCenter.x + Math.cos(angle) * radius;
      const lz = this.crashCenter.z + Math.sin(angle) * radius;
      loaf.pos.set(lx, 0.24, lz);
      loaf.mesh.position.copy(loaf.pos);
      loaf.mesh.rotation.set(0.08, loaf.baseRotY, loaf.baseRotZ);
      loaf.mesh.visible = true;
      loaf.halo.position.set(lx, 0.055, lz);
      loaf.halo.visible = true;
      loaf.available = true;
    }

    // Spawn 15 neutral pigeons descending from the sky onto the bread spill
    for (let i = 0; i < this.pigeons.length; i++) {
      const p = this.pigeons[i];
      const ang = (i / SWARM_PIGEON_COUNT) * Math.PI * 2 + 0.25;
      const rad = 5.2 + (i % 5) * 2.1;
      const hx = this.crashCenter.x + Math.cos(ang) * rad;
      const hz = this.crashCenter.z + Math.sin(ang) * rad;
      p.homePos.set(hx, 0.03, hz);
      p.targetPos.copy(p.homePos);
      p.pos.set(hx + Math.cos(ang) * 7.5, 13.5 + (i % 4) * 2.4, hz + Math.sin(ang) * 7.5);
      p.yaw = Math.atan2(hx - p.pos.x, hz - p.pos.z);
      p.root.position.copy(p.pos);
      p.root.rotation.set(0, p.yaw, 0);
      p.root.visible = true;
      p.hopTimer = (i * 0.27) % 1.2;
      p.peckTimer = (i * 0.43) % 1.9;
    }

    // Update & reveal Top Banner
    this.bannerSubEl.textContent = `Spill at ${spot.label} — 2x XP & Respect within ${CRASH_BONUS_RADIUS}m!`;
    this.bannerTimerEl.textContent = `${this.lastDisplayedSec}s`;
    this.bannerZoneEl.classList.remove('is-in-zone');
    this.lastInZoneUi = false;
    this.bannerEl.classList.remove('is-hidden');

    // Procedural celebratory bakery crash alert + particle burst (zero external URLs)
    this.audio.playRebellionAlert(false);
    this.audio.playPigeonCoo(this.crashCenter);
    this._tmpVec.set(this.crashCenter.x, 1.4, this.crashCenter.z);
    this.fx.spawnBurst(this._tmpVec, 14, true, 5.2);
  }

  public endCrash(): void {
    if (!this.active) return;
    this.active = false;
    this.activeTimer = 0;
    this.cooldownTimer = CRASH_INTERVAL_SEC;

    this.truckRoot.visible = false;
    this.truckRoot.position.set(0, -200, 0);
    this.truckCollider.position.set(0, -200, 0);

    for (let i = 0; i < this.loaves.length; i++) {
      this.loaves[i].available = false;
      this.loaves[i].mesh.visible = false;
      this.loaves[i].halo.visible = false;
    }
    for (let i = 0; i < this.pigeons.length; i++) {
      this.pigeons[i].root.visible = false;
      this.pigeons[i].root.position.set(0, -180, 0);
    }

    this.bannerEl.classList.add('is-hidden');
  }

  public update(
    rawDt: number,
    elapsed: number,
    birdPos: THREE.Vector3,
    camPos?: THREE.Vector3
  ): void {
    if (!this.started) return;
    const dt = Math.min(0.05, Math.max(0.0001, rawDt));

    if (!this.active) {
      this.cooldownTimer -= dt;
      if (this.cooldownTimer <= 0) {
        this.triggerCrashNow();
      }
      return;
    }

    this.activeTimer -= dt;
    if (this.activeTimer <= 0) {
      this.endCrash();
      return;
    }

    // Update top banner countdown & 2x-zone indicator only when integer second or zone changes
    const secLeft = Math.max(1, Math.ceil(this.activeTimer));
    if (secLeft !== this.lastDisplayedSec) {
      this.lastDisplayedSec = secLeft;
      this.bannerTimerEl.textContent = `${secLeft}s`;
    }
    const inZone = this.isNearCrashSite(birdPos);
    if (inZone !== this.lastInZoneUi) {
      this.lastInZoneUi = inZone;
      this.bannerZoneEl.classList.toggle('is-in-zone', inZone);
      this.bannerZoneEl.textContent = inZone ? '2x ZONE ACTIVE' : '2x ZONE NEARBY';
    }

    const camRef = camPos ?? birdPos;
    const dxCamCenter = this.crashCenter.x - camRef.x;
    const dzCamCenter = this.crashCenter.z - camRef.z;
    const farFromCamera = dxCamCenter * dxCamCenter + dzCamCenter * dzCamCenter > FAR_ANIM_PAUSE_DIST_SQ;

    // 1. Animate loaves & check player golden loaf pickup (awards 20 base -> 40 XP inside crash zone!)
    for (let i = 0; i < this.loaves.length; i++) {
      const loaf = this.loaves[i];
      if (!loaf.available) continue;

      const dx = birdPos.x - loaf.pos.x;
      const dy = birdPos.y - (loaf.pos.y + 0.35);
      const dz = birdPos.z - loaf.pos.z;
      if (dx * dx + dy * dy + dz * dz <= LOAF_PICKUP_RADIUS_SQ) {
        loaf.available = false;
        loaf.mesh.visible = false;
        loaf.halo.visible = false;
        this.fx.spawnBreadcrumbCrumbs(loaf.pos, 10);
        this.fx.spawnBurst(loaf.pos, 7, true, 3.6);
        this.audio.playBreadcrumbCrunch();
        this.audio.playSparrowMicroChirp('perch');
        this.awardXpFn(20, loaf.pos);
        continue;
      }

      if (!farFromCamera) {
        const bob = Math.sin(elapsed * 3.4 + loaf.phase) * 0.08;
        loaf.mesh.position.y = loaf.pos.y + bob;
        loaf.mesh.rotation.y = loaf.baseRotY + Math.sin(elapsed * 1.4 + loaf.phase) * 0.12;
        const haloPulse = 0.88 + Math.sin(elapsed * 4.2 + loaf.phase) * 0.16;
        loaf.halo.scale.set(haloPulse, 1, haloPulse);
      }
    }

    // 2. Update 15 pooled neutral swarming pigeons (swoop down, hop, peck around loaves)
    const flutterOff = this.activeTimer < 2.2;
    for (let i = 0; i < this.pigeons.length; i++) {
      const p = this.pigeons[i];
      if (flutterOff) {
        p.pos.y += (8.5 + (i % 3) * 1.8) * dt;
        p.pos.x += Math.cos(p.phase + elapsed) * 3.5 * dt;
        p.pos.z += Math.sin(p.phase + elapsed) * 3.5 * dt;
        p.root.position.copy(p.pos);
        if (!farFromCamera) {
          const flap = Math.sin(elapsed * p.flapSpeed + p.phase) * 0.85;
          p.wingL.rotation.z = flap;
          p.wingR.rotation.z = -flap;
        }
        continue;
      }

      const dHomeX = p.targetPos.x - p.pos.x;
      const dHomeZ = p.targetPos.z - p.pos.z;
      const horizDistSq = dHomeX * dHomeX + dHomeZ * dHomeZ;
      const airborne = p.pos.y > 0.25;

      if (airborne) {
        const speed = 10.5;
        const dist = Math.max(0.01, Math.sqrt(horizDistSq));
        if (dist > 0.35) {
          p.pos.x += (dHomeX / dist) * Math.min(dist, speed * dt);
          p.pos.z += (dHomeZ / dist) * Math.min(dist, speed * dt);
          p.yaw = Math.atan2(dHomeX, dHomeZ);
        }
        p.pos.y = Math.max(0.03, p.pos.y - 6.8 * dt);
        p.root.position.copy(p.pos);
        p.root.rotation.set(0.12, p.yaw, 0);
        if (!farFromCamera) {
          const flap = Math.sin(elapsed * p.flapSpeed + p.phase) * 0.82;
          p.wingL.rotation.z = flap;
          p.wingR.rotation.z = -flap;
        }
        continue;
      }

      if (farFromCamera) continue;

      // Ground pecking & hopping around scattered loaves
      p.hopTimer -= dt;
      if (p.hopTimer <= 0) {
        p.hopTimer = 1.1 + ((i * 37) % 13) * 0.11;
        const nextAng = elapsed * 0.9 + p.phase;
        p.targetPos.set(
          p.homePos.x + Math.cos(nextAng) * 1.4,
          0.03,
          p.homePos.z + Math.sin(nextAng) * 1.4
        );
      }

      if (horizDistSq > 0.04) {
        const dist = Math.sqrt(horizDistSq);
        const step = Math.min(dist, 2.35 * dt);
        p.pos.x += (dHomeX / dist) * step;
        p.pos.z += (dHomeZ / dist) * step;
        p.yaw = Math.atan2(dHomeX, dHomeZ);
        const hopY = Math.abs(Math.sin(elapsed * 11.0 + p.phase)) * 0.11;
        p.root.position.set(p.pos.x, 0.03 + hopY, p.pos.z);
        p.root.rotation.set(0.08, p.yaw, 0);
        p.wingL.rotation.z = 0.08;
        p.wingR.rotation.z = -0.08;
      } else {
        // Bob head pecking down at crumbs
        p.peckTimer += dt * 4.8;
        const peckDip = Math.max(0, Math.sin(p.peckTimer + p.phase)) * 0.36;
        p.root.position.set(p.pos.x, 0.03, p.pos.z);
        p.root.rotation.set(peckDip, p.yaw, 0);
        p.wingL.rotation.z = 0.04;
        p.wingR.rotation.z = -0.04;
      }
    }
  }

  public dispose(): void {
    this.endCrash();
    this.truckRoot.removeFromParent();
    this.truckGeo.dispose();
    for (let i = 0; i < this.loaves.length; i++) {
      this.loaves[i].mesh.removeFromParent();
      this.loaves[i].halo.removeFromParent();
    }
    this.loaves.length = 0;
    this.loafGeo.dispose();
    this.loafMat.dispose();
    this.loafHaloGeo.dispose();
    this.loafHaloMat.dispose();

    for (let i = 0; i < this.pigeons.length; i++) {
      this.pigeons[i].root.removeFromParent();
    }
    this.pigeons.length = 0;
    this.pigeonBodyGeo.dispose();
    this.pigeonWingLGeo.dispose();
    this.pigeonWingRGeo.dispose();

    this.bannerEl.remove();
  }
}
