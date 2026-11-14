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
    t: 0.0, // Dawn
    zenith: new THREE.Color(PALETTE.skyZenithDawn),
    mid: new THREE.Color(PALETTE.skyMidDawn),
    horizon: new THREE.Color(PALETTE.skyHorizonDawn),
    fog: new THREE.Color(PALETTE.fogDawn),
    sunColor: new THREE.Color(0xffe7c2),
    skyFill: new THREE.Color(0.38, 0.43, 0.56),
    bounceFill: new THREE.Color(0.40, 0.33, 0.29),
    hemiSky: new THREE.Color(PALETTE.skyMidDawn),
    hemiGround: new THREE.Color(PALETTE.plazaWarmStone),
    sunIntensity: 1.02,
    hemiIntensity: 0.54,
    night: 0.0,
    dusk: 0.55,
  },
  {
    t: 0.16, // Crisp Morning
    zenith: new THREE.Color(PALETTE.skyZenithDay),
    mid: new THREE.Color(PALETTE.skyMidDay),
    horizon: new THREE.Color(PALETTE.skyHorizonDay),
    fog: new THREE.Color(PALETTE.fogDay),
    sunColor: new THREE.Color(0xfff5e0),
    skyFill: new THREE.Color(0.39, 0.46, 0.60),
    bounceFill: new THREE.Color(0.38, 0.34, 0.30),
    hemiSky: new THREE.Color(PALETTE.skyMidDay),
    hemiGround: new THREE.Color(PALETTE.plazaWarmStone),
    sunIntensity: 1.12,
    hemiIntensity: 0.58,
    night: 0.0,
    dusk: 0.0,
  },
  {
    t: 0.42, // Golden Afternoon
    zenith: new THREE.Color(PALETTE.skyZenithGolden),
    mid: new THREE.Color(PALETTE.skyMidGolden),
    horizon: new THREE.Color(PALETTE.skyHorizonGolden),
    fog: new THREE.Color(PALETTE.fogGolden),
    sunColor: new THREE.Color(0xffe1aa),
    skyFill: new THREE.Color(0.41, 0.43, 0.54),
    bounceFill: new THREE.Color(0.42, 0.34, 0.28),
    hemiSky: new THREE.Color(PALETTE.skyMidGolden),
    hemiGround: new THREE.Color(PALETTE.plazaWarmStone),
    sunIntensity: 1.14,
    hemiIntensity: 0.58,
    night: 0.0,
    dusk: 0.25,
  },
  {
    t: 0.60, // Sunset / Dusk
    zenith: new THREE.Color(PALETTE.skyZenithSunset),
    mid: new THREE.Color(PALETTE.skyMidSunset),
    horizon: new THREE.Color(PALETTE.skyHorizonSunset),
    fog: new THREE.Color(PALETTE.fogSunset),
    sunColor: new THREE.Color(0xff9f68),
    skyFill: new THREE.Color(0.35, 0.29, 0.45),
    bounceFill: new THREE.Color(0.36, 0.26, 0.25),
    hemiSky: new THREE.Color(PALETTE.skyMidSunset),
    hemiGround: new THREE.Color(0x6b534b),
    sunIntensity: 0.86,
    hemiIntensity: 0.48,
    night: 0.18,
    dusk: 1.0,
  },
  {
    t: 0.74, // Starry Moonlit Night
    zenith: new THREE.Color(PALETTE.skyZenithNight),
    mid: new THREE.Color(PALETTE.skyMidNight),
    horizon: new THREE.Color(PALETTE.skyHorizonNight),
    fog: new THREE.Color(PALETTE.fogNight),
    sunColor: new THREE.Color(0x9bb8f2), // Moonlit key tint
    skyFill: new THREE.Color(0.16, 0.22, 0.37),
    bounceFill: new THREE.Color(0.14, 0.15, 0.24),
    hemiSky: new THREE.Color(PALETTE.skyMidNight),
    hemiGround: new THREE.Color(0x283044),
    sunIntensity: 0.52,
    hemiIntensity: 0.44,
    night: 1.0,
    dusk: 0.0,
  },
  {
    t: 0.90, // Late Night Pre-Dawn
    zenith: new THREE.Color(PALETTE.skyZenithNight),
    mid: new THREE.Color(PALETTE.skyMidNight),
    horizon: new THREE.Color(0x3a4a6e),
    fog: new THREE.Color(0x23304d),
    sunColor: new THREE.Color(0xa6c0f5),
    skyFill: new THREE.Color(0.18, 0.24, 0.39),
    bounceFill: new THREE.Color(0.16, 0.17, 0.25),
    hemiSky: new THREE.Color(PALETTE.skyMidNight),
    hemiGround: new THREE.Color(0x2e3548),
    sunIntensity: 0.54,
    hemiIntensity: 0.45,
    night: 0.92,
    dusk: 0.12,
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
const _gradeNight = new THREE.Color(0.86, 0.91, 1.06);
const _gradeDusk = new THREE.Color(1.05, 0.96, 0.91);
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
  if (t < 0.14 || t >= 0.93) return 'dawn';
  if (t < 0.53) return 'day';
  if (t < 0.69) return 'sunset';
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
      dawn: 0.24, // dawn -> day
      day: 0.60, // day -> sunset
      sunset: 0.78, // sunset -> night
      night: 0.05, // night -> dawn
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

    const nightFactor = k0.night + (k1.night - k0.night) * u;
    const duskFactor = k0.dusk + (k1.dusk - k0.dusk) * u;
    const baseSunInt = k0.sunIntensity + (k1.sunIntensity - k0.sunIntensity) * u;
    const baseHemiInt = k0.hemiIntensity + (k1.hemiIntensity - k0.hemiIntensity) * u;

    // Preserve VignetteDirector's golden morning bloom warmth during daytime
    const dayWarmthMask = Math.max(0, 1.0 - nightFactor * 1.35) * this.awakeningFactor;
    _tmpFog.lerp(_goldenFog, dayWarmthMask * 0.45);

    // 3. Apply overcast / rain / mist tinting
    const overcast = Math.min(1.0, this.rainAmount * 0.85 + this.mistAmount * 0.55);
    const skyOvercastMix = overcast * (1.0 - nightFactor * 0.55);
    _tmpZenith.lerp(_overcastSky, skyOvercastMix * 0.62);
    _tmpMid.lerp(_overcastSky, skyOvercastMix * 0.58);
    _tmpHorizon.lerp(_overcastSky, skyOvercastMix * 0.45);

    const targetRainFog = _tmpFog.copy(_tmpFog).lerp(nightFactor > 0.5 ? _nightRainFog : _rainFog, this.rainAmount * 0.68);
    const targetMistFog = nightFactor > 0.5 ? _nightMistFog : _mistFog;
    targetRainFog.lerp(targetMistFog, this.mistAmount * 0.65);

    if (this.scene.background instanceof THREE.Color) {
      this.scene.background.copy(_tmpHorizon);
    }
    if (this.scene.fog instanceof THREE.FogExp2) {
      this.scene.fog.color.copy(_tmpFog);
      const baseDensity = 0.00046 + nightFactor * 0.00028;
      this.scene.fog.density =
        baseDensity + this.rainAmount * 0.00085 + this.mistAmount * 0.00145;
    }

    // 4. Celestial arc for Sun & Moon + seamless key-light handoff
    const sunTheta = this.timeOfDay * Math.PI * 2.0; // 0 = east horizon, PI/2 = high noon, PI = west horizon
    const sunElev = Math.sin(sunTheta + 0.34);
    const sunAz = Math.cos(sunTheta + 0.34);
    _sunArcDir.set(sunAz * 0.68, sunElev, 0.42).normalize();
    _moonArcDir.set(-sunAz * 0.62, Math.max(0.18, -sunElev * 0.85 + 0.35), -0.38).normalize();

    (storybookUniforms.sunDirWorld.value as THREE.Vector3).copy(_sunArcDir);
    (storybookUniforms.moonDirWorld.value as THREE.Vector3).copy(_moonArcDir);

    // Blend key light direction smoothly toward moon when nightFactor > 0.5
    const keyUseMoon = Math.max(0, Math.min(1, (nightFactor - 0.35) / 0.35));
    _targetKeyDir.copy(_sunArcDir).lerp(_moonArcDir, keyUseMoon);
    _targetKeyDir.y = Math.max(0.24, _targetKeyDir.y); // Keep cast shadows well-angled above skyline
    _targetKeyDir.normalize();

    this.sunLight.position.copy(_targetKeyDir).multiplyScalar(146.0);
    if (_prevKeyDir.distanceToSquared(_targetKeyDir) > 0.00004) {
      _prevKeyDir.copy(_targetKeyDir);
      this.onKeyLightDirectionMoved?.();
    }

    const overcastLightAtten = 1.0 - overcast * 0.34;
    this.sunLight.color.copy(_tmpSunCol);
    this.sunLight.intensity = (baseSunInt + dayWarmthMask * 0.14) * overcastLightAtten;
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
    storybookUniforms.bloomStrength.value = 0.16 + nightFactor * 0.18 + duskFactor * 0.08;

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
