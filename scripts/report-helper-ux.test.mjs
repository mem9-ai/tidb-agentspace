import { execFileSync, spawnSync } from 'node:child_process';
import { test } from 'node:test';

const python =
  process.env.WORKSPACE_TRIAL_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const available = spawnSync(python, ['--version']).status === 0;

test(
  'report helper preserves project boundaries and presents actionable results',
  {
    skip: available ? false : 'Python is not installed; do not install a runtime for the trial',
  },
  () => {
    execFileSync(python, ['-IB', 'server/test-support/report_helper_ux.py'], {
      cwd: new URL('../', import.meta.url),
      timeout: 30_000,
      stdio: 'pipe',
    });
  },
);
