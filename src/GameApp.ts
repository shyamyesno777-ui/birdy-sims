/// <reference types="vite/client" />
import * as THREE from 'three/webgpu';
import { CSMShadowNode } from 'three/examples/jsm/csm/CSMShadowNode.js';
import { PALETTE } from './rendering/Palette.ts';
import {
  createSkyDomeMesh,
  createStorybookRenderPipeline,
  storybookUniforms,
} from './rendering/StorybookMaterial.ts';
import { WorldFX } from './rendering/WorldFX.ts';
import { PhysicsWorld } from './physics/PhysicsWorld.ts';
import { PerchSystem } from './world/PerchSystem.ts';
import { CityBlockBuilder } from './world/CityBlockBuilder.ts';
import { NPCManager } from './entities/NPCManager.ts';
import { SparrowController } from './entities/SparrowController.ts';
import { BirdCamera } from './camera/BirdCamera.ts';
import { AcousticSoundtrack } from './audio/AcousticSoundtrack.ts';
import { VignetteDirector } from './game/VignetteDirector.ts';
import { TutorialOverlay } from './ui/TutorialOverlay.ts';
import { SparrowJournalHUD } from './ui/SparrowJournalHUD.ts';
import {
  MobileTouchControls,
  detectInitialMobileDevice,
} from './ui/MobileTouchControls.ts';
import type { LoadingScreen } from './ui/LoadingScreen.ts';
import { EventBus, type GameEventMap } from './core/EventBus.ts';
import { EnvironmentController } from './environment/EnvironmentController.ts';
import { CrowdRebellionManager } from './entities/CrowdRebellionManager.ts';
import { CombatStatusHUD } from './ui/CombatStatusHUD.ts';
import { AerialSocialAndDayManager } from './entities/AerialSocialAndDayManager.ts';

export interface SparrowGameSession {
  events: EventBus<GameEventMap>;
  dispose: () => void;
}

const isSoftwareGl = (() => {
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) return true;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
    const gpu = String(gl.getParameter(param));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
  } catch {
    return false;
  }
})();

function computeCappedDpr(
  w: number,
  h: number,
  isMobile = false,
  qualityScale = 1.0
): number {
  if (isSoftwareGl) return 1;
  const pixelBudget = isMobile ? 1_250_000 : 2_350_000;
  const maxDpr = isMobile ? 1.5 : 1.75;
  const maxDprByBudget = Math.sqrt(pixelBudget / Math.max(1, w * h));
  const base = Math.max(1, Math.min(window.devicePixelRatio || 1, maxDpr, maxDprByBudget));
  return Math.max(0.75, Math.min(maxDpr, base * qualityScale));
}

