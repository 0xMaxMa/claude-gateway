import { randomUUID } from 'crypto';
import { overlaps } from './paths';

/** A folder being removed is held until the delete completes. */
export interface Hold { id: string; dir: string }
const holds = new Map<string, Hold>();

/** The hold on this folder, one inside it, or one containing it. */
export function findHold(dir: string): Hold | undefined {
  return [...holds.values()].find((hold) => overlaps(hold.dir, dir));
}

/** Called after checking for overlap in the same synchronous step. */
export function addHold(dir: string): Hold {
  const hold = { id: randomUUID(), dir };
  holds.set(hold.id, hold);
  return hold;
}

export function releaseHold(id: string): void { holds.delete(id); }
