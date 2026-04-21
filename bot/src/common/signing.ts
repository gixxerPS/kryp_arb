import crypto from 'crypto';

export function signEd25519Base64(privateKeyPem: string, payload: string): string {
  return crypto.sign(null, Buffer.from(payload), privateKeyPem).toString('base64');
}
