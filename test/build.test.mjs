import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { generatedConfig } from '../tools/generate-config.mjs';
import { extensionId } from '../tools/extension-id.mjs';

test('key rotation generates matching native identity and shortcut rules', () => {
  const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url)));
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const der = publicKey.export({ type: 'spki', format: 'der' });
  const generated = generatedConfig({ ...manifest, key: der.toString('base64') });
  const id = extensionId(der);
  assert.ok(generated['macos/Sources/PullDeckKit/BuildIdentity.swift'].includes(id));
  for (const rule of JSON.parse(generated['rules/shortcuts.json']))
    assert.ok(rule.action.redirect.regexSubstitution.includes(id));
});

test('plist generation round-trips paths with XML metacharacters', () => {
  execFileSync('python3', [
    '-c',
    `
import importlib.util, plistlib
spec = importlib.util.spec_from_file_location('writer', 'macos/tools/write-plist.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
path = '/Users/example/Projects & Tools/<pull-deck>'
value = plistlib.loads(plistlib.dumps(module.metadata(path, '1.4.0')))
assert value['PDExtensionPath'] == path
assert value['CFBundleShortVersionString'] == '1.4.0'
`,
  ]);
});

test('packaged extension excludes development data and contains the runtime rules', () => {
  const path = execFileSync('python3', ['tools/package-extension.py'], { encoding: 'utf8' }).trim();
  const files = JSON.parse(
    execFileSync(
      'python3',
      [
        '-c',
        'import json,sys,zipfile; print(json.dumps(zipfile.ZipFile(sys.argv[1]).namelist()))',
        path,
      ],
      { encoding: 'utf8' }
    )
  );
  assert.ok(files.includes('manifest.json'));
  assert.ok(files.includes('rules/shortcuts.json'));
  assert.ok(files.includes('LICENSE'));
  assert.equal(
    files.some((f) => /(?:\.claude|node_modules|\.git|macos|\.pem)/.test(f)),
    false
  );
});
