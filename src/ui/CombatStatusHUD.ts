import type { RebellionMode } from '../core/EventBus.ts';

/**
 * Clean storybook-styled HUD cluster displaying:
 * - Birdy Health (100 HP bar & tabular numeric readout)
 * - Kills counter
 * - Rebellion escalation state (10% Civilians Armed / MAJOR REBELLION 40% Hostile)
 * - Non-blocking hurt vignette flash & temporary recovery badge on 0 HP
 */
export class CombatStatusHUD {
  private readonly root: HTMLDivElement;
  private readonly hpValueEl: HTMLSpanElement;
  private readonly hpBarFillEl: HTMLDivElement;
  private readonly killsValueEl: HTMLSpanElement;
  private readonly rebellionBadgeEl: HTMLDivElement;
  private readonly hurtFlashEl: HTMLDivElement;
  private readonly downedBannerEl: HTMLDivElement;

  private hurtFlashTimer: number | null = null;
  private alertBannerTimer: number | null = null;
  private visible = false;
  private currentHp = 100;
  private currentMaxHp = 100;
  private currentKills = 0;
  private currentMode: RebellionMode = 'peaceful';

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'combat-hud is-hidden';
    this.root.setAttribute('aria-live', 'polite');
    this.root.setAttribute('aria-hidden', 'true');

    // Birdy Health Card
    const healthCard = document.createElement('div');
    healthCard.className = 'combat-card';

    const healthHeader = document.createElement('div');
    healthHeader.className = 'combat-row';

    const healthLabel = document.createElement('span');
    healthLabel.className = 'combat-label';
    healthLabel.textContent = 'Birdy Health';

    this.hpValueEl = document.createElement('span');
    this.hpValueEl.className = 'combat-value';
    this.hpValueEl.textContent = '100 HP';

    healthHeader.appendChild(healthLabel);
    healthHeader.appendChild(this.hpValueEl);

    const hpTrack = document.createElement('div');
    hpTrack.className = 'combat-hp-track';

    this.hpBarFillEl = document.createElement('div');
    this.hpBarFillEl.className = 'combat-hp-fill';
    hpTrack.appendChild(this.hpBarFillEl);

    healthCard.appendChild(healthHeader);
    healthCard.appendChild(hpTrack);

    // Kills + Rebellion Status Row
    const statsRow = document.createElement('div');
    statsRow.className = 'combat-stats-row';

    const killsChip = document.createElement('div');
    killsChip.className = 'combat-kills-chip';

    const killsLabel = document.createElement('span');
    killsLabel.className = 'combat-label';
    killsLabel.textContent = 'Kills';

    this.killsValueEl = document.createElement('span');
    this.killsValueEl.className = 'combat-kills-num';
    this.killsValueEl.textContent = '0';

    killsChip.appendChild(killsLabel);
    killsChip.appendChild(this.killsValueEl);

    this.rebellionBadgeEl = document.createElement('div');
    this.rebellionBadgeEl.className = 'combat-rebellion-badge is-peaceful';
    this.rebellionBadgeEl.textContent = 'Peaceful';

    statsRow.appendChild(killsChip);
    statsRow.appendChild(this.rebellionBadgeEl);

    this.root.appendChild(healthCard);
    this.root.appendChild(statsRow);
    parent.appendChild(this.root);

    // Subtle edge hurt flash (pointer-events: none)
    this.hurtFlashEl = document.createElement('div');
    this.hurtFlashEl.className = 'bird-hurt-flash';
    this.hurtFlashEl.setAttribute('aria-hidden', 'true');
    parent.appendChild(this.hurtFlashEl);

