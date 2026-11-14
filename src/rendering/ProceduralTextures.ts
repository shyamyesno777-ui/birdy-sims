import * as THREE from 'three/webgpu';

let cachedAsphaltTexture: THREE.CanvasTexture | null = null;
let cachedSidewalkTexture: THREE.CanvasTexture | null = null;
let cachedSkyEnvTexture: THREE.CanvasTexture | null = null;

function createSeededRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function createFallbackTexture(
  r: number,
  g: number,
  b: number,
  isEnv = false
): THREE.CanvasTexture {
  const data = new Uint8Array([
    r, g, b, 255,
    r, g, b, 255,
    r, g, b, 255,
    r, g, b, 255,
  ]);
  const tex = new THREE.DataTexture(data, 2, 2, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  if (isEnv) {
    tex.mapping = THREE.EquirectangularReflectionMapping;
  } else {
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
  }
  tex.needsUpdate = true;
  return tex as unknown as THREE.CanvasTexture;
}

/**
 * Generates a crisp 512x512 procedural asphalt road CanvasTexture at startup:
 * - Subtle aggregate grain noise + sunlit sheen speckles
 * - Subtle dual-lane tire wear shading
 * - Crisp painted outer shoulder edge lines & dashed center lane markings
 */
export function getAsphaltRoadTexture(maxAnisotropy = 4): THREE.CanvasTexture {
  if (cachedAsphaltTexture) return cachedAsphaltTexture;

  try {
    const size = 512;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      cachedAsphaltTexture = createFallbackTexture(76, 81, 94);
      return cachedAsphaltTexture;
    }
    const rng = createSeededRng(42071);

    // Base slate-lavender asphalt
    ctx.fillStyle = '#4c515e';
    ctx.fillRect(0, 0, size, size);

    // Subtle dual-lane tire tracks along V (vertical axis of texture)
    const drawLaneTrack = (centerX: number) => {
      const grad = ctx.createLinearGradient(centerX - 42, 0, centerX + 42, 0);
      grad.addColorStop(0, 'rgba(34, 38, 46, 0)');
      grad.addColorStop(0.5, 'rgba(32, 36, 45, 0.22)');
      grad.addColorStop(1, 'rgba(34, 38, 46, 0)');
      ctx.fillStyle = grad;
      ctx.fillRect(centerX - 42, 0, 84, size);
    };
    drawLaneTrack(132);
    drawLaneTrack(380);

    // Fine asphalt grain & mineral aggregate speckles (zero allocations via single ImageData pass)
    const imgData = ctx.getImageData(0, 0, size, size);
    const data = imgData.data;
    for (let i = 0; i < data.length; i += 4) {
      const n = (rng() - 0.5) * 20;
      const sparkle = rng() > 0.965 ? 16 : 0;
      data[i] = Math.max(0, Math.min(255, data[i] + n + sparkle));
      data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + n + sparkle));
      data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + n + sparkle + 2));
    }
    ctx.putImageData(imgData, 0, 0);

    // Subtle curb gutter shading on left/right edges
    const leftGutter = ctx.createLinearGradient(0, 0, 26, 0);
    leftGutter.addColorStop(0, 'rgba(28, 30, 38, 0.42)');
    leftGutter.addColorStop(1, 'rgba(28, 30, 38, 0)');
    ctx.fillStyle = leftGutter;
    ctx.fillRect(0, 0, 26, size);

    const rightGutter = ctx.createLinearGradient(size - 26, 0, size, 0);
    rightGutter.addColorStop(0, 'rgba(28, 30, 38, 0)');
    rightGutter.addColorStop(1, 'rgba(28, 30, 38, 0.42)');
    ctx.fillStyle = rightGutter;
    ctx.fillRect(size - 26, 0, 26, size);

    // Crisp painted outer lane edge lines (warm ivory)
    ctx.fillStyle = 'rgba(244, 238, 224, 0.78)';
    ctx.fillRect(22, 0, 8, size);
    ctx.fillRect(size - 30, 0, 8, size);

    // Subtle crosswalk stop-bar / transverse joint hints + dashed center lane markings
    ctx.fillStyle = 'rgba(248, 214, 128, 0.88)';
    const dashCount = 4;
    const step = size / dashCount;
    const dashLen = step * 0.54;
    for (let d = 0; d < dashCount; d++) {
      const y0 = d * step + (step - dashLen) * 0.5;
      ctx.fillRect(size * 0.5 - 5, y0, 10, dashLen);
    }

    // Faint crosswalk zebra accent strips near texture seam for crisp stylized road rhythm
    ctx.fillStyle = 'rgba(244, 238, 224, 0.08)';
    ctx.fillRect(34, 0, size - 68, 2);

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.anisotropy = Math.min(4, maxAnisotropy);
    tex.needsUpdate = true;

    cachedAsphaltTexture = tex;
    return tex;
  } catch {
    cachedAsphaltTexture = createFallbackTexture(76, 81, 94);
    return cachedAsphaltTexture;
  }
}

/**
 * Generates a crisp 512x512 procedural sidewalk & plaza stone tile CanvasTexture:
 * - Warm neutral base designed to multiply cleanly with district vertex colors
 * - Staggered European flagstone tile lines, subtle per-tile tint variation, and fine stone grain
 */
