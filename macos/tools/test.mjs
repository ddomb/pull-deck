import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const cwd = resolve(root, 'macos');
const args = process.env.PULLDECK_BUILD_PATH
  ? ['--scratch-path', resolve(process.env.PULLDECK_BUILD_PATH)]
  : [];
execFileSync(process.execPath, [resolve(root, 'tools/generate-config.mjs'), '--check'], {
  stdio: 'inherit',
});
execFileSync('swift', ['build', ...args], { cwd, stdio: 'inherit' });
const bin = execFileSync('swift', ['build', ...args, '--show-bin-path'], {
  cwd,
  encoding: 'utf8',
}).trim();
mkdirSync(resolve(root, '.claude/tmp'), { recursive: true });
const temporary = mkdtempSync(resolve(root, '.claude/tmp/runtime-'));
try {
  execFileSync(resolve(bin, 'pulldeck-selftest'), [], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, PULLDECK_TEST_ROOT: temporary },
  });
  execFileSync(
    process.execPath,
    [resolve(root, 'test/bridge-fixtures.mjs'), resolve(temporary, 'bridge-fixtures.json')],
    { cwd: root, stdio: 'inherit' }
  );
  execFileSync(resolve(bin, 'pulldeck-runtime-test'), [temporary], { cwd: root, stdio: 'inherit' });
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
execFileSync(
  process.execPath,
  [resolve(cwd, 'tools/relay-roundtrip.mjs'), resolve(bin, 'pulldeck-bridge')],
  { cwd: root, stdio: 'inherit' }
);