    // Non-blocking recovery banner shown briefly when Birdy Health hits 0
    this.downedBannerEl = document.createElement('div');
    this.downedBannerEl.className = 'bird-recover-banner is-hidden';
    this.downedBannerEl.setAttribute('aria-hidden', 'true');
    this.downedBannerEl.textContent = 'FEATHER DOWN — Recovering...';
    parent.appendChild(this.downedBannerEl);
  }

  public setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    this.root.classList.toggle('is-hidden', !visible);
    this.root.setAttribute('aria-hidden', visible ? 'false' : 'true');
  }

  public setHealth(hp: number, maxHp: number, tookDamage: boolean, downed: boolean): void {
    this.currentHp = Math.max(0, Math.round(hp));
    this.currentMaxHp = Math.max(1, Math.round(maxHp));

    const pct = Math.max(0, Math.min(100, (this.currentHp / this.currentMaxHp) * 100));
    this.hpValueEl.textContent = `${this.currentHp} HP`;
    this.hpBarFillEl.style.width = `${pct}%`;

    this.hpBarFillEl.classList.toggle('is-warn', pct <= 50 && pct > 25);
    this.hpBarFillEl.classList.toggle('is-danger', pct <= 25);

    if (downed) {
      if (this.alertBannerTimer !== null) {
        window.clearTimeout(this.alertBannerTimer);
        this.alertBannerTimer = null;
      }
      this.downedBannerEl.classList.remove('is-skirmish-alert');
      this.downedBannerEl.textContent = 'FEATHER DOWN — Recovering...';
    }
    this.downedBannerEl.classList.toggle('is-hidden', !downed);
    this.downedBannerEl.setAttribute('aria-hidden', downed ? 'false' : 'true');

    if (tookDamage) {
      this.hurtFlashEl.classList.remove('is-active');
      void this.hurtFlashEl.offsetWidth;
      this.hurtFlashEl.classList.add('is-active');
      if (this.hurtFlashTimer !== null) {
        window.clearTimeout(this.hurtFlashTimer);
      }
      this.hurtFlashTimer = window.setTimeout(() => {
        this.hurtFlashEl.classList.remove('is-active');
        this.hurtFlashTimer = null;
      }, 260);
    }
  }

  public setKillsAndMode(kills: number, mode: RebellionMode): void {
    this.currentKills = kills;
    this.currentMode = mode;

    this.killsValueEl.textContent = String(this.currentKills);

    this.rebellionBadgeEl.classList.remove('is-peaceful', 'is-skirmish', 'is-major');
    if (this.currentMode === 'major') {
      this.rebellionBadgeEl.classList.add('is-major');
      this.rebellionBadgeEl.textContent = 'MAJOR REBELLION · 40%';
    } else if (this.currentMode === 'skirmish') {
      this.rebellionBadgeEl.classList.add('is-skirmish');
      this.rebellionBadgeEl.textContent = 'REBELLION · 10% ARMED';
    } else {
      this.rebellionBadgeEl.classList.add('is-peaceful');
      this.rebellionBadgeEl.textContent = 'Peaceful';
    }
  }

  public showEscalationAlert(mode: RebellionMode): void {
    if (mode === 'peaceful' || this.currentHp <= 0) return;
    if (this.alertBannerTimer !== null) {
      window.clearTimeout(this.alertBannerTimer);
      this.alertBannerTimer = null;
    }
    const isMajor = mode === 'major';
    this.downedBannerEl.textContent = isMajor
      ? 'MAJOR REBELLION — 40% FIGHT BACK!'
      : 'REBELLION ALERT — 10% ARMED!';
    this.downedBannerEl.classList.toggle('is-skirmish-alert', !isMajor);
    this.downedBannerEl.classList.remove('is-hidden');
    this.downedBannerEl.setAttribute('aria-hidden', 'false');
    this.alertBannerTimer = window.setTimeout(() => {
      this.alertBannerTimer = null;
      if (this.currentHp > 0) {
        this.downedBannerEl.classList.add('is-hidden');
        this.downedBannerEl.classList.remove('is-skirmish-alert');
        this.downedBannerEl.setAttribute('aria-hidden', 'true');
        this.downedBannerEl.textContent = 'FEATHER DOWN — Recovering...';
      }
    }, 2600);
  }

  public dispose(): void {
    if (this.hurtFlashTimer !== null) {
      window.clearTimeout(this.hurtFlashTimer);
      this.hurtFlashTimer = null;
    }
    if (this.alertBannerTimer !== null) {
      window.clearTimeout(this.alertBannerTimer);
      this.alertBannerTimer = null;
    }
    this.root.remove();
    this.hurtFlashEl.remove();
    this.downedBannerEl.remove();
  }
}
