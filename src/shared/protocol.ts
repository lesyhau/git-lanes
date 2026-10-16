import type { Badge, GraphModel } from '../graph/types';
import type { Filter } from '../graph/model';
import type { CommitDetails } from '../git/reader';

export interface FetchView {
  status: 'idle' | 'fetching' | 'error' | 'offline' | 'auth';
  /** Epoch ms of the last successful fetch. */
  lastFetch?: number;
  message?: string;
}

export interface GraphState {
  type: 'state';
  noRepo: boolean;
  repoName?: string;
  model?: GraphModel;
  error?: string;
  loading: boolean;
  filter: Filter;
  fetch: FetchView;
  autoFetch: boolean;
  /** Custom lane colours; empty means the built-in palette for the current theme. */
  colors: string[];
}

export type ToGraph = GraphState | { type: 'fetch'; fetch: FetchView } | { type: 'notice'; text: string };

export type FromGraph =
  | { type: 'ready' }
  | { type: 'openCommit'; hash: string }
  | { type: 'setFilter'; filter: Filter }
  | { type: 'fetch' }
  | { type: 'loadMore' };

export interface CommitState {
  type: 'commit';
  hash: string;
  details?: CommitDetails;
  error?: string;
  badges: Badge[];
  local: boolean;
  hasRemotes: boolean;
  lane: number;
  colors: string[];
}

export type CommitAction = 'checkout' | 'branch' | 'copy' | 'push';

export type FromCommit =
  | { type: 'ready' }
  | { type: 'openCommit'; hash: string }
  | { type: 'openDiff'; index: number }
  | { type: 'action'; action: CommitAction };
