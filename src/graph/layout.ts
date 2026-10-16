import { GraphEdge } from './types';

export interface LayoutCommit {
  hash: string;
  parents: string[];
  chain: string;
  local: boolean;
}

export interface EdgeSpec {
  i: number;
  j: number;
  /** Chain at the child end. */
  upper: string;
  /** Chain at the parent end. */
  lower: string;
  /** Chain the edge belongs to (its lane colours the edge). */
  br: string;
  kind: 'line' | 'fork' | 'merge';
  local: boolean;
}

/** Weight of each problem in a layout's score. */
const W_CROSS = 10;
const W_WIDTH = 3;
const W_HOP = 2;
const W_MOVED = 1;

export function edgeSpecs(list: LayoutCommit[]): EdgeSpec[] {
  const row = new Map<string, number>();
  list.forEach((c, i) => row.set(c.hash, i));
  const out: EdgeSpec[] = [];
  list.forEach((c, i) => {
    c.parents.forEach((p, k) => {
      const j = row.get(p);
      if (j === undefined) {
        // Parent is past the loaded window: keep the chain's line running off the bottom.
        if (k === 0) out.push({ i, j: list.length, upper: c.chain, lower: c.chain, br: c.chain, kind: 'line', local: c.local });
        return;
      }
      const pc = list[j];
      if (pc.chain === c.chain) out.push({ i, j, upper: c.chain, lower: c.chain, br: c.chain, kind: 'line', local: c.local });
      else if (k === 0) out.push({ i, j, upper: c.chain, lower: pc.chain, br: c.chain, kind: 'fork', local: c.local });
      else out.push({ i, j, upper: c.chain, lower: pc.chain, br: pc.chain, kind: 'merge', local: pc.local });
    });
  });
  return out;
}

interface Interval {
  top: number;
  bottom: number;
}

/** Rows each chain's lane is busy: from its newest commit (or the merge it ends in) to the commit it branched off. */
function intervals(list: LayoutCommit[], specs: EdgeSpec[]): Map<string, Interval> {
  const info = new Map<string, Interval>();
  list.forEach((c, i) => {
    const b = info.get(c.chain);
    if (!b) info.set(c.chain, { top: i, bottom: i });
    else {
      b.top = Math.min(b.top, i);
      b.bottom = Math.max(b.bottom, i);
    }
  });
  for (const e of specs) {
    const b = info.get(e.br);
    if (!b) continue;
    if (e.kind === 'fork' || (e.kind === 'line' && e.j >= list.length)) b.bottom = Math.max(b.bottom, e.j);
    if (e.kind === 'merge') b.top = Math.min(b.top, e.i);
  }
  return info;
}

/**
 * For every chain, the chains it must sit to the right of: the chain it branches off, and the chains it merges
 * into. A rule that would contradict an earlier one (e.g. the default branch merged back into a feature) is
 * dropped; branch-offs are added first, so they win.
 */
function rightOfRules(specs: EdgeSpec[], keys: string[], mainKey: string): Map<string, Set<string>> {
  const right = new Map<string, Set<string>>(keys.map((k) => [k, new Set<string>()]));
  const reaches = (from: string, to: string): boolean => {
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length) {
      const k = stack.pop()!;
      if (k === to) return true;
      if (seen.has(k)) continue;
      seen.add(k);
      for (const p of right.get(k) ?? []) stack.push(p);
    }
    return false;
  };
  const add = (a: string, b: string) => {
    if (a === b || !right.has(a) || right.get(a)!.has(b)) return;
    if (b !== mainKey && reaches(b, a)) return;
    right.get(a)!.add(b);
  };
  for (const e of specs) if (e.kind === 'fork') add(e.upper, e.lower);
  for (const e of specs) if (e.kind === 'merge') add(e.lower, e.upper);
  return right;
}

interface Problems {
  cross: number;
  /** Extra lanes jumped by lane changes (a jump to the next lane counts 0). */
  hops: number;
  maxLane: number;
  moved: number;
  /** For each crossing: the chain whose curve crosses, and the chain it crosses. */
  pairs: [string, string][];
}

/** Lower is better. */
function score(specs: EdgeSpec[], lanes: Map<string, number>, prev?: Map<string, number>): number {
  const p = measure(specs, lanes, prev);
  return p.cross * W_CROSS + p.maxLane * W_WIDTH + p.hops * W_HOP + p.moved * W_MOVED;
}

/**
 * Every lane change is drawn as one curve one row tall, so a crossing is either a curve passing a lane whose line
 * runs through that row, or two curves in the same row whose ends are in opposite order.
 */
