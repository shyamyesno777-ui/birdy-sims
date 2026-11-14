/**
 * Safe 53-bit signed-cell key packing for 2D spatial grids.
 * Supports coordinates up to +/-32,768 cells in X and Z (over +/-524,000 SU at 16 SU/cell)
 * without 32-bit bit-shift wrapping.
 */
export function packSpatialCellKey(cx: number, cz: number): number {
  return (cx + 32768) * 65536 + (cz + 32768);
}

export interface SpatialPointItem {
  x: number;
  z: number;
}

interface PointEntry<T> {
  item: T;
  cx: number;
  cz: number;
  bucketIdx: number;
}

/**
 * Allocation-free 2D spatial hash grid for dynamic or static world entities (props, switches, NPCs).
 * Supports O(1) swap-remove cell updates and bounded XZ radius queries via visitor callbacks.
 */
export class SpatialGrid2D<T> {
  public readonly cellSize: number;
  private readonly invCellSize: number;
  private readonly buckets = new Map<number, PointEntry<T>[]>();
  private readonly entries = new Map<T, PointEntry<T>>();

  constructor(cellSize = 16.0) {
    this.cellSize = Number.isFinite(cellSize) && cellSize >= 0.5 ? cellSize : 16.0;
    this.invCellSize = 1.0 / this.cellSize;
  }

  private toCell(v: number): number {
    if (!Number.isFinite(v)) return 0;
    const c = Math.floor(v * this.invCellSize);
    return c < -16384 ? -16384 : c > 16384 ? 16384 : c;
  }

  public get size(): number {
    return this.entries.size;
  }

  public insertPoint(item: T, x: number, z: number): void {
    const existing = this.entries.get(item);
    if (existing) {
      this.updatePoint(item, x, z);
      return;
    }

    const cx = this.toCell(x);
    const cz = this.toCell(z);
    const key = packSpatialCellKey(cx, cz);
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = [];
      this.buckets.set(key, bucket);
    }

    const entry: PointEntry<T> = {
      item,
      cx,
      cz,
      bucketIdx: bucket.length,
    };
    bucket.push(entry);
    this.entries.set(item, entry);
  }

  public updatePoint(item: T, x: number, z: number): void {
    const entry = this.entries.get(item);
    if (!entry) {
      this.insertPoint(item, x, z);
      return;
    }

    const nextCx = this.toCell(x);
    const nextCz = this.toCell(z);
    if (nextCx === entry.cx && nextCz === entry.cz) return;

    this.detachFromBucket(entry);

    entry.cx = nextCx;
    entry.cz = nextCz;
    const nextKey = packSpatialCellKey(nextCx, nextCz);
    let nextBucket = this.buckets.get(nextKey);
    if (!nextBucket) {
      nextBucket = [];
      this.buckets.set(nextKey, nextBucket);
    }
    entry.bucketIdx = nextBucket.length;
    nextBucket.push(entry);
  }

  public remove(item: T): void {
    const entry = this.entries.get(item);
    if (!entry) return;
    this.detachFromBucket(entry);
    this.entries.delete(item);
  }

  private detachFromBucket(entry: PointEntry<T>): void {
    const key = packSpatialCellKey(entry.cx, entry.cz);
    const bucket = this.buckets.get(key);
    if (!bucket) return;

    const idx = entry.bucketIdx;
    const lastIdx = bucket.length - 1;
    if (idx < lastIdx) {
      const swapped = bucket[lastIdx];
      bucket[idx] = swapped;
      swapped.bucketIdx = idx;
    }
    bucket.pop();
    if (bucket.length === 0) {
      this.buckets.delete(key);
    }
  }

  /**
   * Visits every indexed item whose grid cell overlaps `[x - radius, x + radius] x [z - radius, z + radius]`.
   * Return `false` from `visitor` to stop early. Zero heap allocations per query.
   */
  public queryRadius(
    x: number,
    z: number,
    radius: number,
    visitor: (item: T) => boolean | void
  ): void {
    if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(radius) || radius <= 0) {
      return;
    }
    const maxRadius = this.cellSize * 24;
    const r = radius > maxRadius ? maxRadius : radius;
    const minCx = this.toCell(x - r);
    const maxCx = this.toCell(x + r);
    const minCz = this.toCell(z - r);
    const maxCz = this.toCell(z + r);

    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cz = minCz; cz <= maxCz; cz++) {
        const bucket = this.buckets.get(packSpatialCellKey(cx, cz));
        if (!bucket) continue;
        for (let i = bucket.length - 1; i >= 0; i--) {
          if (i >= bucket.length) continue;
          if (visitor(bucket[i].item) === false) {
            return;
          }
        }
      }
    }
  }

  public clear(): void {
    this.buckets.clear();
    this.entries.clear();
  }
}
