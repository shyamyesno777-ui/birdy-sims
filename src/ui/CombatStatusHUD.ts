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
  private readonly respectValueEl: HTMLSpanElement;
  private readonly rebellionBadgeEl: HTMLDivElement;
  private readonly intimidatePromptEl: HTMLDivElement;
  private readonly hurtFlashEl: HTMLDivElement;
  private readonly downedBannerEl: HTMLDivElement;
  private readonly gameOverOverlayEl: HTMLDivElement;
  private readonly gameOverStatsEl: HTMLDivElement;
  private readonly restartBtnEl: HTMLButtonElement;

  private hurtFlashTimer: number | null = null;
  private alertBannerTimer: number | null = null;
  private visible = false;
  private gameOverVisible = false;
  private currentHp = 100;
  private currentMaxHp = 100;
  private currentKills = 0;
  private currentRespect = 0;
  private currentMode: RebellionMode = 'peaceful';
  private isAdmired = false;
  private perchCooldownSec = 0;
  public onRestart?: () => void;

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

    const respectChip = document.createElement('div');
    respectChip.className = 'combat-kills-chip combat-respect-chip';

    const respectLabel = document.createElement('span');
    respectLabel.className = 'combat-label';
    respectLabel.textContent = 'Respect';

    this.respectValueEl = document.createElement('span');
    this.respectValueEl.className = 'combat-kills-num';
    this.respectValueEl.textContent = '0';

    respectChip.appendChild(respectLabel);
    respectChip.appendChild(this.respectValueEl);

    this.rebellionBadgeEl = document.createElement('div');
    this.rebellionBadgeEl.className = 'combat-rebellion-badge is-peaceful';
    this.rebellionBadgeEl.textContent = 'Peaceful';

    this.intimidatePromptEl = document.createElement('div');
    this.intimidatePromptEl.className = 'combat-intimidate-prompt is-hidden';
    this.intimidatePromptEl.textContent = '[E] Intimidate (+25 Respect XP)';

    statsRow.appendChild(killsChip);
    statsRow.appendChild(respectChip);
    statsRow.appendChild(this.rebellionBadgeEl);

    this.root.appendChild(healthCard);
    this.root.appendChild(statsRow);
    this.root.appendChild(this.intimidatePromptEl);
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

    // Game Over Overlay with Restart button when Birdy Health reaches 0 HP
    this.gameOverOverlayEl = document.createElement('div');
    this.gameOverOverlayEl.id = 'game-over-overlay';
    this.gameOverOverlayEl.className = 'game-over-overlay is-hidden';
    this.gameOverOverlayEl.setAttribute('aria-hidden', 'true');
    this.gameOverOverlayEl.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.gameOverOverlayEl.addEventListener('click', (e) => e.stopPropagation());

    const gameOverCard = document.createElement('div');
    gameOverCard.className = 'game-over-card';

    const gameOverBadge = document.createElement('div');
    gameOverBadge.className = 'game-over-badge';
    gameOverBadge.textContent = '0 HP · FEATHER DOWN';

    const gameOverTitle = document.createElement('h2');
    gameOverTitle.className = 'game-over-title';
    gameOverTitle.textContent = 'SPARROW RAMPAGE';

    const gameOverSub = document.createElement('p');
    gameOverSub.className = 'game-over-sub';
    gameOverSub.textContent = 'Birdy was knocked out of the sky!';

    this.gameOverStatsEl = document.createElement('div');
    this.gameOverStatsEl.className = 'game-over-stats';
    this.gameOverStatsEl.textContent = 'Kills: 0 · Respect: 0 XP';

    this.restartBtnEl = document.createElement('button');
    this.restartBtnEl.id = 'restart-game-btn';
    this.restartBtnEl.type = 'button';
    this.restartBtnEl.className = 'game-over-restart-btn';
    this.restartBtnEl.textContent = 'Restart';
    this.restartBtnEl.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.triggerRestart();
    });

    gameOverCard.appendChild(gameOverBadge);
    gameOverCard.appendChild(gameOverTitle);
    gameOverCard.appendChild(gameOverSub);
    gameOverCard.appendChild(this.gameOverStatsEl);
    gameOverCard.appendChild(this.restartBtnEl);
    this.gameOverOverlayEl.appendChild(gameOverCard);
    parent.appendChild(this.gameOverOverlayEl);
  }

  public triggerRestart(): void {
    this.gameOverVisible = false;
    this.gameOverOverlayEl.classList.add('is-hidden');
    this.gameOverOverlayEl.setAttribute('aria-hidden', 'true');
    this.downedBannerEl.classList.add('is-hidden');
    this.downedBannerEl.setAttribute('aria-hidden', 'true');
    this.onRestart?.();
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

    if (downed || this.currentHp <= 0) {
      if (this.alertBannerTimer !== null) {
        window.clearTimeout(this.alertBannerTimer);
        this.alertBannerTimer = null;
      }
      this.downedBannerEl.classList.remove('is-skirmish-alert');
      this.downedBannerEl.textContent = 'FEATHER DOWN — Recovering...';
      this.gameOverVisible = true;
      this.gameOverStatsEl.textContent = `Kills: ${this.currentKills} · Respect: ${this.currentRespect} XP`;
      this.gameOverOverlayEl.classList.remove('is-hidden');
      this.gameOverOverlayEl.setAttribute('aria-hidden', 'false');
      if (document.pointerLockElement) {
        document.exitPointerLock?.();
      }
      this.restartBtnEl.focus({ preventScroll: true });
    } else if (!this.gameOverVisible) {
      this.gameOverOverlayEl.classList.add('is-hidden');
      this.gameOverOverlayEl.setAttribute('aria-hidden', 'true');
    }
    this.downedBannerEl.classList.toggle('is-hidden', !downed && !this.gameOverVisible);
    this.downedBannerEl.setAttribute('aria-hidden', downed || this.gameOverVisible ? 'false' : 'true');

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
    this.refreshBadgeText();
  }

  public setAdmiredAndCooldown(admired: boolean, cooldownRemaining: number): void {
    this.isAdmired = admired;
    this.perchCooldownSec = Math.max(0, Math.ceil(cooldownRemaining));
    this.refreshBadgeText();
  }

  private refreshBadgeText(): void {
    this.rebellionBadgeEl.classList.remove(
      'is-peaceful',
      'is-admired',
      'is-skirmish',
      'is-major'
    );
    if (this.isAdmired) {
      this.rebellionBadgeEl.classList.add('is-admired');
      this.rebellionBadgeEl.textContent = 'Admired ♥ +2 HP/s';
      return;
    }
    const cdSuffix =
      this.perchCooldownSec > 0 ? ` · Shoo ${this.perchCooldownSec}s` : '';
    if (this.currentMode === 'major') {
      this.rebellionBadgeEl.classList.add('is-major');
      this.rebellionBadgeEl.textContent = `MAJOR REBELLION · 40%${cdSuffix}`;
    } else if (this.currentMode === 'skirmish') {
      this.rebellionBadgeEl.classList.add('is-skirmish');
      this.rebellionBadgeEl.textContent = `REBELLION · 10% ARMED${cdSuffix}`;
    } else if (this.perchCooldownSec > 0) {
      this.rebellionBadgeEl.classList.add('is-skirmish');
      this.rebellionBadgeEl.textContent = `Perch Cooldown · ${this.perchCooldownSec}s`;
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

  public showExtremeRageAlert(): void {
    if (this.currentHp <= 0) return;
    if (this.alertBannerTimer !== null) {
      window.clearTimeout(this.alertBannerTimer);
      this.alertBannerTimer = null;
    }
    this.downedBannerEl.textContent = 'EXTREME RAGE — TROPHY SHATTERED! LOCAL REBELLION!';
    this.downedBannerEl.classList.remove('is-skirmish-alert');
    this.downedBannerEl.classList.remove('is-hidden');
    this.downedBannerEl.setAttribute('aria-hidden', 'false');
    this.alertBannerTimer = window.setTimeout(() => {
      this.alertBannerTimer = null;
      if (this.currentHp > 0) {
        this.downedBannerEl.classList.add('is-hidden');
        this.downedBannerEl.setAttribute('aria-hidden', 'true');
        this.downedBannerEl.textContent = 'FEATHER DOWN — Recovering...';
      }
    }, 2800);
  }

  public setRespectXp(totalRespect: number, gained: number): void {
    this.currentRespect = Math.max(0, Math.round(totalRespect));
    this.respectValueEl.textContent = `${this.currentRespect}`;
    if (gained > 0 && this.currentHp > 0) {
      if (this.alertBannerTimer !== null) {
        window.clearTimeout(this.alertBannerTimer);
        this.alertBannerTimer = null;
      }
      this.downedBannerEl.textContent = `INTIMIDATED! +${Math.round(gained)} RESPECT XP`;
      this.downedBannerEl.classList.add('is-skirmish-alert');
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
      }, 1800);
    }
  }

  public setIntimidateAvailable(available: boolean): void {
    this.intimidatePromptEl.classList.toggle('is-hidden', !available);
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
    this.gameOverOverlayEl.remove();
  }
}
