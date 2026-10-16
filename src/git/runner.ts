import { execFile } from 'child_process';

export class GitCommandError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    readonly args: string[],
  ) {
    super(message);
  }
}

/** Runs git in one repository. Never prompts: credential and terminal prompts are disabled. */
export class GitRunner {
  constructor(
    private readonly gitPath: string,
    readonly cwd: string,
  ) {}

  run(args: string[], opts: { timeoutMs?: number } = {}): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        this.gitPath,
        ['-c', 'core.quotepath=off', '-c', 'color.ui=false', ...args],
        {
          cwd: this.cwd,
          encoding: 'utf8',
          maxBuffer: 256 * 1024 * 1024,
          timeout: opts.timeoutMs ?? 30_000,
          windowsHide: true,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
        },
        (err, stdout, stderr) => {
          if (err) reject(new GitCommandError(stderr.trim() || err.message, stderr, args));
          else resolve(stdout);
        },
      );
    });
  }
}
