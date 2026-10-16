import { RawCommit, RawRef, RepoSnapshot } from '../graph/types';
import { GitRunner } from './runner';

const US = '\x1f';
const RS = '\x1e';
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

const optional = (p: Promise<string>) => p.then((s) => s.trim() || undefined).catch(() => undefined);

export async function readSnapshot(git: GitRunner, maxCommits: number): Promise<RepoSnapshot> {
  const [remotesOut, refsOut, headHash, headRef] = await Promise.all([
    git.run(['remote']),
    git.run(['for-each-ref', '--format=%(refname)%1f%(objectname)%1f%(*objectname)%1f%(upstream)%1f%(upstream:track,nobracket)%1f%(symref)', 'refs/heads', 'refs/remotes', 'refs/tags']),
    optional(git.run(['rev-parse', '--verify', '-q', 'HEAD'])),
    optional(git.run(['symbolic-ref', '-q', 'HEAD'])),
  ]);
  const remotes = remotesOut.split('\n').map((s) => s.trim()).filter(Boolean);
  const { refs, symrefs } = parseRefs(refsOut, remotes);
  const primary = remotes.includes('origin') ? 'origin' : remotes[0];
  const originHeadTarget = primary ? symrefs.get(`refs/remotes/${primary}/HEAD`) : undefined;
  const originHead = originHeadTarget?.startsWith(`refs/remotes/${primary}/`) ? originHeadTarget.slice(`refs/remotes/${primary}/`.length) : undefined;

  let commits: RawCommit[] = [];
  let truncated = false;
  if (refs.length || headHash) {
    const out = await git.run([
      '-c',
      'log.showSignature=false',
      'log',
      '--branches',
      '--remotes',
      '--tags',
      ...(headHash ? ['HEAD'] : []),
      '--date-order',
      '-n',
      String(maxCommits + 1),
      `--format=%H${US}%P${US}%an${US}%ae${US}%at${US}%s${RS}`,
      '--',
    ]);
    commits = parseLog(out);
    if (commits.length > maxCommits) {
      truncated = true;
      commits = commits.slice(0, maxCommits);
    }
  }
  return { commits, refs, remotes, headHash, headRef: headRef?.startsWith('refs/heads/') ? headRef : undefined, originHead, truncated };
}

export function parseLog(out: string): RawCommit[] {
  const commits: RawCommit[] = [];
  for (const rec of out.split(RS)) {
    const line = rec.replace(/^\s+/, '');
    if (!line) continue;
    const [hash, parents, author, email, time, ...subject] = line.split(US);
    commits.push({ hash, parents: parents ? parents.split(' ') : [], author, email, time: Number(time), subject: subject.join(US) });
  }
  return commits;
}

export function parseRefs(out: string, remotes: string[]): { refs: RawRef[]; symrefs: Map<string, string> } {
  const refs: RawRef[] = [];
  const symrefs = new Map<string, string>();
  // Longest remote first so "a/b" wins over "a" for refs/remotes/a/b/branch.
  const byLength = remotes.slice().sort((a, b) => b.length - a.length);
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [full, object, peeled, upstream, track, symref] = line.split(US);
    if (symref) {
      symrefs.set(full, symref);
      continue;
    }
    const ahead = /ahead (\d+)/.exec(track ?? '');
    const behind = /behind (\d+)/.exec(track ?? '');
    const base = { full, hash: peeled || object, ahead: ahead ? Number(ahead[1]) : 0, behind: behind ? Number(behind[1]) : 0, gone: track === 'gone' };
    if (full.startsWith('refs/heads/')) {
      refs.push({ ...base, kind: 'head', name: full.slice(11), upstream: upstream || undefined });
    } else if (full.startsWith('refs/tags/')) {
      refs.push({ ...base, kind: 'tag', name: full.slice(10) });
    } else if (full.startsWith('refs/remotes/')) {
      const rest = full.slice(13);
      const remote = byLength.find((r) => rest.startsWith(`${r}/`)) ?? rest.slice(0, rest.indexOf('/'));
      refs.push({ ...base, kind: 'remote', remote, name: rest.slice(remote.length + 1) });
    }
  }
  return { refs, symrefs };
}

export interface FileChange {
  /** A, M, D, R, C or T. */
  status: string;
  path: string;
  oldPath?: string;
  /** Null for binary files. */
  added: number | null;
  deleted: number | null;
}

export interface CommitDetails {
  hash: string;
  parents: string[];
  author: string;
  email: string;
  authorTime: number;
  committer: string;
  committerEmail: string;
  commitTime: number;
  message: string;
  files: FileChange[];
}

export async function readCommitDetails(git: GitRunner, hash: string): Promise<CommitDetails> {
  const head = await git.run(['show', '-s', `--format=%H${US}%P${US}%an${US}%ae${US}%at${US}%cn${US}%ce${US}%ct${US}%B`, hash]);
  const [h, parents, author, email, at, committer, committerEmail, ct, ...message] = head.split(US);
  const parentList = parents ? parents.split(' ') : [];
  const base = parentList[0] ?? EMPTY_TREE;
  const [numstat, names] = await Promise.all([
    git.run(['diff-tree', '-r', '-M', '-z', '--numstat', base, h]),
    git.run(['diff-tree', '-r', '-M', '-z', '--name-status', base, h]),
  ]);
  return {
    hash: h,
    parents: parentList,
    author,
    email,
    authorTime: Number(at),
    committer,
    committerEmail,
    commitTime: Number(ct),
    message: message.join(US).replace(/\s+$/, ''),
    files: parseFileChanges(names, numstat),
  };
}

export function parseFileChanges(nameStatus: string, numstat: string): FileChange[] {
  const files: FileChange[] = [];
  const n = nameStatus.split('\0');
  for (let k = 0; k < n.length; ) {
    const status = n[k];
    if (!status) {
      k++;
      continue;
    }
    if (status[0] === 'R' || status[0] === 'C') {
      files.push({ status: status[0], oldPath: n[k + 1], path: n[k + 2], added: null, deleted: null });
      k += 3;
    } else {
      files.push({ status: status[0], path: n[k + 1], added: null, deleted: null });
      k += 2;
    }
  }
  const stats = new Map<string, [number | null, number | null]>();
  const s = numstat.split('\0');
  for (let k = 0; k < s.length; ) {
    const rec = s[k];
    if (!rec) {
      k++;
      continue;
    }
    const [a, d, path] = rec.split('\t');
    const nums: [number | null, number | null] = [a === '-' ? null : Number(a), d === '-' ? null : Number(d)];
    if (path) {
      stats.set(path, nums);
      k += 1;
    } else {
      // Rename/copy: "a\td\t" then old path and new path as separate fields.
      stats.set(s[k + 2], nums);
      k += 3;
    }
  }
  for (const f of files) {
    const st = stats.get(f.path);
    if (st) [f.added, f.deleted] = st;
  }
  return files;
}
