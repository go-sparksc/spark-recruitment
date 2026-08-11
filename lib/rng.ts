// Deterministic PRNG. The seed must produce byte-identical data on every run so
// that a diff during Phase 1 debugging means something changed, not that the
// dice rolled differently. mulberry32 is small, fast, and good enough for
// generating fake essays.
export function createRng(seed: number) {
  let state = seed >>> 0;

  function next(): number {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  function int(minInclusive: number, maxInclusive: number): number {
    return minInclusive + Math.floor(next() * (maxInclusive - minInclusive + 1));
  }

  function chance(probability: number): boolean {
    return next() < probability;
  }

  function pick<T>(items: readonly T[]): T {
    return items[Math.floor(next() * items.length)];
  }

  function shuffle<T>(items: readonly T[]): T[] {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = Math.floor(next() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }

  /// Pick from a weighted list. Weights need not sum to 1.
  function weighted<T>(entries: readonly (readonly [T, number])[]): T {
    const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
    let roll = next() * total;
    for (const [value, weight] of entries) {
      roll -= weight;
      if (roll <= 0) return value;
    }
    return entries[entries.length - 1][0];
  }

  return { next, int, chance, pick, shuffle, weighted };
}

export type Rng = ReturnType<typeof createRng>;
