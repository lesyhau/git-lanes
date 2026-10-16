import { CURVE_ROWS, curvePoints, curveRows, Pt, sampleCurve } from './curve';
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
function score(list: LayoutCommit[], specs: EdgeSpec[], lanes: Map<string, number>, prev?: Map<string, number>): number {
  const p = measure(list, specs, lanes, prev);
  return p.cross * W_CROSS + p.maxLane * W_WIDTH + p.hops * W_HOP + p.moved * W_MOVED;
}

/** Lane width and row height of the side view, in px: the proportions the crossing check measures curves at. */
const LANE_W = 22;
const ROW_H = 28;
/** Curves closer than this (px) count as touching, not crossing: the curves that fan out of one dot. */
const TOUCH = 0.5;
/** Radius of a commit dot, and the room a curve keeps from a dot it passes, px. */
const DOT_R = 6;
const CLEAR = 9;

/**
 * Height of the curve for a lane change, in rows: curveRows' height, unless that would run the curve into a dot
 * on a lane it passes. Then the nearest height that clears every such dot, a little taller or shorter.
 */
function fitSpan(i: number, j: number, from: number, to: number, kind: EdgeSpec['kind'], dotLane: (row: number) => number | undefined): number {
  const rows = j - i;
  const want = curveRows(Math.abs(from - to), rows);
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  const dots: Pt[] = [];
  for (let r = i + 1; r < j; r++) {
    const l = dotLane(r);
    if (l !== undefined && l > lo && l < hi) dots.push([l * LANE_W, (r + 0.5) * ROW_H]);
  }
  if (!dots.length) return want;
  const clears = (span: number) => {
    const pts = sampleCurve(curvePoints({ i, j, from, to, kind, span }, LANE_W, ROW_H), 32);
    return dots.every(([x, y]) => pts.every((p) => Math.hypot(p[0] - x, p[1] - y) >= CLEAR));
  };
  const least = Math.min(1, rows);
  for (let d = 0; d <= CURVE_ROWS + 1e-9; d += 0.1) {
    for (const span of d ? [want + d, want - d] : [want]) if (span >= least && span <= rows && clears(span)) return span;
  }
  return want;
}

/** Where a curve that only moves one way along `axis` is, at `v` along that axis. */
function along(pts: Pt[], axis: 0 | 1, v: number): number {
  const o = 1 - axis;
  for (let k = 1; k < pts.length; k++) {
    const a = pts[k - 1];
    const b = pts[k];
    if ((v - a[axis]) * (v - b[axis]) <= 0) return a[axis] === b[axis] ? a[o] : a[o] + ((v - a[axis]) / (b[axis] - a[axis])) * (b[o] - a[o]);
  }
  return pts[pts.length - 1][o];
}

/**
 * Lane changes are drawn as curves up to a few rows tall (see curve.ts), so crossings are measured on the
 * drawn shapes: a curve crossing a lane line or passing through a dot, or two curves whose order flips.
 */
function measure(list: LayoutCommit[], specs: EdgeSpec[], lanes: Map<string, number>, prev?: Map<string, number>): Problems {
  const y = (row: number) => (row + 0.5) * ROW_H;
  // Straight lane lines, in px, by lane.
  type Seg = { y0: number; y1: number; chain: string };
  const byLane = new Map<number, Seg[]>();
  const vertical = (lane: number, chain: string, y0: number, y1: number) => {
    if (y1 < y0) return;
    const segs = byLane.get(lane);
    if (segs) segs.push({ y0, y1, chain });
    else byLane.set(lane, [{ y0, y1, chain }]);
  };
  // A dot is a short line, so a curve through a dot counts as a crossing.
  list.forEach((c, i) => vertical(lanes.get(c.chain)!, c.chain, y(i) - DOT_R, y(i) + DOT_R));
  const dotLane = (row: number) => lanes.get(list[row].chain);
  type Curve = { pts: Pt[]; lo: number; hi: number; top: number; bottom: number; chain: string };
  const curves: Curve[] = [];
  for (const e of specs) {
    const la = lanes.get(e.upper)!;
    const lb = lanes.get(e.lower)!;
    if (la === lb) {
      vertical(la, e.br, y(e.i), y(e.j));
      continue;
    }
    const span = fitSpan(e.i, e.j, la, lb, e.kind, dotLane);
    if (e.kind === 'fork') vertical(la, e.upper, y(e.i), y(e.j - span));
    else vertical(lb, e.lower, y(e.i + span), y(e.j));
    const pts = sampleCurve(curvePoints({ i: e.i, j: e.j, from: la, to: lb, kind: e.kind, span }, LANE_W, ROW_H));
    curves.push({ pts, lo: Math.min(la, lb), hi: Math.max(la, lb), top: pts[0][1], bottom: pts[pts.length - 1][1], chain: e.br });
  }
  let cross = 0;
  let hops = 0;
  const pairs: [string, string][] = [];
  for (const c of curves) {
    hops += c.hi - c.lo - 1;
    for (let l = c.lo + 1; l < c.hi; l++) {
      const at = along(c.pts, 0, l * LANE_W);
      const hit = byLane.get(l)?.find((s) => s.y0 <= at && at <= s.y1);
      if (hit) {
        cross++;
        pairs.push([c.chain, hit.chain]);
      }
    }
  }
  curves.sort((a, b) => a.top - b.top);
  for (let p = 0; p < curves.length; p++) {
    const a = curves[p];
    for (let q = p + 1; q < curves.length && curves[q].top < a.bottom; q++) {
      const b = curves[q];
      const y0 = b.top;
      const y1 = Math.min(a.bottom, b.bottom);
      let left = false;
      let right = false;
      for (const pt of [...a.pts, ...b.pts]) {
        if (pt[1] < y0 || pt[1] > y1) continue;
        const d = along(a.pts, 1, pt[1]) - along(b.pts, 1, pt[1]);
        if (d > TOUCH) right = true;
        else if (d < -TOUCH) left = true;
      }
      if (left && right) {
        cross++;
        pairs.push(a.hi > b.hi ? [a.chain, b.chain] : [b.chain, a.chain]);
      }
    }
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
    return { lanes, order, s: score(list, specs, lanes, opts.prev) };
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
    for (const [x, y] of measure(list, specs, best.lanes, opts.prev).pairs) {
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
  const dotLane = (row: number) => lanes.get(list[row].chain) ?? 0;
  return edgeSpecs(list).map((s) => {
    const from = lanes.get(s.upper) ?? 0;
    const to = lanes.get(s.lower) ?? 0;
    // Forks curve in above the parent, merges curve out below the merge; the further the jump, the taller.
    const span = from === to ? 0 : fitSpan(s.i, s.j, from, to, s.kind, dotLane);
    return { i: s.i, j: s.j, from, to, kind: s.kind, color: lanes.get(s.br) ?? 0, local: s.local, span };
  });
}

/** Line crossings and extra lanes jumped in a layout. */
export function layoutProblems(list: LayoutCommit[], lanes: Map<string, number>): { cross: number; hops: number } {
  const p = measure(list, edgeSpecs(list), lanes);
  return { cross: p.cross, hops: p.hops };
}
