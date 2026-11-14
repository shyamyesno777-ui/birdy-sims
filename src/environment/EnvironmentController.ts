import * as THREE from 'three/webgpu';
import { PALETTE } from '../rendering/Palette.ts';
import { storybookUniforms } from '../rendering/StorybookMaterial.ts';
import type { EventBus, GameEventMap, TimePhase, WeatherType } from '../core/EventBus.ts';

export interface EnvironmentStateSnapshot {
  timeOfDay: number;
  phase: TimePhase;
  weather: WeatherType;
  nightFactor: number;
  duskFactor: number;
  wetness: number;
  rainIntensity: number;
  mistIntensity: number;
  windStrength: number;
  overcastFactor: number;
  cloudSpeedMultiplier: number;
  cyclePaused: boolean;
}

interface SkyKeyframe {
  t: number;
  zenith: THREE.Color;
  mid: THREE.Color;
  horizon: THREE.Color;
  fog: THREE.Color;
  sunColor: THREE.Color;
  skyFill: THREE.Color;
  bounceFill: THREE.Color;
  hemiSky: THREE.Color;
  hemiGround: THREE.Color;
  sunIntensity: number;
  hemiIntensity: number;
  night: number;
  dusk: number;
}

const WEATHER_ORDER: readonly WeatherType[] = ['clear', 'breezy', 'rain', 'mist'];

