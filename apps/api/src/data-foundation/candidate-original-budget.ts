import { MAX_CANDIDATE_ORIGINAL_BYTES } from './postgres-candidate-original.js';

export interface CandidateOriginalBudgetLimits {
  readonly maxBytes: number;
  readonly maxActive: number;
  readonly maxPerResponsible: number;
}

export const DEFAULT_CANDIDATE_ORIGINAL_BUDGET_LIMITS = Object.freeze({
  maxBytes: 128 * 1024 * 1024,
  maxActive: 4,
  maxPerResponsible: 2,
} satisfies CandidateOriginalBudgetLimits);

export interface CandidateOriginalReservation {
  readonly tenantId: string;
  readonly projectId: string;
  readonly responsibleActorId: string;
  readonly sizeBytes: number;
}

/** One API instance's buffered-original budget; reservations live through delivery. */
export class CandidateOriginalBudget {
  readonly #limits: CandidateOriginalBudgetLimits;
  readonly #byResponsible = new Map<string, number>();
  #active = 0;
  #bytes = 0;

  constructor(
    limits: CandidateOriginalBudgetLimits = DEFAULT_CANDIDATE_ORIGINAL_BUDGET_LIMITS,
  ) {
    if (
      !Number.isSafeInteger(limits.maxBytes) ||
      limits.maxBytes < 1 ||
      !Number.isSafeInteger(limits.maxActive) ||
      limits.maxActive < 1 ||
      !Number.isSafeInteger(limits.maxPerResponsible) ||
      limits.maxPerResponsible < 1 ||
      limits.maxPerResponsible > limits.maxActive
    )
      throw new Error('Invalid candidate original budget limits.');
    this.#limits = limits;
  }

  tryReserve(input: CandidateOriginalReservation): (() => void) | null {
    if (
      !Number.isSafeInteger(input.sizeBytes) ||
      input.sizeBytes < 1 ||
      input.sizeBytes > MAX_CANDIDATE_ORIGINAL_BYTES ||
      !input.tenantId ||
      !input.projectId ||
      !input.responsibleActorId
    )
      throw new Error('Invalid candidate original reservation.');
    const key = `${input.tenantId}:${input.projectId}:${input.responsibleActorId}`;
    const current = this.#byResponsible.get(key) ?? 0;
    if (
      this.#active >= this.#limits.maxActive ||
      current >= this.#limits.maxPerResponsible ||
      input.sizeBytes > this.#limits.maxBytes - this.#bytes
    )
      return null;
    this.#active += 1;
    this.#bytes += input.sizeBytes;
    this.#byResponsible.set(key, current + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#active -= 1;
      this.#bytes -= input.sizeBytes;
      const remaining = (this.#byResponsible.get(key) ?? 1) - 1;
      if (remaining === 0) this.#byResponsible.delete(key);
      else this.#byResponsible.set(key, remaining);
    };
  }
}