function measure(specs: EdgeSpec[], lanes: Map<string, number>, prev?: Map<string, number>): Problems {
  // busy[band]: lane -> chain whose line runs straight through that band (between row band and band + 1).
  const busy: Map<number, string>[] = [];
  const vertical = (lane: number, chain: string, from: number, to: number) => {
    for (let b = from; b < to; b++) (busy[b] ??= new Map()).set(lane, chain);
  };
  type Curve = { band: number; top: number; bottom: number; chain: string };
  const curves: Curve[] = [];
  for (const e of specs) {
    const la = lanes.get(e.upper)!;
    const lb = lanes.get(e.lower)!;
    if (la === lb) vertical(la, e.br, e.i, e.j);
    else if (e.kind === 'fork') {
      vertical(la, e.upper, e.i, e.j - 1);
      curves.push({ band: e.j - 1, top: la, bottom: lb, chain: e.br });
    } else {
      curves.push({ band: e.i, top: la, bottom: lb, chain: e.br });
      vertical(lb, e.lower, e.i + 1, e.j);
    }
  }
  let cross = 0;
  let hops = 0;
  const pairs: [string, string][] = [];
  const byBand = new Map<number, Curve[]>();
  for (const c of curves) {
    hops += Math.abs(c.top - c.bottom) - 1;
    const lo = Math.min(c.top, c.bottom);
    const hi = Math.max(c.top, c.bottom);
    for (const [l, chain] of busy[c.band] ?? []) {
      if (l > lo && l < hi) {
        cross++;
        pairs.push([c.chain, chain]);
      }
    }
    const same = byBand.get(c.band);
    if (same) {
      for (const o of same) {
        if ((c.top - o.top) * (c.bottom - o.bottom) < 0) {
          cross++;
          pairs.push(Math.max(c.top, c.bottom) > Math.max(o.top, o.bottom) ? [c.chain, o.chain] : [o.chain, c.chain]);
        }
      }
      same.push(c);
    } else byBand.set(c.band, [c]);
  }
  let maxLane = 0;
  let moved = 0;
  for (const [k, l] of lanes) {
    maxLane = Math.max(maxLane, l);
    const p = prev?.get(k);
    if (p !== undefined && p !== l) moved++;
  }
  return { cross, hops, maxLane, moved, pairs };
}

function permutations<T>(a: T[]): T[][] {
  if (a.length <= 1) return [a.slice()];
  const out: T[][] = [];
  a.forEach((x, k) => {
    for (const p of permutations(a.slice(0, k).concat(a.slice(k + 1)))) out.push([x, ...p]);
  });
  return out;
}

const factorial = (n: number): number => (n <= 1 ? 1 : n * factorial(n - 1));

export interface LaneOptions {
  /** Chain pinned to lane 0 (the default branch). */
  mainKey: string;
  /** Remote chains are placed before local-only chains, so a local branch never pushes a remote outward. */
  isRemote: (key: string) => boolean;
  /** Lanes from the previous layout; a tie-breaker so branches stay put across refreshes. */
  prev?: Map<string, number>;
  /** Time budget for the search, ms. */
  budgetMs?: number;
}

/**
 * Chooses a lane for every chain.
 * - The default branch is lane 0.
 * - A branch is always to the right of the branch it branches off and of the branches it merges into.
 * - Each branch takes the lowest lane that satisfies that and is free for its whole lifetime, so lanes are
 *   reused once a branch has ended and no space is wasted.
 * Branches are placed one at a time; the order decides who gets the inner lanes. The solver searches orders
 * for the fewest crossings, then the narrowest graph, then the shortest hops.
 */
