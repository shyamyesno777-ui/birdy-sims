import * as THREE from 'three/webgpu';
import { packSpatialCellKey } from '../core/SpatialGrid2D.ts';

export interface PerchSegment {
  id: string;
  /** World-space start and end points (updated dynamically for trams, boats and NPC hats/shoulders) */
  getEndpoints: (outA: THREE.Vector3, outB: THREE.Vector3) => void;
  /** Optional fast XZ bounding center & half-span pre-filter to avoid expensive skeleton queries when far away */
  getApproxCenter?: (outCenter: THREE.Vector3) => void;
  approxHalfSpan?: number;
  /** Radius of the perch surface so feet rest cleanly on top */
  radius: number;
  /** Surface sound category */
  surface: 'wood' | 'metal' | 'stone' | 'foliage' | 'fabric';
  /** Optional callback when bird lands (e.g. NPC hat/shoulder, lantern, wire, or shutter reaction) */
  onLand?: (t: number, speed: number) => void;
  /** Optional callback when bird kicks off from the perch */
  onLeave?: (t: number, kickSpeed: number) => void;
  /** Optional dynamic vertical sag/bounce offset along `t` (e.g. plucked catenary wires) */
  getVerticalOffset?: (t: number) => number;
}

export interface PerchQueryResult {
  segment: PerchSegment;
  t: number;
  worldPoint: THREE.Vector3;
}

/** Allocates a reusable `out` target for findNearestPerch (placeholder segment until the first hit). */
export function createPerchQueryResult(): PerchQueryResult {
  return {
    segment: { id: '', getEndpoints: () => {}, radius: 0.1, surface: 'wood' },
    t: 0.5,
    worldPoint: new THREE.Vector3(),
  };
}

interface StaticPerchEntry {
  seg: PerchSegment;
  a: THREE.Vector3;
  ab: THREE.Vector3;
  lenSq: number;
  marginT: number;
  visitStamp: number;
}

interface DynamicPerchEntry {
  seg: PerchSegment;
  minCx: number;
  maxCx: number;
  minCz: number;
  maxCz: number;
  visitStamp: number;
}

const GRID_CELL_SIZE = 16.0;
const INV_GRID_CELL_SIZE = 1.0 / GRID_CELL_SIZE;

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _ab = new THREE.Vector3();
const _ap = new THREE.Vector3();
const _closest = new THREE.Vector3();
const _approxCenter = new THREE.Vector3();
const _bestPt = new THREE.Vector3();

/**
 * Spatial-hashed perch registry across the multi-block European neighborhood:
 * - O(1) 2D spatial grid lookup for static railings, eaves, catenary wires, benches & ledges
 * - Spatial-bucketed dynamic perches for moving trams, canal boats, and citizen hats/shoulders
 */
export class PerchSystem {
  private readonly staticGrid = new Map<number, StaticPerchEntry[]>();
  private readonly staticEntries: StaticPerchEntry[] = [];
  private readonly dynamicGrid = new Map<number, DynamicPerchEntry[]>();
  private readonly dynamicEntries: DynamicPerchEntry[] = [];
  private readonly dynamicFallbackSegments: PerchSegment[] = [];
  private hasExplicitDynamicSync = false;
  private queryStamp = 0;

  private toCell(v: number): number {
    if (!Number.isFinite(v)) return 0;
    const c = Math.floor(v * INV_GRID_CELL_SIZE);
    return c < -16384 ? -16384 : c > 16384 ? 16384 : c;
  }

  private resetQueryStamps(): void {
    this.queryStamp = 1;
    for (let i = 0; i < this.staticEntries.length; i++) {
      this.staticEntries[i].visitStamp = 0;
    }
    for (let i = 0; i < this.dynamicEntries.length; i++) {
      this.dynamicEntries[i].visitStamp = 0;
    }
  }

  public addStaticSegment(
    id: string,
    a: THREE.Vector3,
    b: THREE.Vector3,
    radius = 0.14,
    surface: PerchSegment['surface'] = 'wood'
  ): PerchSegment {
    const aCopy = a.clone();
    const bCopy = b.clone();
    const ab = bCopy.clone().sub(aCopy);
    const lenSq = ab.lengthSq();
    const len = Math.sqrt(Math.max(1e-6, lenSq));
    const marginT = Math.min(0.35, 0.24 / len);

    const seg: PerchSegment = {
      id,
      getEndpoints: (outA, outB) => {
        outA.copy(aCopy);
        outB.copy(bCopy);
      },
      radius,
      surface,
    };

    if (
      lenSq >= 0.0001 &&
      Number.isFinite(aCopy.x) &&
      Number.isFinite(aCopy.y) &&
      Number.isFinite(aCopy.z) &&
      Number.isFinite(bCopy.x) &&
      Number.isFinite(bCopy.y) &&
      Number.isFinite(bCopy.z)
    ) {
      const entry: StaticPerchEntry = {
        seg,
        a: aCopy,
        ab,
        lenSq,
        marginT,
        visitStamp: 0,
      };
      this.staticEntries.push(entry);
      const minCx = this.toCell(Math.min(aCopy.x, bCopy.x));
      const maxCx = Math.min(minCx + 32, this.toCell(Math.max(aCopy.x, bCopy.x)));
      const minCz = this.toCell(Math.min(aCopy.z, bCopy.z));
      const maxCz = Math.min(minCz + 32, this.toCell(Math.max(aCopy.z, bCopy.z)));

      for (let cx = minCx; cx <= maxCx; cx++) {
        for (let cz = minCz; cz <= maxCz; cz++) {
          const key = packSpatialCellKey(cx, cz);
          let bucket = this.staticGrid.get(key);
          if (!bucket) {
            bucket = [];
            this.staticGrid.set(key, bucket);
          }
          bucket.push(entry);
        }
      }
    }

    return seg;
  }