const KEYFRAMES: readonly SkyKeyframe[] = [
  {
    t: 0.0, // Dawn Start (Soft peachy-pink sunrise glow, low east sun)
    zenith: new THREE.Color(0x466ea8),
    mid: new THREE.Color(0xc98aa2),
    horizon: new THREE.Color(0xf7b99c),
    fog: new THREE.Color(0xf0baa0),
    sunColor: new THREE.Color(0xffb48a),
    skyFill: new THREE.Color(0.39, 0.41, 0.56),
    bounceFill: new THREE.Color(0.42, 0.33, 0.29),
    hemiSky: new THREE.Color(0x8ea6d4),
    hemiGround: new THREE.Color(0xb89382),
    sunIntensity: 0.78,
    hemiIntensity: 0.56,
    night: 0.14,
    dusk: 0.62,
  },
  {
    t: 0.10, // Dawn Peak (Warm rose-peach sunrise glow)
    zenith: new THREE.Color(0x3f73b0),
    mid: new THREE.Color(0xc792a6),
    horizon: new THREE.Color(0xf7c5a6),
    fog: new THREE.Color(0xf2c6aa),
    sunColor: new THREE.Color(0xffc99e),
    skyFill: new THREE.Color(0.40, 0.44, 0.59),
    bounceFill: new THREE.Color(0.42, 0.35, 0.30),
    hemiSky: new THREE.Color(0x8cb3de),
    hemiGround: new THREE.Color(0xb89b88),
    sunIntensity: 1.02,
    hemiIntensity: 0.60,
    night: 0.0,
    dusk: 0.42,
  },
  {
    t: 0.22, // Early Midday (Crisp warm morning sunlight)
    zenith: new THREE.Color(PALETTE.skyZenithDay),
    mid: new THREE.Color(PALETTE.skyMidDay),
    horizon: new THREE.Color(PALETTE.skyHorizonDay),
    fog: new THREE.Color(PALETTE.fogDay),
    sunColor: new THREE.Color(0xffebd0),
    skyFill: new THREE.Color(0.39, 0.47, 0.62),
    bounceFill: new THREE.Color(0.40, 0.35, 0.30),
    hemiSky: new THREE.Color(PALETTE.skyMidDay),
    hemiGround: new THREE.Color(PALETTE.plazaWarmStone),
    sunIntensity: 1.18,
    hemiIntensity: 0.62,
    night: 0.0,
    dusk: 0.06,
  },
  {
    t: 0.44, // High Midday (Crisp warm overhead sunlight)
    zenith: new THREE.Color(PALETTE.skyZenithDay),
    mid: new THREE.Color(PALETTE.skyMidDay),
    horizon: new THREE.Color(0xebf1f5),
    fog: new THREE.Color(PALETTE.fogDay),
    sunColor: new THREE.Color(0xfff1d6),
    skyFill: new THREE.Color(0.40, 0.48, 0.63),
    bounceFill: new THREE.Color(0.41, 0.36, 0.31),
    hemiSky: new THREE.Color(PALETTE.skyMidDay),
    hemiGround: new THREE.Color(PALETTE.plazaWarmStone),
    sunIntensity: 1.24,
    hemiIntensity: 0.64,
    night: 0.0,
    dusk: 0.0,
  },
  {
    t: 0.60, // Entering Golden Sunset (Warm golden-hour transition)
    zenith: new THREE.Color(PALETTE.skyZenithGolden),
    mid: new THREE.Color(PALETTE.skyMidGolden),
    horizon: new THREE.Color(PALETTE.skyHorizonGolden),
    fog: new THREE.Color(PALETTE.fogGolden),
    sunColor: new THREE.Color(0xffcf88),
    skyFill: new THREE.Color(0.40, 0.44, 0.56),
    bounceFill: new THREE.Color(0.43, 0.35, 0.28),
    hemiSky: new THREE.Color(PALETTE.skyMidGolden),
    hemiGround: new THREE.Color(PALETTE.plazaWarmStone),
    sunIntensity: 1.12,
    hemiIntensity: 0.58,
    night: 0.0,
    dusk: 0.42,
  },
  {
    t: 0.73, // Deep Golden Sunset (Deep orange-amber sunset & long stretching shadows)
    zenith: new THREE.Color(PALETTE.skyZenithSunset),
    mid: new THREE.Color(0xb85860),
    horizon: new THREE.Color(0xf78c48),
    fog: new THREE.Color(0xe6885a),
    sunColor: new THREE.Color(0xff8444),
    skyFill: new THREE.Color(0.35, 0.28, 0.44),
    bounceFill: new THREE.Color(0.38, 0.25, 0.22),
    hemiSky: new THREE.Color(0xa65b6a),
    hemiGround: new THREE.Color(0x735046),
    sunIntensity: 0.90,
    hemiIntensity: 0.50,
    night: 0.14,
    dusk: 1.0,
  },
  {
    t: 0.82, // Dusk Horizon (Sun dipping into twilight indigo-amber)
    zenith: new THREE.Color(0x1b2147),
    mid: new THREE.Color(0x4c3c6b),
    horizon: new THREE.Color(0xb55d56),
    fog: new THREE.Color(0x5c4666),
    sunColor: new THREE.Color(0xff6f40),
    skyFill: new THREE.Color(0.24, 0.25, 0.42),
    bounceFill: new THREE.Color(0.22, 0.18, 0.24),
    hemiSky: new THREE.Color(0x4b4c7a),
    hemiGround: new THREE.Color(0x3a3548),
    sunIntensity: 0.32,
    hemiIntensity: 0.48,
    night: 0.68,
    dusk: 0.66,
  },
  {
    t: 0.89, // Moonlit Night (Cool moonlit indigo/blue ambient tint)
    zenith: new THREE.Color(PALETTE.skyZenithNight),
    mid: new THREE.Color(PALETTE.skyMidNight),
    horizon: new THREE.Color(0x2b416e),
    fog: new THREE.Color(0x1c2947),
    sunColor: new THREE.Color(0x8eb0eb),
    skyFill: new THREE.Color(0.18, 0.25, 0.43),
    bounceFill: new THREE.Color(0.15, 0.18, 0.28),
    hemiSky: new THREE.Color(0x324d8a),
    hemiGround: new THREE.Color(0x1e2842),
    sunIntensity: 0.0,
    hemiIntensity: 0.56,
    night: 1.0,
    dusk: 0.0,
  },
  {
    t: 0.96, // Late Night -> Pre-Dawn Horizon Glow
    zenith: new THREE.Color(0x162247),
    mid: new THREE.Color(0x364470),
    horizon: new THREE.Color(0x785b7c),
    fog: new THREE.Color(0x4a4668),
    sunColor: new THREE.Color(0xff9c84),
    skyFill: new THREE.Color(0.24, 0.29, 0.47),
    bounceFill: new THREE.Color(0.22, 0.21, 0.28),
    hemiSky: new THREE.Color(0x475c94),
    hemiGround: new THREE.Color(0x3b3d54),
    sunIntensity: 0.24,
    hemiIntensity: 0.52,
    night: 0.58,
    dusk: 0.46,
  },
];