export async function startGameApp(
  loadingScreen: LoadingScreen
): Promise<SparrowGameSession | void> {
  await loadingScreen.advance(8);

  const container = document.getElementById('app');
  if (!container) return;

  const initW = Math.max(1, window.innerWidth);
  const initH = Math.max(1, window.innerHeight);
  let isMobile = detectInitialMobileDevice();

  const renderer = new THREE.WebGPURenderer({
    antialias: !isSoftwareGl,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(computeCappedDpr(initW, initH, isMobile));
  renderer.setSize(initW, initH);
  renderer.toneMappingExposure = 0.98;

  renderer.shadowMap.enabled = !isSoftwareGl;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  container.replaceChildren(renderer.domElement);
  const tutorialOverlay = new TutorialOverlay(container);
  const journalHud = new SparrowJournalHUD(container);
  const combatHud = new CombatStatusHUD(container);
  const mobileControls = new MobileTouchControls(container);
  isMobile = mobileControls.isMobile();
  document.body.classList.toggle('is-mobile', isMobile);
  tutorialOverlay.setMobileMode(isMobile);
  journalHud.setMobileMode(isMobile);

  await renderer.init();

  const drawSize = new THREE.Vector2();
  const syncDrawingBufferResolution = (): void => {
    renderer.getDrawingBufferSize(drawSize);
    storybookUniforms.invResolution.value.set(
      1.0 / Math.max(1, drawSize.x),
      1.0 / Math.max(1, drawSize.y)
    );
  };
  syncDrawingBufferResolution();

  await loadingScreen.advance(14);

  // Morning scene + procedural TSL sky dome + light atmospheric haze
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(PALETTE.skyHorizonDawn);
  scene.fog = new THREE.FogExp2(PALETTE.fogDawn, 0.00046);

  const skyDome = createSkyDomeMesh();
  scene.add(skyDome);

  // Sky-to-limestone hemisphere fill + directional sun with 3-cascade CSM shadows
  const hemiLight = new THREE.HemisphereLight(PALETTE.skyMidDawn, PALETTE.plazaWarmStone, 0.56);
  scene.add(hemiLight);

  const sunLight = new THREE.DirectionalLight(0xfff2da, 1.08);
  sunLight.position.set(68, 118, 52);
  sunLight.target.position.set(0, 0, 0);
  sunLight.castShadow = !isSoftwareGl;
  const shadowRes = isMobile ? 1024 : 2048;
  sunLight.shadow.mapSize.set(shadowRes, shadowRes);
  sunLight.shadow.camera.near = 0.5;
  sunLight.shadow.camera.far = 2400;
  sunLight.shadow.bias = -0.000046;
  sunLight.shadow.normalBias = 0.028;
  sunLight.shadow.radius = 1.8;

  const csmNode = new CSMShadowNode(sunLight, {
    cascades: 3,
    maxFar: 640,
    mode: 'custom',
    lightMargin: 320,
    customSplitsCallback: (_cascades: number, _near: number, _far: number, breaks: number[]) => {
      breaks.push(0.032, 0.17, 1.0);
    },
  });
  csmNode.fade = false;
  if (!isSoftwareGl) {
    (
      sunLight.shadow as THREE.DirectionalLightShadow & { shadowNode?: CSMShadowNode }
    ).shadowNode = csmNode;
  }

  scene.add(sunLight);
  scene.add(sunLight.target);
  sunLight.updateMatrixWorld();
  sunLight.target.updateMatrixWorld();

  // Warm multi-layered morning fill inside the vaulted Conservatory Atelier (static, never toggled at runtime)
  const atticWindowFill = new THREE.PointLight(0xfff1d6, 5.6, 62.0, 1.25);
  atticWindowFill.position.set(-44.0, 40.5, 52.0);
  scene.add(atticWindowFill);

  const atticStudioWarmFill = new THREE.PointLight(0xffdfba, 4.8, 48.0, 1.32);
  atticStudioWarmFill.position.set(-67.5, 41.5, 50.0);
  scene.add(atticStudioWarmFill);

  // Core Subsystems
  const safeUpdateCsmFrustums = (): void => {
    if (isSoftwareGl || !csmNode.mainFrustum) return;
    try {
      csmNode.updateFrustums();
    } catch {
      // Ignore transient frustum update glitches during rapid resize
    }
  };

  const events = new EventBus<GameEventMap>();
  const environment = new EnvironmentController(scene, sunLight, hemiLight, events, () => {
    safeUpdateCsmFrustums();
  });
  const audio = new AcousticSoundtrack();
  const audioPreloadPromise = audio.preload();
  journalHud.onToggleMute = () => audio.toggleMute();
  journalHud.onCycleTime = () => environment.advanceTimePhase();
  journalHud.onCycleWeather = () => environment.cycleWeather();
  journalHud.setTimePhase(environment.getTimePhase());
  journalHud.setWeather(environment.getWeather());
  events.on('environment:timeChanged', ({ phase }) => journalHud.setTimePhase(phase));
  events.on('environment:weatherChanged', ({ weather }) => journalHud.setWeather(weather));

  const fx = new WorldFX(scene);
  const physics = new PhysicsWorld();
  const perches = new PerchSystem();
  const npcs = new NPCManager(scene, perches, physics, audio, fx);
  const crowdManager = new CrowdRebellionManager(scene, perches, physics, audio, fx, events);

  events.on('crowd:kill', ({ kills, mode }) => {
    combatHud.setKillsAndMode(kills, mode);
  });
  events.on('bird:healthChanged', ({ hp, maxHp, delta, downed }) => {
    combatHud.setHealth(hp, maxHp, delta < 0, downed);
  });
  events.on('rebellion:changed', ({ mode }) => {
    combatHud.showEscalationAlert(mode);
  });
  events.on('crowd:admired', ({ admired, cooldownRemaining }) => {
    combatHud.setAdmiredAndCooldown(admired, cooldownRemaining);
  });
  events.on('crowd:trophyShattered', () => {
    combatHud.showExtremeRageAlert();
  });
  events.on('crowd:intimidated', ({ respectGained, totalRespect }) => {
    combatHud.setRespectXp(totalRespect, respectGained);
  });
  events.on('crowd:intimidatePrompt', ({ available }) => {
    combatHud.setIntimidateAvailable(available);
  });

  // Build the 4-block neighborhood & conservatory atelier, reporting loading progress
  const cityBuilder = new CityBlockBuilder(scene, physics, perches, fx, npcs, audio);
  const worldHandles = await cityBuilder.build((pct) => loadingScreen.advance(pct));
  fx.initLampHalos(worldHandles.streetlampPositions);
  perches.refreshDynamicGrid();

  const aerialManager = new AerialSocialAndDayManager(
    scene,
    physics,
    audio,
    fx,
    events,
    environment,
    container,
    worldHandles.streetlampPositions
  );

  combatHud.onRestart = () => {
    crowdManager.reviveBird();
    aerialManager.reviveBird();
  };

  const wakeAudio = () => {
    try {
      audio.unlock();
    } catch (err) {
      console.error('Audio unlock failed:', err);
    }
  };

  const birdCam = new BirdCamera(initW / initH, renderer.domElement, wakeAudio);
  birdCam.setMobileMode(isMobile);
  birdCam.onProjectionChanged = () => {
    safeUpdateCsmFrustums();
  };

  const sparrow = new SparrowController(
    scene,
    renderer.domElement,
    worldHandles.starterSpawnPos,
    worldHandles.starterSpawnYaw,
    perches,
    physics,
    audio,
    fx,
    wakeAudio
  );
  sparrow.cageBounds = worldHandles.cageBounds;
  sparrow.windowBarrier = worldHandles.windowBarrier;
  // Compose Phase 1 story NPCs with Phase 2 object-pooled crowd NPCs without touching SparrowController gun/flight code
  sparrow.npcs = {
    handlePlayerPeck: (beakPos, birdPos) => npcs.handlePlayerPeck(beakPos, birdPos),
    sampleShooGust: (playerPos) => crowdManager.sampleEjectGust() ?? npcs.sampleShooGust(playerPos),
    notifyTablePeck: (beakPos) => npcs.notifyTablePeck(beakPos),
    isHumanCollider: (body) => npcs.isHumanCollider(body),
    notifyAcousticShock: (origin, kind) => npcs.notifyAcousticShock(origin, kind),
    checkFallingDroppingHit: (prevPos, nextPos, birdPos) =>
      npcs.checkFallingDroppingHit(prevPos, nextPos, birdPos),
    checkBulletHit: (prevPos, nextPos, birdPos) => {
      const crowdCand = crowdManager.findBulletHit(prevPos, nextPos);
      const aerialCand = aerialManager.findBulletHit(prevPos, nextPos);
      if (aerialCand && (!crowdCand || aerialCand.distance < crowdCand.distance)) {
        const storyHit = npcs.checkBulletHit(prevPos, aerialCand.point, birdPos);
        if (storyHit?.hit) {
          return storyHit;
        }
        aerialManager.applyBulletHit(aerialCand);
        return {
          hit: true,
          kind: 'companion' as const,
          distance: aerialCand.distance,
          point: aerialCand.point,
        };
      }
      const storyEnd = crowdCand ? crowdCand.point : nextPos;
      const storyHit = npcs.checkBulletHit(prevPos, storyEnd, birdPos);
      if (storyHit?.hit) {
        return storyHit;
      }
      if (crowdCand) {
        crowdManager.applyBulletHit(crowdCand, prevPos, nextPos, birdPos);
        return {
          hit: true,
          kind: 'human' as const,
          distance: crowdCand.distance,
          point: crowdCand.point,
        };
      }
      return null;
    },
  };
  sparrow.worldHandles = worldHandles;
  sparrow.attachMobileControls(mobileControls);
  sparrow.inputEnabled = false;

  let renderQualityScale = 1.0;

  mobileControls.onMobileModeChange = (mobile) => {
    isMobile = mobile;
    document.body.classList.toggle('is-mobile', mobile);
    tutorialOverlay.setMobileMode(mobile);
    journalHud.setMobileMode(mobile);
    birdCam.setMobileMode(mobile);
    const w = Math.max(1, window.innerWidth);
    const h = Math.max(1, window.innerHeight);
    renderer.setPixelRatio(computeCappedDpr(w, h, mobile, renderQualityScale));
    syncDrawingBufferResolution();
  };

  // Prop shatter: ceramic / pigment-jar / terracotta debris, spatial shatter audio, acoustic shock & mischief chirp
  physics.onPropShatter = (prop, pos, shardHex) => {
    fx.spawnShatterDebris(pos, shardHex);
    audio.playCeramicShatter(pos);
    npcs.notifyAcousticShock(pos, 'shatter');
    sparrow.triggerMischiefChirp();
    events.emit('prop:shattered', { prop, kind: prop.kind, pos });
  };

  // Material-specific 3D physics prop bounce/clatter SFX & deep water splosh on fountain/river plunge
  physics.onPropImpact = (prop, pos, speed) => {
    audio.playPropImpact(prop.kind, pos, speed);
    if (speed > 7.5) {
      npcs.notifyAcousticShock(pos, 'topple');
    }
  };
  physics.onPropWaterSplosh = (_prop, pos, speed) => {
    const scale = Math.max(0.75, Math.min(1.65, 0.72 + speed * 0.08));
    fx.spawnWaterSplash(pos, scale);
    audio.playWaterSplosh(pos, scale);
  };

  birdCam.setIntroWaitingPose(sparrow.position, sparrow.yaw);
  sparrow.setIntroLookTarget(birdCam.camera.position);

  sparrow.getAimRay = (outOrigin, outDir) => {
    birdCam.camera.getWorldPosition(outOrigin);
    birdCam.camera.getWorldDirection(outDir);
  };
  let isGunEquipped = false;
  sparrow.onGunToggleCallback = (equipped) => {
    isGunEquipped = equipped;
    journalHud.setGunEquipped(equipped);
    events.emit('gun:toggled', { equipped });
  };
  sparrow.onGunFiredCallback = (pos, dir) => {
    journalHud.triggerCrosshairRecoil();
    crowdManager.onPlayerShot(pos, sparrow.position, sparrow.activePerchId);
    events.emit('gun:fired', { pos, dir });
  };

  sparrow.onChirpCallback = (chirpPos) => {
    npcs.handlePlayerChirp(chirpPos);
    events.emit('bird:chirp', { pos: chirpPos, totalChirps: sparrow.chirpCount });
  };
  sparrow.onPropPickedUpCallback = (prop) => {
    events.emit('prop:pickedUp', { prop });
  };
  sparrow.onPropDroppedCallback = (prop) => {
    npcs.notifyPropDropped(prop);
    events.emit('prop:dropped', { prop });
  };

  const director = new VignetteDirector(
    scene,
    sunLight,
    hemiLight,
    physics,
    sparrow,
    npcs,
    audio,
    fx,
    birdCam,
    worldHandles,
    tutorialOverlay,
    journalHud,
    events,
    environment
  );

  // WebGPU post-processing pipeline (GTAO + ink contours + highlight roll-off + gouache grade)
  await loadingScreen.advance(95);
  let renderPipeline: THREE.RenderPipeline | null = null;
  let compilePassesAsync: (() => Promise<void>) | null = null;
  if (!isSoftwareGl) {
    try {
      const built = createStorybookRenderPipeline(renderer, scene, birdCam.camera, { isMobile });
      renderPipeline = built.renderPipeline;
      compilePassesAsync = built.compilePassesAsync;
    } catch {
      renderPipeline = null;
    }
  }
  renderer.toneMapping = renderPipeline ? THREE.NoToneMapping : THREE.NeutralToneMapping;

  const renderSceneSafe = (): void => {
    if (renderPipeline) {
      try {
        renderPipeline.render();
        return;
      } catch (err) {
        console.error('Storybook RenderPipeline error; falling back to direct renderer:', err);
        renderPipeline = null;
        renderer.toneMapping = THREE.NeutralToneMapping;
      }
    }
    try {
      renderer.render(scene, birdCam.camera);
    } catch (err) {
      console.error('Direct render error:', err);
    }
  };

  // Pre-warm all WebGPU pipelines (all 4 city quadrants, water shimmer, foliage sway, NPCs, pooled FX,
  // prePass MRT, 4x MSAA scenePass, 3 CSM shadow cascades, GTAO & composite) + audio preload before showing START
  await loadingScreen.advance(97);
  if (!isSoftwareGl) {
    const savedStates: Array<{ obj: THREE.Object3D; visible: boolean; frustumCulled: boolean }> = [];
    scene.traverse((obj) => {
      savedStates.push({ obj, visible: obj.visible, frustumCulled: obj.frustumCulled });
      obj.visible = true;
      obj.frustumCulled = false;
    });
    scene.updateMatrixWorld(true);

    try {
      if (compilePassesAsync) {
        await compilePassesAsync();
      } else {
        await renderer.compileAsync(scene, birdCam.camera);
      }
      renderSceneSafe();
    } catch (err) {
      console.error('Shader pre-warm fallback:', err);
    } finally {
      for (let i = 0; i < savedStates.length; i++) {
        const s = savedStates[i];
        s.obj.visible = s.visible;
        s.obj.frustumCulled = s.frustumCulled;
      }
    }
  }

  await audioPreloadPromise;

  // Render clean waiting portrait frame before revealing START
  renderSceneSafe();

  const appAbort = new AbortController();
  let disposed = false;
  let softwareTimerId: number | null = null;

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    appAbort.abort();
    if (softwareTimerId !== null) {
      window.clearTimeout(softwareTimerId);
      softwareTimerId = null;
    }
    renderer.setAnimationLoop(null);

    events.emit('session:disposed');
    events.clear();

    director.dispose();
    sparrow.dispose();
    birdCam.dispose();
    aerialManager.dispose();
    crowdManager.dispose();
    npcs.dispose();
    cityBuilder.dispose();
    fx.dispose();
    physics.dispose();
    perches.clear();
    audio.dispose();
    tutorialOverlay.dispose();
    journalHud.dispose();
    combatHud.dispose();
    mobileControls.dispose();
    renderer.dispose();
  };

  // Local-only telemetry handle for deterministic verification
  const allowLocalTelemetry =
    import.meta.env.DEV ||
    ((window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost') &&
      new URLSearchParams(window.location.search).get('telemetry') === '1');
  if (allowLocalTelemetry) {
    (window as unknown as Record<string, unknown>).__SPARROW_DEBUG__ = {
      sparrow,
      birdCam,
      worldHandles,
      director,
      tutorialOverlay,
      journalHud,
      combatHud,
      mobileControls,
      loadingScreen,
      physics,
      perches,
      npcs,
      crowdManager,
      aerialManager,
      fx,
      audio,
      events,
      environment,
      csmNode,
      scene,
      renderer,
      renderPipeline,
      dispose,
    };
  }

  window.addEventListener(
    'resize',
    () => {
      if (disposed) return;
      const w = Math.max(1, window.innerWidth);
      const h = Math.max(1, window.innerHeight);
      birdCam.camera.aspect = w / h;
      birdCam.camera.updateProjectionMatrix();
      safeUpdateCsmFrustums();
      renderer.setPixelRatio(computeCappedDpr(w, h, isMobile, renderQualityScale));
      renderer.setSize(w, h);
      syncDrawingBufferResolution();
    },
    { signal: appAbort.signal }
  );

  window.addEventListener(
    'keydown',
    (e) => {
      if (disposed || !sparrow.inputEnabled || !isGunEquipped) return;
      if (e.code === 'KeyE' && !e.repeat) {
        crowdManager.tryIntimidate(sparrow.position, birdCam.camera);
      }
    },
    { signal: appAbort.signal }
  );

  let lastTime = performance.now();
  let elapsed = 0;
  let frameTimeEmaMs = 16.67;
  let scaleCooldownSec = 2.0;
  const fwdTmp = new THREE.Vector3();
  const camFwdTmp = new THREE.Vector3();
  const camUpTmp = new THREE.Vector3();

  void loadingScreen.waitForStart().then(() => {
    if (disposed) return;
    wakeAudio();
    combatHud.setVisible(true);
    aerialManager.setActive(true);
    sparrow.clearQueuedInputs();
    birdCam.beginIntroSequence(
      () => {
        if (!disposed) sparrow.triggerIntroChirp();
      },
      () => {
        if (disposed) return;
        sparrow.setIntroLookTarget(null);
        sparrow.clearQueuedInputs();
        sparrow.inputEnabled = true;
      }
    );
  });

  const stepFrame = () => {
    if (disposed) return;
    const now = performance.now();
    const rawMs = now - lastTime;
    lastTime = now;
    if (!Number.isFinite(rawMs) || rawMs <= 0) return;

    const dt = Math.min(0.05, Math.max(0.001, rawMs * 0.001));
    elapsed += dt;

    // Adaptive 60 FPS resolution scaler (uses pixelRatio only — never touches WebGPU shader-recompiling AO samples)
    if (!isSoftwareGl && rawMs > 0.5 && rawMs < 110) {
      frameTimeEmaMs = frameTimeEmaMs * 0.92 + rawMs * 0.08;
      scaleCooldownSec -= dt;
      if (scaleCooldownSec <= 0) {
        let nextScale = renderQualityScale;
        if (frameTimeEmaMs > 19.0 && renderQualityScale > 0.72) {
          nextScale = Math.max(0.72, Math.round((renderQualityScale - 0.07) * 100) / 100);
        } else if (frameTimeEmaMs < 14.8 && renderQualityScale < 1.0) {
          nextScale = Math.min(1.0, Math.round((renderQualityScale + 0.07) * 100) / 100);
        }
        if (nextScale !== renderQualityScale) {
          const isDownscaling = nextScale < renderQualityScale;
          renderQualityScale = nextScale;
          renderer.setPixelRatio(
            computeCappedDpr(
              Math.max(1, window.innerWidth),
              Math.max(1, window.innerHeight),
              isMobile,
              renderQualityScale
            )
          );
          syncDrawingBufferResolution();
          scaleCooldownSec = isDownscaling ? 1.4 : 2.4;
        }
      }
    }

    try {
      // 1. Physics, Dynamic Day/Night & Weather Atmosphere, and Animated World Props
      const envState = environment.update(dt);
      physics.update(dt, (ripplePos, scale) => {
        fx.spawnWaterRipple(ripplePos, scale);
        audio.playWaterPlop(ripplePos);
      });
      worldHandles.updateAnimatedProps(dt, elapsed);

      // Indoor flag (camera + audio only). Lights stay constant across indoor/outdoor transitions:
      // changing light.visible invalidates the WebGPU LightsNode and recompiles all lit shaders.
      const isIndoors = worldHandles.isInsideAttic(sparrow.position);

      // 2. Bird Controller & Over-the-Shoulder Camera
      if (birdCam.isIntroActive()) {
        sparrow.setIntroLookTarget(birdCam.camera.position);
      }
      sparrow.update(dt, elapsed, birdCam.yaw);
      sparrow.getForwardVector(fwdTmp);
      const stickState = sparrow.getMobileStick();
      const isMoving =
        (stickState?.active === true && stickState.magnitude > 0.16) ||
        Math.hypot(sparrow.velocity.x, sparrow.velocity.z) > 0.45;
      birdCam.update({
        dt,
        birdPos: sparrow.position,
        birdForward: fwdTmp,
        birdYaw: sparrow.yaw,
        mode: sparrow.mode,
        airspeed: sparrow.getAirspeed(),
        verticalVel: sparrow.velocity.y,
        bankAngle: sparrow.getBankAngle(),
        physics,
        cageBounds: sparrow.cageBounds,
        windowBarrier: sparrow.windowBarrier,
        isIndoors,
        isMoving,
        moveStickX: stickState?.active ? stickState.x : 0,
        moveStickY: stickState?.active ? stickState.y : 0,
      });

      // Keep Sky Dome centered horizontally on camera (CSMShadowNode updates its 3 shadow cascades itself)
      skyDome.position.set(birdCam.camera.position.x, 0, birdCam.camera.position.z);

      // 3. NPCs, Companion Songbirds, Pigeon Flock, Deeds, Weather VFX & Spatial Soundscape
      npcs.setEnvironmentState({
        weather: envState.weather,
        rainIntensity: envState.rainIntensity,
        nightFactor: envState.nightFactor,
        windStrength: envState.windStrength,
      });
      npcs.update(
        dt,
        elapsed,
        sparrow.position,
        sparrow.velocity,
        sparrow.yaw,
        sparrow.activePerchId,
        sparrow.mode,
        sparrow.carriedProp?.kind ?? null,
        worldHandles.getTramX(),
        worldHandles.getCanalBoats()
      );
      crowdManager.update(
        dt,
        elapsed,
        sparrow.position,
        birdCam.camera,
        worldHandles.getTramX(),
        sparrow.activePerchId,
        isGunEquipped,
        sparrow.velocity
      );
      aerialManager.update(dt, elapsed, sparrow.position, isGunEquipped);
      perches.refreshDynamicGrid();
      director.update(dt);
      fx.setEnvironmentState({
        rainIntensity: envState.rainIntensity,
        nightFactor: envState.nightFactor,
        windStrength: envState.windStrength,
        birdPos: sparrow.position,
      });
      fx.update(dt, elapsed);

      const buskerDist = sparrow.position.distanceTo(worldHandles.buskerPos);
      const buskerProx = Math.max(0, 1 - buskerDist / 34);
      birdCam.camera.getWorldDirection(camFwdTmp);
      camUpTmp.copy(birdCam.camera.up).applyQuaternion(birdCam.camera.quaternion);

      audio.updateTelemetry({
        dt,
        isFlying: sparrow.mode === 'flying',
        isHopping: sparrow.mode !== 'flying' && sparrow.velocity.lengthSq() > 1.2,
        airspeed: sparrow.getAirspeed(),
        verticalVel: sparrow.velocity.y,
        altitude: sparrow.position.y,
        buskerProximity: buskerProx,
        buskerGroove: npcs.isBuskerGrooving(),
        bankAngle: sparrow.getBankAngle(),
        thermalLift: sparrow.mode === 'flying' ? physics.sampleUpdraftLift(sparrow.position) : 0,
        isIndoors,
        windowOpenRatio: Math.min(1, worldHandles.getWindowOpenAngle() / 1.34),
        tramX: worldHandles.getTramX(),
        rainIntensity: envState.rainIntensity,
        nightFactor: envState.nightFactor,
        windStrength: envState.windStrength,
        birdPos: sparrow.position,
        camPos: birdCam.camera.position,
        camFwd: camFwdTmp,
        camUp: camUpTmp,
      });
    } catch (err) {
      console.error('Frame step recovery:', err);
    }

    // 4. Render via WebGPU Storybook Pipeline (with automatic direct-render fallback)
    renderSceneSafe();
  };

  if (isSoftwareGl) {
    const gl = (renderer.backend as unknown as { gl?: WebGL2RenderingContext })?.gl;
    const afterDraw = (cb: () => void) => {
      if (disposed) return;
      if (!gl || typeof gl.fenceSync !== 'function') {
        softwareTimerId = window.setTimeout(cb, 80);
        return;
      }
      const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      gl.flush();
      const poll = () => {
        if (disposed) {
          if (sync) gl.deleteSync(sync);
          return;
        }
        const state = sync && gl.getSyncParameter(sync, gl.SYNC_STATUS);
        if (state === gl.UNSIGNALED) {
          softwareTimerId = window.setTimeout(poll, 5);
        } else {
          if (sync) gl.deleteSync(sync);
          softwareTimerId = window.setTimeout(cb, 80);
        }
      };
      softwareTimerId = window.setTimeout(poll, 5);
    };
    const tickSoftware = () => {
      if (disposed) return;
      stepFrame();
      afterDraw(tickSoftware);
    };
    afterDraw(tickSoftware);
  } else {
    renderer.setAnimationLoop(() => {
      if (!disposed) stepFrame();
    });
  }

  return { events, dispose };
}
