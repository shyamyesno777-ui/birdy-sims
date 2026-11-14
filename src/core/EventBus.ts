import type * as THREE from 'three/webgpu';
import type { SparrowDeedId } from '../ui/SparrowJournalHUD.ts';
import type { InteractiveProp, PropKind } from '../physics/PhysicsWorld.ts';

export type WeatherType = 'clear' | 'breezy' | 'rain' | 'mist';

export type TimePhase = 'dawn' | 'day' | 'sunset' | 'night';

export type RebellionMode = 'peaceful' | 'skirmish' | 'major';

export type GameEventMap = {
  'deed:completed': { id: SparrowDeedId; completedCount: number; totalCount: number };
  'district:awakened': { index: number; companionId: string };
  'tutorial:escaped': void;
  'coronation:started': void;
  'coronation:completed': void;
  'prop:shattered': { prop: InteractiveProp; kind: PropKind; pos: THREE.Vector3 };
  'prop:pickedUp': { prop: InteractiveProp };
  'prop:dropped': { prop: InteractiveProp };
  'bird:chirp': { pos: THREE.Vector3; totalChirps: number };
  'pigeons:scattered': void;
  'environment:timeChanged': { timeOfDay: number; phase: TimePhase; nightFactor: number };
  'environment:weatherChanged': { weather: WeatherType; previous: WeatherType };
  'gun:toggled': { equipped: boolean };
  'gun:fired': { pos: THREE.Vector3; dir: THREE.Vector3 };
  'crowd:kill': { kills: number; mode: RebellionMode; hostileChance: number };
  'bird:healthChanged': { hp: number; maxHp: number; delta: number; downed: boolean };
  'rebellion:changed': {
    mode: RebellionMode;
    prevMode: RebellionMode;
    kills: number;
    hostileChance: number;
  };
  'session:disposed': void;
};

type Listener<T> = (payload: T) => void;

/**
 * Lightweight strongly-typed event bus decoupling gameplay systems
 * (deeds, audio, VFX, HUD, achievements, and future progression/save hooks).
 */
export class EventBus<TEvents extends object> {
  private readonly listeners = new Map<keyof TEvents, Set<Listener<never>>>();

  public on<K extends keyof TEvents>(event: K, listener: Listener<TEvents[K]>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as Listener<never>);
    return () => this.off(event, listener);
  }

  public once<K extends keyof TEvents>(event: K, listener: Listener<TEvents[K]>): () => void {
    const wrapped: Listener<TEvents[K]> = (payload) => {
      this.off(event, wrapped);
      listener(payload);
    };
    return this.on(event, wrapped);
  }

  public off<K extends keyof TEvents>(event: K, listener: Listener<TEvents[K]>): void {
    const set = this.listeners.get(event);
    if (!set) return;
    set.delete(listener as Listener<never>);
    if (set.size === 0) {
      this.listeners.delete(event);
    }
  }

  public emit<K extends keyof TEvents>(
    event: K,
    ...args: TEvents[K] extends void ? [] : [payload: TEvents[K]]
  ): void {
    const set = this.listeners.get(event);
    if (!set || set.size === 0) return;
    const payload = args[0] as TEvents[K];
    for (const rawListener of set) {
      try {
        (rawListener as Listener<TEvents[K]>)(payload);
      } catch (err) {
        console.error(`[EventBus] Listener error on "${String(event)}":`, err);
      }
    }
  }

  public clear(): void {
    this.listeners.clear();
  }
}
