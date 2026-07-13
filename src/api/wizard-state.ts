import { randomUUID } from 'crypto';

const WIZARD_TTL_MS = 30 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

export interface WizardState {
  wizardId: string;
  agentId: string;
  prompt: string;
  avatarData?: Buffer;
  avatarMime?: string;
  files: Record<string, string>;
  step: 'pending' | 'confirmed' | 'complete';
  channel?: 'telegram' | 'discord';
  botToken?: string;
  /** Emoji extracted from Claude's generated output */
  signatureEmoji?: string;
  createdAt: number;
  expiresAt: number;
}

export class WizardStore {
  private readonly store = new Map<string, WizardState>();

  constructor() {
    const timer = setInterval(() => this.evictExpired(), CLEANUP_INTERVAL_MS);
    timer.unref();
  }

  create(agentId: string, prompt: string, files: Record<string, string>): WizardState {
    const now = Date.now();
    const state: WizardState = {
      wizardId: randomUUID(),
      agentId,
      prompt,
      files,
      step: 'pending',
      createdAt: now,
      expiresAt: now + WIZARD_TTL_MS,
    };
    this.store.set(state.wizardId, state);
    return state;
  }

  get(wizardId: string): WizardState | undefined {
    const state = this.store.get(wizardId);
    if (!state) return undefined;
    if (Date.now() > state.expiresAt) {
      this.store.delete(wizardId);
      return undefined;
    }
    return state;
  }

  update(wizardId: string, patch: Partial<WizardState>): void {
    const state = this.store.get(wizardId);
    if (!state) return;
    // Refresh TTL whenever the wizard advances to a new step (avoid mutating caller's object)
    const fullPatch = (patch.step && patch.step !== state.step)
      ? { ...patch, expiresAt: Date.now() + WIZARD_TTL_MS }
      : patch;
    Object.assign(state, fullPatch);
  }

  delete(wizardId: string): void {
    this.store.delete(wizardId);
  }

  findByAgentId(agentId: string): WizardState | undefined {
    const now = Date.now();
    for (const state of this.store.values()) {
      if (state.agentId === agentId && now <= state.expiresAt) return state;
    }
    return undefined;
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [id, state] of this.store) {
      if (now > state.expiresAt) this.store.delete(id);
    }
  }
}

export const wizardStore = new WizardStore();