export function getSidewalkPlazaTexture(maxAnisotropy = 4): THREE.CanvasTexture {
  if (cachedSidewalkTexture) return cachedSidewalkTexture;

  try {
    const size = 512;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      cachedSidewalkTexture = createFallbackTexture(239, 236, 230);
      return cachedSidewalkTexture;
    }
    const rng = createSeededRng(91837);

    ctx.fillStyle = '#efece6';
    ctx.fillRect(0, 0, size, size);

    const rows = 4;
    const cols = 4;
    const tileH = size / rows;
    const tileW = size / cols;

    // Staggered flagstone pavers with subtle warm/cool stone variation + sunlit bevels
    for (let r = 0; r < rows; r++) {
      const rowOffset = (r % 2) * (tileW * 0.5);
      for (let c = -1; c <= cols; c++) {
        const x = c * tileW + rowOffset;
        const y = r * tileH;
        const shade = Math.floor(234 + (rng() - 0.5) * 18);
        const warmShift = Math.floor((rng() - 0.5) * 6);
        ctx.fillStyle = `rgb(${Math.min(255, shade + 4)}, ${shade + warmShift}, ${Math.max(200, shade - 6)})`;
        ctx.fillRect(x + 2, y + 2, tileW - 4, tileH - 4);

        // Subtle inner highlight along top/left edge of each stone paver
        ctx.fillStyle = 'rgba(255, 252, 244, 0.42)';
        ctx.fillRect(x + 3, y + 3, tileW - 6, 3);
        ctx.fillRect(x + 3, y + 3, 3, tileH - 6);

        // Subtle inner shadow along bottom/right edge
        ctx.fillStyle = 'rgba(130, 120, 108, 0.22)';
        ctx.fillRect(x + 3, y + tileH - 6, tileW - 6, 3);
        ctx.fillRect(x + tileW - 6, y + 3, 3, tileH - 6);
      }
    }

    // Crisp stone mortar joints (tileable across edges)
    ctx.fillStyle = 'rgba(138, 128, 116, 0.55)';
    for (let r = 0; r < rows; r++) {
      const y = r * tileH;
      ctx.fillRect(0, y, size, 3);
      const rowOffset = (r % 2) * (tileW * 0.5);
      for (let c = -1; c <= cols; c++) {
        const x = c * tileW + rowOffset;
        ctx.fillRect(x, y, 3, tileH);
      }
    }

    // Fine mineral grain across stone pavers
    const imgData = ctx.getImageData(0, 0, size, size);
    const data = imgData.data;
    for (let i = 0; i < data.length; i += 4) {
      const n = (rng() - 0.5) * 14;
      data[i] = Math.max(0, Math.min(255, data[i] + n));
      data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + n));
      data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + n));
    }
    ctx.putImageData(imgData, 0, 0);

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.anisotropy = Math.min(4, maxAnisotropy);
    tex.needsUpdate = true;

    cachedSidewalkTexture = tex;
    return tex;
  } catch {
    cachedSidewalkTexture = createFallbackTexture(239, 236, 230);
    return cachedSidewalkTexture;
  }
}

/**
 * Generates a lightweight 256x128 equirectangular golden-hour sky & warm-ground
 * reflection map so MeshStandardMaterial roads, plazas, and golden trophies catch
 * natural sky-blue zenith and golden-horizon specular reflections.
 */
export function getSkyEnvironmentTexture(): THREE.CanvasTexture {
  if (cachedSkyEnvTexture) return cachedSkyEnvTexture;

  try {
    const w = 256;
    const h = 128;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      cachedSkyEnvTexture = createFallbackTexture(246, 207, 164, true);
      return cachedSkyEnvTexture;
    }

    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0.0, '#2d6eb5');
    grad.addColorStop(0.32, '#78b8e6');
    grad.addColorStop(0.5, '#f6cfa4');
    grad.addColorStop(0.56, '#d4b896');
    grad.addColorStop(1.0, '#6e5c4c');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    // Soft warm golden sun lobe for crisp specular sheen glints on roads & metallic trophies
    const sunGlow = ctx.createRadialGradient(w * 0.65, h * 0.38, 2, w * 0.65, h * 0.38, 46);
    sunGlow.addColorStop(0, 'rgba(255, 246, 214, 0.92)');
    sunGlow.addColorStop(0.45, 'rgba(255, 212, 138, 0.42)');
    sunGlow.addColorStop(1, 'rgba(255, 212, 138, 0)');
    ctx.fillStyle = sunGlow;
    ctx.fillRect(0, 0, w, h);

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.needsUpdate = true;

    cachedSkyEnvTexture = tex;
    return tex;
  } catch {
    cachedSkyEnvTexture = createFallbackTexture(246, 207, 164, true);
    return cachedSkyEnvTexture;
  }
}

export function disposeProceduralTextures(): void {
  if (cachedAsphaltTexture) {
    cachedAsphaltTexture.dispose();
    cachedAsphaltTexture = null;
  }
  if (cachedSidewalkTexture) {
    cachedSidewalkTexture.dispose();
    cachedSidewalkTexture = null;
  }
  if (cachedSkyEnvTexture) {
    cachedSkyEnvTexture.dispose();
    cachedSkyEnvTexture = null;
  }
}
