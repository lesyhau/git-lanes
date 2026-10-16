/** A commit as read from `git log`, newest first (children always before parents). */
export interface RawCommit {
  hash: string;
  parents: string[];
  author: string;
  email: string;
  /** Author time, unix seconds. */
  time: number;
  subject: string;
}

export interface RawRef {
  /** Full ref name, e.g. refs/heads/main, refs/remotes/origin/main, refs/tags/v1. */
  full: string;
  /** Commit the ref points at (tags are peeled). */
  hash: string;
  kind: 'head' | 'remote' | 'tag';
  /** For remote refs: the remote name. */
  remote?: string;
  /** Branch or tag name without refs/... and without the remote prefix. */
  name: string;
  /** For local branches: full name of the upstream ref, if configured. */
  upstream?: string;
  ahead: number;
  behind: number;
  /** Upstream is configured but no longer exists. */
  gone: boolean;
}

export interface RepoSnapshot {
  commits: RawCommit[];
  refs: RawRef[];
  remotes: string[];
  headHash?: string;
  /** Full name of the checked-out branch; undefined when detached. */
  headRef?: string;
  /** Branch that origin/HEAD points at, e.g. "main". */
  originHead?: string;
  /** True when more commits exist beyond the loaded window. */
  truncated: boolean;
}

export type BadgeKind = 'remote' | 'local' | 'both' | 'tag' | 'detached';

export interface Badge {
  kind: BadgeKind;
  /** Text shown in the badge. */
  name: string;
  /** Tooltip. */
  title: string;
  /** Full ref name the badge stands for (local ref for "both"). */
  ref: string;
  ahead?: number;
  behind?: number;
  /** The checked-out branch. */
  head?: boolean;
}

export interface GraphCommit {
  hash: string;
  parents: string[];
  author: string;
  email: string;
  time: number;
  subject: string;
  lane: number;
  /** Not reachable from any remote ref (only meaningful when the repo has remotes). */
  local: boolean;
  /** The checked-out commit. */
  head: boolean;
  badges: Badge[];
}

export interface GraphEdge {
  /** Row of the child commit. */
  i: number;
  /** Row of the parent commit; equals the commit count when the parent is beyond the loaded window. */
  j: number;
  /** Lane at the child end. */
  from: number;
  /** Lane at the parent end. */
  to: number;
  kind: 'line' | 'fork' | 'merge';
  /** Lane whose colour the edge uses. */
  color: number;
  /** Drawn dashed: the branch side of the edge is local only. */
  local: boolean;
  /** Height of the lane-change curve, in rows. */
  span: number;
}

export interface GraphModel {
  commits: GraphCommit[];
  edges: GraphEdge[];
  maxLane: number;
  truncated: boolean;
  hasRemotes: boolean;
  defaultBranch?: string;
}
