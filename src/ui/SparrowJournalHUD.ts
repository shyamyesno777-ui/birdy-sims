import type { TimePhase, WeatherType } from '../core/EventBus.ts';

export type SparrowDeedId =
  | 'croissant_heist'
  | 'coffee_bowling'
  | 'sleepy_sugar'
  | 'pigeon_scatter'
  | 'picnic_raid'
  | 'busker_coins'
  | 'canal_prank'
  | 'painter_muse'
  | 'apple_avalanche'
  | 'music_box'
  | 'belfry_bell'
  | 'sky_sanctuary';

export interface SparrowDeedDef {
  id: SparrowDeedId;
  label: string;
}

export const SPARROW_DEEDS: readonly SparrowDeedDef[] = [
  {
    id: 'croissant_heist',
    label: 'Snatch a warm croissant from the boulangerie',
  },
  {
    id: 'coffee_bowling',
    label: 'Bowl a giant to-go coffee cup off a bistro table',
  },
  {
    id: 'sleepy_sugar',
    label: "Drop a sugar cube into the drowsy commuter's mug",
  },
  {
    id: 'pigeon_scatter',
    label: 'Swoop or chirp to scatter the fountain pigeon flock',
  },
  {
    id: 'picnic_raid',
    label: 'Peck open the wicker picnic basket in the gazebo',
  },
  {
    id: 'busker_coins',
    label: "Toss 3 shiny coins into the busker's guitar case",
  },
  {
    id: 'canal_prank',
    label: 'Ring a vintage bicycle bell or topple a gelato cone',
  },
  {
    id: 'painter_muse',
    label: 'Bring glasses & 2 blossoms to the balcony painter',
  },
  {
    id: 'apple_avalanche',
    label: "Topple the fruit vendor's stacked apple pyramid",
  },
  {
    id: 'music_box',
    label: 'Wind the bookshop music box with the brass key',
  },
  {
    id: 'belfry_bell',
    label: 'Peck the great bronze bell atop the clocktower',
  },
  {
    id: 'sky_sanctuary',
    label: 'Weave 4 treasures into the Clocktower Sky Nest',
  },
];

interface CachedDeedRow {
  li: HTMLLIElement;
  check: HTMLSpanElement;
}

/**
 * Compact French-postcard Mischief & Deeds HUD.
 * Hidden during the indoor tutorial so onboarding shows only key prompts.
 * Built with safe DOM APIs (createElement, textContent; no innerHTML).
 * Toggled with the `J` key or an accessible `<button>` (`Tab` stays free for focus navigation).
 */
export class SparrowJournalHUD {
  private readonly root: HTMLDivElement;
  private readonly pillBtn: HTMLButtonElement;
  private readonly timeBtn: HTMLButtonElement;
  private readonly timeTextEl: HTMLSpanElement;
  private readonly timeKeyEl: HTMLElement;
  private readonly weatherBtn: HTMLButtonElement;
  private readonly weatherTextEl: HTMLSpanElement;
  private readonly weatherKeyEl: HTMLElement;
  private readonly seedCountEl: HTMLSpanElement;
  private readonly deedCountEl: HTMLSpanElement;
  private readonly keyCapEl: HTMLElement;
  private readonly cardEl: HTMLDivElement;
  private readonly toastHost: HTMLDivElement;

  private readonly rowElements = new Map<SparrowDeedId, CachedDeedRow>();
  private readonly completed = new Set<SparrowDeedId>();
  private readonly activeTimers = new Set<number>();
  private readonly abortCtrl = new AbortController();
  private expanded = false;
  private visible = false;
  private mobileMode = false;
  private currentPhase: TimePhase = 'dawn';
  private currentWeather: WeatherType = 'clear';
  public onToggleMute?: () => boolean;
  public onCycleTime?: () => void;
  public onCycleWeather?: () => void;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'journal-hud is-hidden';
    this.root.setAttribute('aria-hidden', 'true');

