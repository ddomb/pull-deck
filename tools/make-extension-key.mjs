#!/usr/bin/env node
// Pins the extension's id.
//
// Without a `key`, Chrome derives an unpacked extension's id from the absolute
// path it was loaded from — so moving this repo silently changes the id, and
// every host manifest that named the old one stops working. With a `key`, the
// id is a fixed function of the public key: same id on every machine, from any
// path, forever. That is what lets the menu bar app know the id before the
// extension has ever been loaded.
//
// The value is the base64 DER public key. Chrome docs: "This value maintains
// the unique ID of an extension, or theme when it is loaded during development."
//
// Idempotent: run it once, then never again. Re-running with --force mints a
// new identity and invalidates every installed host manifest.

import { createHash, generateKeyPairSync } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(root, 'manifest.json');
// The private key is only needed to package a .crx. It is deliberately written
// outside the repo so it cannot be committed by accident.
const privateKeyPath = join(
  homedir(), 'Library', 'Application Support', 'PullDeck', 'extension-signing-key.pem'
);

/** Chrome maps each nibble of the first 128 bits of the SHA-256 onto a..p. */
export function extensionId(derPublicKey) {
  return [...createHash('sha256').update(derPublicKey).digest().subarray(0, 16)]
    .flatMap((byte) => [byte >> 4, byte & 0x0f])
    .map((nibble) => String.fromCharCode(97 + nibble))
    .join('');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const force = process.argv.includes('--force');

  if (manifest.key && !force) {
    const der = Buffer.from(manifest.key, 'base64');
    console.log(`manifest.json already has a key`);
    console.log(`extension id: ${extensionId(der)}`);
    process.exit(0);
  }

  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const der = publicKey.export({ type: 'spki', format: 'der' });
  const id = extensionId(der);

  manifest.key = der.toString('base64');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  mkdirSync(dirname(privateKeyPath), { recursive: true, mode: 0o700 });
  writeFileSync(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  chmodSync(privateKeyPath, 0o600);

  console.log(`extension id: ${id}`);
  console.log(`public key   -> manifest.json "key"`);
  console.log(`private key  -> ${privateKeyPath}`);
  console.log(`\nThe private key is only needed to package a .crx; load-unpacked does not use it.`);
}
