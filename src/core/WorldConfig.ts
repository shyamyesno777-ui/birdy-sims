import type * as THREE from 'three/webgpu';

export interface BoxVolumeBounds {
  readonly xMin: number;
  readonly xMax: number;
  readonly yMin: number;
  readonly yMax: number;
  readonly zMin: number;
  readonly zMax: number;
}

/**
 * Central spatial and gameplay configuration for the neighborhood.
 * Consolidating these constants prevents drift across physics fail-safes,
 * flight boundary backstops, indoor conservatory clamping, and shader/camera limits.
 */
export const WORLD_CONFIG = {
  /** Half-extent (SU) of the expanded playable city footprint (~672 x 672 SU total). */
  worldHalfExtent: 336.0,
  /** Soft breeze pushback onset before the hard perimeter backstop. */
  perimeterSoftMargin: 320.0,
  /** Lower fail-safe Y threshold for recovering dropped/tunneling physics props. */
  propFailSafeMinY: -15.0,
  /** Sky dome sphere radius & recommended far clip distance for expanded skyline. */
  skyRadius: 1180.0,
  cameraFar: 1380.0,
  /** Default 2D spatial grid cell size (SU) for perches and interactive props. */
  spatialGridCellSize: 16.0,

  atelier: {
    /** Outer architectural volume used for indoor camera/audio & lighting transitions. */
    outer: {
      xMin: -86.6,
      xMax: -39.4,
      yMin: 26.2,
      yMax: 51.6,
      zMin: 25.4,
      zMax: 78.6,
    } satisfies BoxVolumeBounds,
    /** Watertight interior clamp bounds for the Conservatory Atelier. */
    inner: {
      xMin: -85.36,
      xMax: -40.12,
      yMin: 26.2,
      yMax: 50.92,
      zMin: 26.62,
      zMax: 77.38,
    } satisfies BoxVolumeBounds,
    /** East French window aperture allowing escape onto the balcony. */
    eastAperture: {
      zMin: 43.95,
      zMax: 60.05,
      yMin: 31.38,
      yMax: 47.25,
      outerEastX: -37.45,
    },
  },
} as const;

export function isInsideAtelier(pos: THREE.Vector3): boolean {
  const b = WORLD_CONFIG.atelier.outer;
  return (
    pos.x >= b.xMin &&
    pos.x <= b.xMax &&
    pos.y >= b.yMin &&
    pos.y <= b.yMax &&
    pos.z >= b.zMin &&
    pos.z <= b.zMax
  );
}
