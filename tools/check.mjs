import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { generateConfig } from './generate-config.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
generateConfig({ check: true });
function syntax(dir) {
  for (const entry of readdirSync(resolve(root, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) syntax(path);
    else if (/\.(mjs|js)$/.test(path))
      execFileSync(process.execPath, ['--check', resolve(root, path)], { stdio: 'pipe' });
  }
}
for (const dir of ['src', 'test', 'tools', 'macos/tools']) syntax(dir);
const manifest = JSON.parse(readFileSync(resolve(root, 'manifest.json')));
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json')));
assert.equal(pkg.version, manifest.version, 'package and extension release versions must match');
assert.ok(Number(manifest.minimum_chrome_version) >= 111, 'CSS requires Chrome 111+');
assert.ok(manifest.permissions.includes('declarativeNetRequestWithHostAccess'));
for (const resource of manifest.declarative_net_request.rule_resources)
  JSON.parse(readFileSync(resolve(root, resource.path)));
console.log(
  'JavaScript syntax, generated identity/rules, release versions, and manifest checks passed.'
);