const _overcastSky = new THREE.Color(PALETTE.skyOvercastTint);
const _rainFog = new THREE.Color(PALETTE.fogRain);
const _mistFog = new THREE.Color(PALETTE.fogMist);
const _goldenFog = new THREE.Color(PALETTE.fogGolden);
const _nightRainFog = new THREE.Color(0x1f2838);
const _nightMistFog = new THREE.Color(0x283548);
const _gradeClear = new THREE.Color(1.0, 1.0, 1.0);
const _gradeRain = new THREE.Color(0.88, 0.93, 1.02);
const _gradeNight = new THREE.Color(0.85, 0.91, 1.08);
const _gradeDusk = new THREE.Color(1.06, 0.95, 0.90);
const _tmpZenith = new THREE.Color();
const _tmpMid = new THREE.Color();
const _tmpHorizon = new THREE.Color();
const _tmpFog = new THREE.Color();
const _tmpSunCol = new THREE.Color();
const _tmpSkyFill = new THREE.Color();
const _tmpBounceFill = new THREE.Color();
const _tmpHemiSky = new THREE.Color();
const _tmpHemiGround = new THREE.Color();
const _tmpGrade = new THREE.Color();
const _prevKeyDir = new THREE.Vector3();
const _targetKeyDir = new THREE.Vector3();
const _sunArcDir = new THREE.Vector3();
const _moonArcDir = new THREE.Vector3();

function computePhaseFromTime(t: number): TimePhase {
  if (t < 0.2) return 'dawn';
  if (t < 0.6) return 'day';
  if (t < 0.82) return 'sunset';
  return 'night';
}

/**
 * Drives the continuous Day/Night cycle (Dawn -> Day -> Sunset -> Starry Night)
 * and Dynamic Weather system (Clear, Breezy, Rain, Mist), keeping directional/hemisphere
 * lighting, fog density, TSL shader uniforms, and gameplay/audio hooks synchronized without allocations.
 */
export class EnvironmentController {
  private timeOfDay = 0.08; // Starts in sunlit morning dawn
  private readonly cycleDurationSeconds = 210.0; // 3.5 minutes per full day-night loop
  private cyclePaused = false;
  private tutorialLocked = true;

  private weather: WeatherType = 'clear';
  private weatherTimer = 46.0;
  private rainAmount = 0.0;
  private breezeAmount = 0.0;
  private mistAmount = 0.0;
  private wetness = 0.0;
  private awakeningFactor = 0.0;

  private lastPhase: TimePhase = computePhaseFromTime(this.timeOfDay);
  private timeEmitAccum = 0;

  private readonly snapshot: EnvironmentStateSnapshot = {
    timeOfDay: this.timeOfDay,
    phase: this.lastPhase,
    weather: this.weather,
    nightFactor: 0,
    duskFactor: 0,
    wetness: 0,
    rainIntensity: 0,
    mistIntensity: 0,
    windStrength: 1.0,
    overcastFactor: 0,
    cloudSpeedMultiplier: 1.0,
    cyclePaused: false,
  };

  constructor(
    private readonly scene: THREE.Scene,
    private readonly sunLight: THREE.DirectionalLight,
    private readonly hemiLight: THREE.HemisphereLight,
    private readonly events?: EventBus<GameEventMap>,
    private readonly onKeyLightDirectionMoved?: () => void
  ) {
    _prevKeyDir.copy(this.sunLight.position).normalize();
    this.applyAtmosphere(0);
  }

  public setTutorialLocked(locked: boolean): void {
    this.tutorialLocked = locked;
  }

  public setAwakeningFactor(val: number): void {
    this.awakeningFactor = Math.max(0, Math.min(1, val));
  }

  public getState(): EnvironmentStateSnapshot {
    return this.snapshot;
  }

  public getWeather(): WeatherType {
    return this.weather;
  }

  public getTimePhase(): TimePhase {
    return this.lastPhase;
  }

  public setWeather(next: WeatherType): void {
    if (this.weather === next) return;
    const prev = this.weather;
    this.weather = next;
    this.weatherTimer = next === 'rain' ? 38.0 : next === 'mist' ? 34.0 : 52.0;
    this.events?.emit('environment:weatherChanged', { weather: next, previous: prev });
  }

  public cycleWeather(): WeatherType {
    const idx = WEATHER_ORDER.indexOf(this.weather);
    const next = WEATHER_ORDER[(idx + 1) % WEATHER_ORDER.length];
    this.setWeather(next);
    return next;
  }