export function assignLanes(list: LayoutCommit[], opts: LaneOptions): Map<string, number> {
  const specs = edgeSpecs(list);
  const info = intervals(list, specs);
  const keys = [...info.keys()].filter((k) => k !== opts.mainKey);
  const right = rightOfRules(specs, keys, opts.mainKey);
  const isRemote = new Map(keys.map((k) => [k, opts.isRemote(k)]));
  const deadline = Date.now() + (opts.budgetMs ?? 250);

  // Starting orders: remote before local; then branches that live inside another branch's lifetime first, so
  // they take the inner lanes. "Inside" is read two ways: branched off most recently, or shortest.
  type Cmp = (a: Interval, b: Interval) => number;
  const recentFork: Cmp = (a, b) => a.bottom - b.bottom || b.top - a.top;
  const shortest: Cmp = (a, b) => a.bottom - a.top - (b.bottom - b.top) || a.bottom - b.bottom;
  const startOrder = (cmp: Cmp) => {
    const better = (a: string, b: string) => {
      const ra = isRemote.get(a)!;
      const rb = isRemote.get(b)!;
      if (ra !== rb) return ra ? -1 : 1;
      return cmp(info.get(a)!, info.get(b)!) || (a < b ? -1 : 1);
    };
    const order: string[] = [];
    const remaining = new Set(keys);
    while (remaining.size) {
      let pick: string | undefined;
      for (const k of remaining) {
        const ready = [...right.get(k)!].every((p) => !remaining.has(p));
        if (ready && (pick === undefined || better(k, pick) < 0)) pick = k;
      }
      pick ??= remaining.values().next().value as string;
      order.push(pick);
      remaining.delete(pick);
    }
    return order;
  };

  const pack = (order: string[]) => {
    const lanes = new Map<string, number>([[opts.mainKey, 0]]);
    const used: Interval[][] = [];
    for (const k of order) {
      const iv = info.get(k)!;
      let l = 1;
      for (const p of right.get(k)!) l = Math.max(l, (lanes.get(p) ?? 0) + 1);
      // Branches may share a lane when one ends at the commit where the other begins.
      while (used[l]?.some((o) => o.top < iv.bottom && iv.top < o.bottom)) l++;
      (used[l] ??= []).push(iv);
      lanes.set(k, l);
    }
    return lanes;
  };
  const valid = (order: string[]) => {
    const pos = new Map(order.map((k, i) => [k, i]));
    return order.every((k, i) => [...right.get(k)!].every((p) => p === opts.mainKey || (pos.get(p) ?? -1) < i));
  };
  const evaluate = (order: string[]) => {
    const lanes = pack(order);
    return { lanes, order, s: score(specs, lanes, opts.prev) };
  };

  let best = evaluate(startOrder(recentFork));
  if (!keys.length) return best.lanes;
  const alt = evaluate(startOrder(shortest));
  if (alt.s < best.s) best = alt;

  const remote = best.order.filter((k) => isRemote.get(k));
  const local = best.order.filter((k) => !isRemote.get(k));
  if (factorial(remote.length) * factorial(local.length) <= 5040) {
    for (const pr of permutations(remote)) {
      for (const pl of permutations(local)) {
        const order = pr.concat(pl);
        if (!valid(order)) continue;
        const r = evaluate(order);
        if (r.s < best.s - 1e-9) best = r;
      }
      if (Date.now() > deadline) break;
    }
    return best.lanes;
  }

  // Too many branches to try every order: repair crossings one at a time. A branch X whose curve crosses branch
  // Y's line is fixed either by placing X before Y (X takes the inner lane) or Y after X (Y moves outside).
  const move = (order: string[], k: string, anchor: string, after: boolean) => {
    if (isRemote.get(k) !== isRemote.get(anchor)) return undefined;
    const next = order.filter((o) => o !== k);
    const at = next.indexOf(anchor);
    if (at < 0) return undefined;
    next.splice(after ? at + 1 : at, 0, k);
    return next;
  };
  let improved = true;
  while (improved && Date.now() < deadline) {
    improved = false;
    const tried = new Set<string>();
    for (const [x, y] of measure(specs, best.lanes, opts.prev).pairs) {
      if (Date.now() > deadline) break;
      const id = `${x}\n${y}`;
      if (x === y || x === opts.mainKey || y === opts.mainKey || tried.has(id)) continue;
      tried.add(id);
      for (const next of [move(best.order, x, y, false), move(best.order, y, x, true)]) {
        if (!next || !valid(next)) continue;
        const r = evaluate(next);
        if (r.s < best.s - 1e-9) {
          best = r;
          improved = true;
          break;
        }
      }
      if (improved) break;
    }
  }

  // Narrow the graph: a branch in the outermost lane may fit further in if it is placed earlier.
  improved = true;
  while (improved && Date.now() < deadline) {
    improved = false;
    let maxLane = 0;
    for (const l of best.lanes.values()) maxLane = Math.max(maxLane, l);
    const outer = best.order.filter((k) => best.lanes.get(k) === maxLane);
    for (const k of outer) {
      const at = best.order.indexOf(k);
      for (let to = 0; to < at && Date.now() < deadline; to++) {
        if (isRemote.get(best.order[to]) !== isRemote.get(k)) continue;
        const next = best.order.filter((o) => o !== k);
        next.splice(to, 0, k);
        if (!valid(next)) continue;
        const r = evaluate(next);
        if (r.s < best.s - 1e-9) {
          best = r;
          improved = true;
          break;
        }
      }
      if (improved) break;
    }
  }
  return best.lanes;
}

/** Edges to draw for `list` (which may be a filtered subset of the list lanes were solved on). */
export function layoutEdges(list: LayoutCommit[], lanes: Map<string, number>): GraphEdge[] {
  return edgeSpecs(list).map((s) => ({
    i: s.i,
    j: s.j,
    from: lanes.get(s.upper) ?? 0,
    to: lanes.get(s.lower) ?? 0,
    kind: s.kind,
    color: lanes.get(s.br) ?? 0,
    local: s.local,
    // Every lane change is one row tall: forks curve in just above the parent, merges curve out just below.
    span: 1,
  }));
}

/** Line crossings and extra lanes jumped in a layout. */
export function layoutProblems(list: LayoutCommit[], lanes: Map<string, number>): { cross: number; hops: number } {
  const p = measure(edgeSpecs(list), lanes);
  return { cross: p.cross, hops: p.hops };
}
