/**
 * Shape of a lane change, shared by the layout (which checks it for crossings) and the webview (which draws it).
 *
 * A lane change is an S: it leaves the commit dot at an angle, bends once there, then bends back the other way
 * into the new lane, so both turns show. A curve to the next lane is CURVE_ROWS tall; one across n lanes is √n
 * times as tall, so every curve turns with about the same radius instead of the far ones hooking sharply.
 */

export const CURVE_ROWS = 1.5;
/** The curve leaves (or enters) the dot this far off the vertical, towards the other lane. */
const DOT_ANGLE = Math.PI / 4;
/** Handle lengths at the dot end and the lane end, as a share of the curve's height. */
const DOT_HANDLE = 0.5;
const LANE_HANDLE = 0.5;

export type Pt = [number, number];

/** Height of a curve across `lanes` lanes, in rows, never taller than the `rows` its edge spans. */
export function curveRows(lanes: number, rows: number): number {
  return Math.min(CURVE_ROWS * Math.sqrt(lanes), rows);
}

export interface CurveEdge {
  i: number;
  j: number;
  from: number;
  to: number;
  kind: 'line' | 'fork' | 'merge';
  /** Height of the curve, in rows. */
  span: number;
}

/**
 * The curve's Bézier control points, top to bottom, for lanes `w` apart and rows `h` tall (lane 0 at x = 0).
 * A merge leaves the child's dot and curves into its lane; a fork runs down its lane and curves into the
 * parent's dot. Both coordinates only ever grow or shrink along the curve, so it never overshoots.
 */
export function curvePoints(e: CurveEdge, w: number, h: number): [Pt, Pt, Pt, Pt] {
  const v = e.span * h;
  const merge = e.kind === 'merge';
  const dot: Pt = merge ? [e.from * w, (e.i + 0.5) * h] : [e.to * w, (e.j + 0.5) * h];
  const lane: Pt = merge ? [e.to * w, dot[1] + v] : [e.from * w, dot[1] - v];
  const sx = Math.sign(lane[0] - dot[0]);
  const sy = merge ? 1 : -1;
  const dh: Pt = [dot[0] + sx * Math.sin(DOT_ANGLE) * DOT_HANDLE * v, dot[1] + sy * Math.cos(DOT_ANGLE) * DOT_HANDLE * v];
  const lh: Pt = [lane[0], lane[1] - sy * LANE_HANDLE * v];
  return merge ? [dot, dh, lh, lane] : [lane, lh, dh, dot];
}

/** Points along the curve, top to bottom. */
export function sampleCurve([p0, p1, p2, p3]: [Pt, Pt, Pt, Pt], n = 16): Pt[] {
  const out: Pt[] = [];
  for (let k = 0; k <= n; k++) {
    const t = k / n;
    const a = (1 - t) ** 3;
    const b = 3 * (1 - t) ** 2 * t;
    const c = 3 * (1 - t) * t ** 2;
    const d = t ** 3;
    out.push([a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]]);
  }
  return out;
}
