import { createHash } from 'node:crypto';

export function extensionId(derPublicKey) {
  return [...createHash('sha256').update(derPublicKey).digest().subarray(0, 16)]
    .flatMap((byte) => [byte >> 4, byte & 0x0f])
    .map((nibble) => String.fromCharCode(97 + nibble))
    .join('');
}