  public advanceTimePhase(): TimePhase {
    // Jump cleanly into the next distinct visual phase: dawn -> day -> sunset -> night
    const phaseTargets: Record<TimePhase, number> = {
      dawn: 0.30, // dawn -> midday
      day: 0.72, // midday -> golden sunset
      sunset: 0.89, // sunset -> night
      night: 0.06, // night -> dawn
    };
    this.timeOfDay = phaseTargets[this.lastPhase];
    this.applyAtmosphere(0);
    this.events?.emit('environment:timeChanged', {
      timeOfDay: this.timeOfDay,
      phase: this.lastPhase,
      nightFactor: this.snapshot.nightFactor,
    });
    return this.lastPhase;
  }

  public setCyclePaused(paused: boolean): void {
    this.cyclePaused = paused;
    this.snapshot.cyclePaused = paused;
  }

  public setTimeOfDay(t: number): void {
    this.timeOfDay = ((t % 1.0) + 1.0) % 1.0;
    this.applyAtmosphere(0);
  }

  public isCyclePaused(): boolean {
    return this.cyclePaused;
  }

  public update(dt: number): EnvironmentStateSnapshot {
    const clamped = Math.min(0.05, Math.max(0.001, dt));

    if (!this.tutorialLocked && !this.cyclePaused) {
      this.timeOfDay = (this.timeOfDay + clamped / this.cycleDurationSeconds) % 1.0;

      // Dynamic weather progression every ~35-55 seconds outside
      this.weatherTimer -= clamped;
      if (this.weatherTimer <= 0) {
        this.pickNextAutoWeather();
      }
    }

    this.applyAtmosphere(clamped);

    this.timeEmitAccum += clamped;
    const nextPhase = computePhaseFromTime(this.timeOfDay);
    if (nextPhase !== this.lastPhase || this.timeEmitAccum >= 0.5) {
      this.lastPhase = nextPhase;
      this.timeEmitAccum = 0;
      this.events?.emit('environment:timeChanged', {
        timeOfDay: this.timeOfDay,
        phase: nextPhase,
        nightFactor: this.snapshot.nightFactor,
      });
    }

    return this.snapshot;
  }

  private pickNextAutoWeather(): void {
    const r = Math.random();
    let next: WeatherType = 'clear';
    if (this.weather === 'clear') {
      next = r < 0.36 ? 'breezy' : r < 0.66 ? 'rain' : r < 0.88 ? 'mist' : 'clear';
    } else if (this.weather === 'breezy') {
      next = r < 0.42 ? 'rain' : r < 0.82 ? 'clear' : 'mist';
    } else if (this.weather === 'rain') {
      next = r < 0.48 ? 'mist' : 'clear';
    } else {
      next = r < 0.65 ? 'clear' : 'breezy';
    }
    this.setWeather(next);
  }

