export type FetchProblem = 'auth' | 'offline' | 'error';

export interface FetchOutcome {
  ok: boolean;
  problem?: FetchProblem;
  message?: string;
}

/** Why an automatic fetch is being considered. */
export type Trigger = 'visible' | 'focus' | 'activity' | 'interval';

export interface PolicyConfig {
  enabled: boolean;
  intervalMs: number;
  onWindowFocus: boolean;
  onLocalActivity: boolean;
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;

/** How old the last fetch must be before each trigger fetches again. */
const STALE: Record<Exclude<Trigger, 'interval'>, number> = {
  visible: 1 * MINUTE,
  focus: 2 * MINUTE,
  activity: 30 * SECOND,
};
/** Never fetch automatically more often than this. */
const MIN_GAP = 30 * SECOND;
const MAX_BACKOFF = 30 * MINUTE;
/** While offline, try again at most this often. */
const OFFLINE_RETRY = 5 * MINUTE;

/**
 * Decides when automatic fetches run. Manual fetches always run; they also clear a sign-in or offline pause
 * when they succeed.
 */
export class AutoFetchPolicy {
  lastAttempt = 0;
  failures = 0;
  paused: 'auth' | 'offline' | undefined;
  private pausedAt = 0;

  shouldFetch(trigger: Trigger, now: number, cfg: PolicyConfig): boolean {
    if (!cfg.enabled) return false;
    if (trigger === 'focus' && !cfg.onWindowFocus) return false;
    if (trigger === 'activity' && !cfg.onLocalActivity) return false;
    // A sign-in problem needs the user; retrying silently would only fail again.
    if (this.paused === 'auth') return false;
    if (this.paused === 'offline' && now - this.pausedAt < OFFLINE_RETRY) return false;
    const stale = trigger === 'interval' ? cfg.intervalMs : STALE[trigger];
    return now - this.lastAttempt >= Math.max(stale, MIN_GAP, this.backoff());
  }

  started(now: number): void {
    this.lastAttempt = now;
  }

  finished(outcome: FetchOutcome, now: number): void {
    if (outcome.ok) {
      this.failures = 0;
      this.paused = undefined;
    } else if (outcome.problem === 'auth' || outcome.problem === 'offline') {
      this.paused = outcome.problem;
      this.pausedAt = now;
    } else {
      this.failures++;
    }
  }

  backoff(): number {
    return this.failures ? Math.min(MAX_BACKOFF, MINUTE * 2 ** (this.failures - 1)) : 0;
  }
}

export function classifyFetchError(message: string): FetchProblem {
  if (/authentication failed|permission denied|could not read (username|password)|terminal prompts disabled|invalid (username|credentials)|access denied|logon failed|returned error: 40[13]|\b40[13]\b|unauthori[sz]ed|credential/i.test(message)) {
    return 'auth';
  }
  if (/could not resolve (host|proxy)|name or service not known|temporary failure in name resolution|network is unreachable|no route to host|connection (timed out|refused|reset)|failed to connect|operation timed out|unable to access .*(resolve|connect)|ssh: connect to host/i.test(message)) {
    return 'offline';
  }
  return 'error';
}