    const topBar = document.createElement('div');
    topBar.className = 'journal-top-bar';

    // Top-left compact interactive button pill
    this.pillBtn = document.createElement('button');
    this.pillBtn.type = 'button';
    this.pillBtn.className = 'journal-pill';
    this.pillBtn.setAttribute('aria-expanded', 'false');
    this.pillBtn.setAttribute('aria-label', 'Toggle Deeds List (Key J)');

    const seedWrap = document.createElement('span');
    seedWrap.className = 'journal-stat';
    const seedDot = document.createElement('span');
    seedDot.className = 'journal-seed-dot';
    seedDot.setAttribute('aria-hidden', 'true');
    this.seedCountEl = document.createElement('span');
    this.seedCountEl.textContent = '0';
    seedWrap.appendChild(seedDot);
    seedWrap.appendChild(this.seedCountEl);

    const divider = document.createElement('span');
    divider.className = 'journal-sep';
    divider.setAttribute('aria-hidden', 'true');
    divider.textContent = '·';

    this.deedCountEl = document.createElement('span');
    this.deedCountEl.className = 'journal-stat';
    this.deedCountEl.textContent = `0 / ${SPARROW_DEEDS.length}`;

    this.keyCapEl = document.createElement('kbd');
    this.keyCapEl.className = 'journal-tab-key';
    this.keyCapEl.textContent = 'J';

    this.pillBtn.appendChild(seedWrap);
    this.pillBtn.appendChild(divider);
    this.pillBtn.appendChild(this.deedCountEl);
    this.pillBtn.appendChild(this.keyCapEl);