  private applyAtmosphere(dt: number): void {
    // 1. Smoothly blend weather envelopes
    const targetRain = this.weather === 'rain' ? 1.0 : 0.0;
    const targetBreeze = this.weather === 'breezy' ? 1.0 : this.weather === 'rain' ? 0.55 : 0.0;
    const targetMist = this.weather === 'mist' ? 1.0 : this.weather === 'rain' ? 0.25 : 0.0;
    const blend = dt > 0 ? Math.min(1.0, dt * 0.55) : 1.0;

    this.rainAmount += (targetRain - this.rainAmount) * blend;
    this.breezeAmount += (targetBreeze - this.breezeAmount) * blend;
    this.mistAmount += (targetMist - this.mistAmount) * blend;

    const wetTarget = this.weather === 'rain' ? 1.0 : 0.0;
    const wetRate = this.weather === 'rain' ? 0.28 : 0.09; // Wets faster than it dries
    this.wetness += (wetTarget - this.wetness) * (dt > 0 ? Math.min(1.0, dt * wetRate) : 1.0);

    // 2. Sample cyclic sky keyframes
    const n = KEYFRAMES.length;
    let k0 = KEYFRAMES[n - 1];
    let k1 = KEYFRAMES[0];
    let segSpan = 1.0 - k0.t + k1.t;
    let segProgress = this.timeOfDay >= k0.t ? this.timeOfDay - k0.t : 1.0 - k0.t + this.timeOfDay;

    for (let i = 0; i < n - 1; i++) {
      if (this.timeOfDay >= KEYFRAMES[i].t && this.timeOfDay < KEYFRAMES[i + 1].t) {
        k0 = KEYFRAMES[i];
        k1 = KEYFRAMES[i + 1];
        segSpan = k1.t - k0.t;
        segProgress = this.timeOfDay - k0.t;
        break;
      }
    }
    const rawU = Math.max(0, Math.min(1, segProgress / Math.max(1e-4, segSpan)));
    const u = rawU * rawU * (3 - 2 * rawU);

    _tmpZenith.copy(k0.zenith).lerp(k1.zenith, u);
    _tmpMid.copy(k0.mid).lerp(k1.mid, u);
    _tmpHorizon.copy(k0.horizon).lerp(k1.horizon, u);
    _tmpFog.copy(k0.fog).lerp(k1.fog, u);
    _tmpSunCol.copy(k0.sunColor).lerp(k1.sunColor, u);
    _tmpSkyFill.copy(k0.skyFill).lerp(k1.skyFill, u);
    _tmpBounceFill.copy(k0.bounceFill).lerp(k1.bounceFill, u);
    _tmpHemiSky.copy(k0.hemiSky).lerp(k1.hemiSky, u);
    _tmpHemiGround.copy(k0.hemiGround).lerp(k1.hemiGround, u);

    const nightFactor = THREE.MathUtils.lerp(k0.night, k1.night, u);
    const duskFactor = THREE.MathUtils.lerp(k0.dusk, k1.dusk, u);
    const baseSunInt = THREE.MathUtils.lerp(k0.sunIntensity, k1.sunIntensity, u);
    const baseHemiInt = THREE.MathUtils.lerp(k0.hemiIntensity, k1.hemiIntensity, u);

    // Preserve VignetteDirector's golden morning bloom warmth during daytime
    const dayWarmthMask = Math.max(0, 1.0 - nightFactor * 1.35) * this.awakeningFactor;
    _tmpFog.lerp(_goldenFog, dayWarmthMask * 0.45);

    // 3. Apply overcast / rain / mist tinting
    const overcast = Math.min(1.0, this.rainAmount * 0.85 + this.mistAmount * 0.55);
    const skyOvercastMix = overcast * (1.0 - nightFactor * 0.55);
    _tmpZenith.lerp(_overcastSky, skyOvercastMix * 0.62);
    _tmpMid.lerp(_overcastSky, skyOvercastMix * 0.58);
    _tmpHorizon.lerp(_overcastSky, skyOvercastMix * 0.45);

    // Blend clear-weather exponential fog tightly into sky horizon for seamless skyline fade
    _tmpFog.lerp(_tmpHorizon, 0.55);
    _tmpFog.lerp(nightFactor > 0.5 ? _nightRainFog : _rainFog, this.rainAmount * 0.68);
    _tmpFog.lerp(nightFactor > 0.5 ? _nightMistFog : _mistFog, this.mistAmount * 0.65);

    if (this.scene.background instanceof THREE.Color) {
      this.scene.background.copy(_tmpHorizon);
    }
    if (this.scene.fog instanceof THREE.FogExp2) {
      this.scene.fog.color.copy(_tmpFog);
      const baseDensity = 0.00054 + nightFactor * 0.00024;
      this.scene.fog.density =
        baseDensity + this.rainAmount * 0.00085 + this.mistAmount * 0.00145;
    }

    // 4. Continuous Sun Arc across dayProgress (0..1):
    //    Rises low in East (0.0..0.2), sweeps high overhead at Midday (0.2..0.6),
    //    sets low in West (0.65..0.85) with long stretching shadows, and fades softly below horizon at Night (0.82..1.0).
    const t = this.timeOfDay;
    const daylightSpan = 0.84;
    let horizAngle: number;
    let rawSunElev: number;
    if (t <= daylightSpan) {
      const dayU = t / daylightSpan;
      horizAngle = dayU * Math.PI;
      rawSunElev = 0.05 + Math.sin(dayU * Math.PI) * 0.90;
    } else {
      const nightU = (t - daylightSpan) / (1.0 - daylightSpan);
      horizAngle = Math.PI + nightU * Math.PI;
      rawSunElev = 0.05 - Math.sin(nightU * Math.PI) * 0.44;
    }

    const sunAzX = Math.cos(horizAngle) * 0.90;
    const sunAzZ = 0.24 + 0.54 * Math.max(0, Math.sin(horizAngle));
    _sunArcDir.set(sunAzX, rawSunElev, sunAzZ).normalize();
    _moonArcDir
      .set(-sunAzX * 0.72, Math.max(0.24, -rawSunElev * 0.85 + 0.38), -0.36)
      .normalize();

    (storybookUniforms.sunDirWorld.value as THREE.Vector3).copy(_sunArcDir);
    (storybookUniforms.moonDirWorld.value as THREE.Vector3).copy(_moonArcDir);

    // Keep directional shadow elevation shallow at dawn/sunset for visibly stretching shadows,
    // without dropping below 0.13 (prevents CSM shadow frustum collapse). Never snap toward moon at night.
    _targetKeyDir.copy(_sunArcDir);
    _targetKeyDir.y = Math.max(0.13, _targetKeyDir.y);
    _targetKeyDir.normalize();

    this.sunLight.position.copy(_targetKeyDir).multiplyScalar(146.0);
    if (_prevKeyDir.distanceToSquared(_targetKeyDir) > 0.00004) {
      _prevKeyDir.copy(_targetKeyDir);
      this.onKeyLightDirectionMoved?.();
    }

    // Softly fade directional sun & cast shadows out once the sun dips below the horizon at night,
    // and smoothly wake them back up during pre-dawn (0.96 -> 1.0 -> 0.05).
    const horizonFadeOut = 1.0 - THREE.MathUtils.smoothstep(t, 0.82, 0.88);
    const preDawnWake = THREE.MathUtils.smoothstep(t, 0.955, 1.0);
    const dawnFull = THREE.MathUtils.lerp(0.68, 1.0, THREE.MathUtils.smoothstep(t, 0.0, 0.06));
    const sunShadowEnvelope = t >= 0.82 ? Math.max(horizonFadeOut, preDawnWake * 0.68) : dawnFull;

    const overcastLightAtten = 1.0 - overcast * 0.34;
    this.sunLight.color.copy(_tmpSunCol);
    this.sunLight.intensity =
      (baseSunInt + dayWarmthMask * 0.14) * overcastLightAtten * sunShadowEnvelope;
    this.hemiLight.color.copy(_tmpHemiSky);
    this.hemiLight.groundColor.copy(_tmpHemiGround);
    this.hemiLight.intensity =
      (baseHemiInt + dayWarmthMask * 0.08) * (1.0 + overcast * 0.12);

    // 5. Push uniforms to WebGPU TSL pipeline
    storybookUniforms.nightFactor.value = nightFactor;
    storybookUniforms.duskFactor.value = duskFactor * (1.0 - overcast * 0.65);
    storybookUniforms.wetness.value = this.wetness;
    const windStrength = 1.0 + this.breezeAmount * 1.15 + this.rainAmount * 0.72;
    storybookUniforms.windStrength.value = windStrength;
    storybookUniforms.overcastFactor.value = overcast;
    storybookUniforms.bloomStrength.value = 0.20 + nightFactor * 0.20 + duskFactor * 0.09;

    (storybookUniforms.skyZenithColor.value as THREE.Color).copy(_tmpZenith);
    (storybookUniforms.skyMidColor.value as THREE.Color).copy(_tmpMid);
    (storybookUniforms.skyHorizonColor.value as THREE.Color).copy(_tmpHorizon);
    (storybookUniforms.skyFillColor.value as THREE.Color).copy(_tmpSkyFill);
    (storybookUniforms.bounceFillColor.value as THREE.Color).copy(_tmpBounceFill);

    _tmpGrade.copy(_gradeClear).lerp(_gradeDusk, duskFactor * 0.55);
    _tmpGrade.lerp(_gradeNight, nightFactor * 0.65);
    _tmpGrade.lerp(_gradeRain, this.rainAmount * 0.6);
    (storybookUniforms.gradeTintColor.value as THREE.Color).copy(_tmpGrade);

    // 6. Update snapshot (allocation-free)
    this.lastPhase = computePhaseFromTime(this.timeOfDay);
    this.snapshot.timeOfDay = this.timeOfDay;
    this.snapshot.phase = this.lastPhase;
    this.snapshot.weather = this.weather;
    this.snapshot.nightFactor = nightFactor;
    this.snapshot.duskFactor = duskFactor;
    this.snapshot.wetness = this.wetness;
    this.snapshot.rainIntensity = this.rainAmount;
    this.snapshot.mistIntensity = this.mistAmount;
    this.snapshot.windStrength = windStrength;
    this.snapshot.overcastFactor = overcast;
    this.snapshot.cloudSpeedMultiplier = windStrength;
    this.snapshot.cyclePaused = this.cyclePaused;
  }
}
