import { RawCommit } from './types';

/** Where a chain starts walking. Seeds are processed in order; earlier seeds claim shared history. */
export interface Seed {
  key: string;
  hash: string;
  /**
   * Chain to extend instead of starting a new one, used for a local branch that is strictly ahead of its
   * upstream: its own commits sit directly on top of the upstream's chain, so they share its lane.
   */
  joinKey?: string;
}

export interface Chain {
  key: string;
  /** Rows (indexes into the commit list), ascending. */
  rows: number[];
}

/**
 * Splits history into chains: each chain is a run of commits linked by first parents, which is what a
 * branch "is" visually. Every commit belongs to exactly one chain; commits no seed reaches (history of
 * merged and deleted branches) get anonymous chains.
 */
export function assignChains(commits: RawCommit[], seeds: Seed[]): { chainOf: string[]; chains: Map<string, Chain> } {
  const rowOf = new Map<string, number>();
  commits.forEach((c, i) => rowOf.set(c.hash, i));
  const chainOf: string[] = new Array(commits.length);
  const chains = new Map<string, Chain>();

  const walk = (start: number): { rows: number[]; stop?: number } => {
    const rows: number[] = [];
    let r: number | undefined = start;
    while (r !== undefined && chainOf[r] === undefined) {
      rows.push(r);
      const next: string | undefined = commits[r].parents[0];
      r = next === undefined ? undefined : rowOf.get(next);
    }
    return { rows, stop: r };
  };

  const claim = (key: string, rows: number[]) => {
    let chain = chains.get(key);
    if (!chain) {
      chain = { key, rows: [] };
      chains.set(key, chain);
    }
    for (const r of rows) chainOf[r] = key;
    chain.rows = chain.rows.concat(rows).sort((a, b) => a - b);
  };

  for (const seed of seeds) {
    const start = rowOf.get(seed.hash);
    if (start === undefined || chainOf[start] !== undefined) continue;
    const { rows, stop } = walk(start);
    let key = seed.key;
    if (seed.joinKey && stop !== undefined && chainOf[stop] === seed.joinKey && chains.get(seed.joinKey)!.rows[0] === stop) {
      key = seed.joinKey;
    } else if (chains.has(key)) {
      let n = 2;
      while (chains.has(`${key}#${n}`)) n++;
      key = `${key}#${n}`;
    }
    claim(key, rows);
  }

  for (let r = 0; r < commits.length; r++) {
    if (chainOf[r] !== undefined) continue;
    claim(`anon:${commits[r].hash}`, walk(r).rows);
  }
  return { chainOf, chains };
}