    let lastPillTouchToggleMs = 0;
    this.pillBtn.addEventListener(
      'touchend',
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        lastPillTouchToggleMs = performance.now();
        this.setExpanded(!this.expanded);
      },
      { passive: false }
    );
    this.pillBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (performance.now() - lastPillTouchToggleMs < 450) return;
      this.setExpanded(!this.expanded);
    });

    topBar.appendChild(this.pillBtn);

    // Compact Time-of-Day cycle pill (Dawn -> Day -> Sunset -> Night)
    this.timeBtn = document.createElement('button');
    this.timeBtn.type = 'button';
    this.timeBtn.className = 'journal-pill journal-env-pill';
    this.timeBtn.setAttribute('aria-label', 'Advance Time of Day (Key T)');
    this.timeTextEl = document.createElement('span');
    this.timeTextEl.textContent = 'Dawn';
    this.timeKeyEl = document.createElement('kbd');
    this.timeKeyEl.className = 'journal-tab-key';
    this.timeKeyEl.textContent = 'T';
    this.timeBtn.appendChild(this.timeTextEl);
    this.timeBtn.appendChild(this.timeKeyEl);

    let lastTimeTouchMs = 0;
    this.timeBtn.addEventListener(
      'touchend',
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        lastTimeTouchMs = performance.now();
        this.onCycleTime?.();
      },
      { passive: false }
    );
    this.timeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (performance.now() - lastTimeTouchMs < 450) return;
      this.onCycleTime?.();
    });
    topBar.appendChild(this.timeBtn);

    // Compact Weather cycle pill (Clear -> Breezy -> Rain -> Mist)
    this.weatherBtn = document.createElement('button');
    this.weatherBtn.type = 'button';
    this.weatherBtn.className = 'journal-pill journal-env-pill';
    this.weatherBtn.setAttribute('aria-label', 'Cycle Weather (Key G)');
    this.weatherTextEl = document.createElement('span');
    this.weatherTextEl.textContent = 'Clear';
    this.weatherKeyEl = document.createElement('kbd');
    this.weatherKeyEl.className = 'journal-tab-key';
    this.weatherKeyEl.textContent = 'G';
    this.weatherBtn.appendChild(this.weatherTextEl);
    this.weatherBtn.appendChild(this.weatherKeyEl);

    let lastWeatherTouchMs = 0;
    this.weatherBtn.addEventListener(
      'touchend',
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        lastWeatherTouchMs = performance.now();
        this.onCycleWeather?.();
      },
      { passive: false }
    );
    this.weatherBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (performance.now() - lastWeatherTouchMs < 450) return;
      this.onCycleWeather?.();
    });
    topBar.appendChild(this.weatherBtn);

    // Expandable Postcard Checklist (one row per deed)
    this.cardEl = document.createElement('div');
    this.cardEl.className = 'journal-card';
    this.cardEl.setAttribute('aria-hidden', 'true');
    this.cardEl.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });
    this.cardEl.addEventListener('click', (e) => e.stopPropagation());

    const list = document.createElement('ul');
    list.className = 'journal-list';

    for (const deed of SPARROW_DEEDS) {
      const li = document.createElement('li');
      li.className = 'journal-item';

      const check = document.createElement('span');
      check.className = 'journal-check';
      check.setAttribute('aria-hidden', 'true');
      check.textContent = '';

      const text = document.createElement('span');
      text.className = 'journal-label';
      text.textContent = deed.label;

      li.appendChild(check);
      li.appendChild(text);
      list.appendChild(li);
      this.rowElements.set(deed.id, { li, check });
    }

    this.cardEl.appendChild(list);
    this.root.appendChild(topBar);
    this.root.appendChild(this.cardEl);
    parent.appendChild(this.root);

    // Celebratory completion toast container (top-right, screen-reader polite live region)
    this.toastHost = document.createElement('div');
    this.toastHost.className = 'journal-toast-host';
    this.toastHost.setAttribute('role', 'status');
    this.toastHost.setAttribute('aria-live', 'polite');
    parent.appendChild(this.toastHost);

    const signal = this.abortCtrl.signal;
    window.addEventListener(
      'pointerdown',
      (e) => {
        if (!this.expanded) return;
        if (e.target instanceof Element && e.target.closest('.journal-hud')) return;
        this.setExpanded(false);
      },
      { signal }
    );

    window.addEventListener(
      'keydown',
      (e) => {
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        if (e.code === 'KeyJ' && this.visible) {
          e.preventDefault();
          this.setExpanded(!this.expanded);
        } else if (e.code === 'KeyT' && this.visible) {
          e.preventDefault();
          this.onCycleTime?.();
        } else if (e.code === 'KeyG' && this.visible) {
          e.preventDefault();
          this.onCycleWeather?.();
        } else if (e.code === 'KeyM') {
          e.preventDefault();
          this.onToggleMute?.();
        }
      },
      { signal }
    );
  }

  public setTimePhase(phase: TimePhase): void {
    if (this.currentPhase === phase) return;
    this.currentPhase = phase;
    const labels: Record<TimePhase, string> = {
      dawn: 'Dawn',
      day: 'Day',
      sunset: 'Sunset',
      night: 'Night',
    };
    this.timeTextEl.textContent = labels[phase];
    this.timeBtn.classList.toggle('is-night', phase === 'night');
  }

  public setWeather(weather: WeatherType): void {
    if (this.currentWeather === weather) return;
    this.currentWeather = weather;
    const labels: Record<WeatherType, string> = {
      clear: 'Clear',
      breezy: 'Breezy',
      rain: 'Rain',
      mist: 'Mist',
    };
    this.weatherTextEl.textContent = labels[weather];
  }

  public setMobileMode(isMobile: boolean): void {
    this.mobileMode = isMobile;
    this.root.classList.toggle('is-mobile', isMobile);
    const keyDisplay = isMobile ? 'none' : '';
    this.keyCapEl.style.display = keyDisplay;
    this.timeKeyEl.style.display = keyDisplay;
    this.weatherKeyEl.style.display = keyDisplay;
    this.pillBtn.setAttribute(
      'aria-label',
      isMobile ? 'Toggle Deeds List' : 'Toggle Deeds List (Key J)'
    );
    this.timeBtn.setAttribute(
      'aria-label',
      isMobile ? 'Advance Time of Day' : 'Advance Time of Day (Key T)'
    );
    this.weatherBtn.setAttribute(
      'aria-label',
      isMobile ? 'Cycle Weather' : 'Cycle Weather (Key G)'
    );
  }

  public isMobileMode(): boolean {
    return this.mobileMode;
  }

  public setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    this.root.classList.toggle('is-hidden', !visible);
    this.root.setAttribute('aria-hidden', visible ? 'false' : 'true');
    if (!visible && this.expanded) {
      this.setExpanded(false);
    }
  }

  public setExpanded(expanded: boolean): void {
    this.expanded = expanded;
    this.root.classList.toggle('is-expanded', expanded);
    this.pillBtn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    this.cardEl.setAttribute('aria-hidden', expanded ? 'false' : 'true');
  }

  public setSeedsCount(count: number): void {
    this.seedCountEl.textContent = String(count);
  }

  public getCompletedCount(): number {
    return this.completed.size;
  }

  public getTotalCount(): number {
    return SPARROW_DEEDS.length;
  }

  public isDeedCompleted(id: SparrowDeedId): boolean {
    return this.completed.has(id);
  }

  public completeDeed(id: SparrowDeedId): boolean {
    if (this.completed.has(id)) return false;
    this.completed.add(id);

    const row = this.rowElements.get(id);
    if (row) {
      row.li.classList.add('is-done');
      row.check.textContent = '✓';
    }

    this.deedCountEl.textContent = `${this.completed.size} / ${SPARROW_DEEDS.length}`;

    const def = SPARROW_DEEDS.find((d) => d.id === id);
    if (def && this.visible) {
      this.spawnStampToast(def);
    }
    return true;
  }

  public spawnCoronationToast(): void {
    if (!this.visible) return;
    const toast = document.createElement('div');
    toast.className = 'journal-toast is-royal';

    const stamp = document.createElement('span');
    stamp.className = 'journal-toast-stamp';
    stamp.setAttribute('aria-hidden', 'true');
    stamp.textContent = '♛';

    const title = document.createElement('span');
    title.className = 'journal-toast-label';
    title.textContent = 'Crown of the Neighborhood!';

    toast.appendChild(stamp);
    toast.appendChild(title);
    this.toastHost.appendChild(toast);

    const t1 = window.setTimeout(() => {
      this.activeTimers.delete(t1);
      toast.classList.add('is-leaving');
      const t2 = window.setTimeout(() => {
        this.activeTimers.delete(t2);
        toast.remove();
      }, 420);
      this.activeTimers.add(t2);
    }, 3800);
    this.activeTimers.add(t1);
  }

  private spawnStampToast(def: SparrowDeedDef): void {
    const toast = document.createElement('div');
    toast.className = 'journal-toast';

    const stamp = document.createElement('span');
    stamp.className = 'journal-toast-stamp';
    stamp.setAttribute('aria-hidden', 'true');
    stamp.textContent = '✓';

    const title = document.createElement('span');
    title.className = 'journal-toast-label';
    title.textContent = def.label;

    toast.appendChild(stamp);
    toast.appendChild(title);
    this.toastHost.appendChild(toast);

    const t1 = window.setTimeout(() => {
      this.activeTimers.delete(t1);
      toast.classList.add('is-leaving');
      const t2 = window.setTimeout(() => {
        this.activeTimers.delete(t2);
        toast.remove();
      }, 420);
      this.activeTimers.add(t2);
    }, 3100);
    this.activeTimers.add(t1);
  }

  public dispose(): void {
    this.abortCtrl.abort();
    for (const timerId of this.activeTimers) {
      window.clearTimeout(timerId);
    }
    this.activeTimers.clear();
    this.root.remove();
    this.toastHost.remove();
  }
}