  public addDynamicSegment(seg: PerchSegment): PerchSegment {
    if (!seg.getApproxCenter) {
      this.dynamicFallbackSegments.push(seg);
      return seg;
    }

    const entry: DynamicPerchEntry = {
      seg,
      minCx: 0,
      maxCx: -1,
      minCz: 0,
      maxCz: -1,
      visitStamp: 0,
    };
    this.dynamicEntries.push(entry);
    this.syncDynamicEntry(entry);
    return seg;
  }

  /**
   * Re-buckets dynamic perch segments whose XZ bounding cells changed since the last frame.
   * Call once per frame after NPC and animated world prop updates.
   */
  public refreshDynamicGrid(): void {
    this.hasExplicitDynamicSync = true;
    for (let i = 0; i < this.dynamicEntries.length; i++) {
      this.syncDynamicEntry(this.dynamicEntries[i]);
    }
  }

  private syncDynamicEntry(entry: DynamicPerchEntry): void {
    const seg = entry.seg;
    if (!seg.getApproxCenter) return;
    seg.getApproxCenter(_approxCenter);
    if (!Number.isFinite(_approxCenter.x) || !Number.isFinite(_approxCenter.z)) return;
    const halfSpan = Math.min(64.0, Math.max(0.5, seg.approxHalfSpan ?? 3.0));
    const minCx = this.toCell(_approxCenter.x - halfSpan);
    const maxCx = Math.min(minCx + 12, this.toCell(_approxCenter.x + halfSpan));
    const minCz = this.toCell(_approxCenter.z - halfSpan);
    const maxCz = Math.min(minCz + 12, this.toCell(_approxCenter.z + halfSpan));

    if (
      minCx === entry.minCx &&
      maxCx === entry.maxCx &&
      minCz === entry.minCz &&
      maxCz === entry.maxCz
    ) {
      return;
    }

    if (entry.maxCx >= entry.minCx && entry.maxCz >= entry.minCz) {
      for (let cx = entry.minCx; cx <= entry.maxCx; cx++) {
        for (let cz = entry.minCz; cz <= entry.maxCz; cz++) {
          const key = packSpatialCellKey(cx, cz);
          const bucket = this.dynamicGrid.get(key);
          if (!bucket) continue;
          const idx = bucket.indexOf(entry);
          if (idx >= 0) {
            const last = bucket.length - 1;
            if (idx < last) bucket[idx] = bucket[last];
            bucket.pop();
            if (bucket.length === 0) this.dynamicGrid.delete(key);
          }
        }
      }
    }

    entry.minCx = minCx;
    entry.maxCx = maxCx;
    entry.minCz = minCz;
    entry.maxCz = maxCz;

    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cz = minCz; cz <= maxCz; cz++) {
        const key = packSpatialCellKey(cx, cz);
        let bucket = this.dynamicGrid.get(key);
        if (!bucket) {
          bucket = [];
          this.dynamicGrid.set(key, bucket);
        }
        bucket.push(entry);
      }
    }
  }

  /**
   * Finds the closest perch candidate within `maxRadius` of `birdPos` without heap allocations on a miss.
   */
  public findNearestPerch(
    birdPos: THREE.Vector3,
    maxRadius: number,
    ignoreId?: string,
    ignoreCooldownActive = false,
    out?: PerchQueryResult
  ): PerchQueryResult | null {
    if (
      !Number.isFinite(birdPos.x) ||
      !Number.isFinite(birdPos.y) ||
      !Number.isFinite(birdPos.z) ||
      !Number.isFinite(maxRadius) ||
      maxRadius <= 0
    ) {
      return null;
    }
    if (!this.hasExplicitDynamicSync && this.dynamicEntries.length > 0) {
      for (let i = 0; i < this.dynamicEntries.length; i++) {
        this.syncDynamicEntry(this.dynamicEntries[i]);
      }
    }

    const clampedRadius = Math.min(maxRadius, GRID_CELL_SIZE * 12);
    const maxSq = clampedRadius * clampedRadius;
    let bestDistSq = maxSq;
    let bestSeg: PerchSegment | null = null;
    let bestT = 0.5;

    if (this.queryStamp >= 0x7ffffff0) {
      this.resetQueryStamps();
    }
    const stamp = ++this.queryStamp;
    const minCx = this.toCell(birdPos.x - clampedRadius);
    const maxCx = this.toCell(birdPos.x + clampedRadius);
    const minCz = this.toCell(birdPos.z - clampedRadius);
    const maxCz = this.toCell(birdPos.z + clampedRadius);

    // 1. Check nearby static segments via 2D spatial grid
    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cz = minCz; cz <= maxCz; cz++) {
        const key = packSpatialCellKey(cx, cz);
        const bucket = this.staticGrid.get(key);
        if (bucket) {
          for (let i = 0; i < bucket.length; i++) {
            const entry = bucket[i];
            if (entry.visitStamp === stamp) continue;
            entry.visitStamp = stamp;

            const seg = entry.seg;
            if (ignoreCooldownActive && seg.id === ignoreId) continue;

            _ap.subVectors(birdPos, entry.a);
            const rawT = _ap.dot(entry.ab) / entry.lenSq;
            const t = Math.max(entry.marginT, Math.min(1.0 - entry.marginT, rawT));
            _closest.copy(entry.a).addScaledVector(entry.ab, t);

            const dSq = _closest.distanceToSquared(birdPos);
            if (dSq < bestDistSq) {
              bestDistSq = dSq;
              bestSeg = seg;
              bestT = t;
              _bestPt.copy(_closest);
            }
          }
        }

        // 2. Check spatial-bucketed dynamic segments (vehicles, citizen hats & shoulders)
        const dynBucket = this.dynamicGrid.get(key);
        if (dynBucket) {
          for (let i = 0; i < dynBucket.length; i++) {
            const entry = dynBucket[i];
            if (entry.visitStamp === stamp) continue;
            entry.visitStamp = stamp;

            const seg = entry.seg;
            if (ignoreCooldownActive && seg.id === ignoreId) continue;

            if (seg.getApproxCenter) {
              seg.getApproxCenter(_approxCenter);
              const reach = maxRadius + (seg.approxHalfSpan ?? 3.0);
              const dx = birdPos.x - _approxCenter.x;
              const dz = birdPos.z - _approxCenter.z;
              if (dx * dx + dz * dz > reach * reach) continue;
            }

            seg.getEndpoints(_a, _b);
            _ab.subVectors(_b, _a);
            const lenSq = _ab.lengthSq();
            if (lenSq < 0.0001) continue;

            const segLen = Math.sqrt(lenSq);
            const marginT = Math.min(0.35, 0.24 / segLen);
            _ap.subVectors(birdPos, _a);
            const t = Math.max(marginT, Math.min(1.0 - marginT, _ap.dot(_ab) / lenSq));
            _closest.copy(_a).addScaledVector(_ab, t);

            const dSq = _closest.distanceToSquared(birdPos);
            if (dSq < bestDistSq) {
              bestDistSq = dSq;
              bestSeg = seg;
              bestT = t;
              _bestPt.copy(_closest);
            }
          }
        }
      }
    }

    // 3. Fallback check for un-bounded dynamic segments without getApproxCenter
    for (let i = 0; i < this.dynamicFallbackSegments.length; i++) {
      const seg = this.dynamicFallbackSegments[i];
      if (ignoreCooldownActive && seg.id === ignoreId) continue;

      seg.getEndpoints(_a, _b);
      _ab.subVectors(_b, _a);
      const lenSq = _ab.lengthSq();
      if (lenSq < 0.0001) continue;

      const segLen = Math.sqrt(lenSq);
      const marginT = Math.min(0.35, 0.24 / segLen);
      _ap.subVectors(birdPos, _a);
      const t = Math.max(marginT, Math.min(1.0 - marginT, _ap.dot(_ab) / lenSq));
      _closest.copy(_a).addScaledVector(_ab, t);

      const dSq = _closest.distanceToSquared(birdPos);
      if (dSq < bestDistSq) {
        bestDistSq = dSq;
        bestSeg = seg;
        bestT = t;
        _bestPt.copy(_closest);
      }
    }

    if (!bestSeg) return null;

    if (out) {
      out.segment = bestSeg;
      out.t = bestT;
      out.worldPoint.copy(_bestPt);
      return out;
    }

    return {
      segment: bestSeg,
      t: bestT,
      worldPoint: _bestPt.clone(),
    };
  }

  public clear(): void {
    this.staticGrid.clear();
    this.staticEntries.length = 0;
    this.dynamicGrid.clear();
    this.dynamicEntries.length = 0;
    this.dynamicFallbackSegments.length = 0;
    this.hasExplicitDynamicSync = false;
    this.queryStamp = 0;
  }
}
