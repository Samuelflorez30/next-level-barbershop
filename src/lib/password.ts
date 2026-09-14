import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import bcrypt from 'bcryptjs';

const scrypt = promisify(scryptCb);

/**
 * Hash de contraseñas con bcrypt (bcryptjs: JS puro, sin bindings nativos,
 * funciona en Vercel). Los usuarios sembrados en la Fase 1 tienen hashes
 * scrypt (`scrypt$<salt>$<hash>`); `verifyPassword` los sigue aceptando y
 * `needsRehash` permite migrarlos a bcrypt en el primer login exitoso.
 */

const BCRYPT_ROUNDS = 12;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

/** True si el hash no es bcrypt (p. ej. scrypt heredado) y conviene regenerarlo. */
export function needsRehash(stored: string): boolean {
  return !stored.startsWith('$2');
}

export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  if (stored.startsWith('$2')) {
    return bcrypt.compare(plain, stored);
  }
  if (stored.startsWith('scrypt$')) {
    return verifyLegacyScrypt(plain, stored);
  }
  return false;
}

async function verifyLegacyScrypt(plain: string, stored: string): Promise<boolean> {
  const [, saltB64, hashB64] = stored.split('$');
  if (!saltB64 || !hashB64) return false;
  const salt = Buffer.from(saltB64, 'base64url');
  const expected = Buffer.from(hashB64, 'base64url');
  const derived = (await scrypt(plain, salt, expected.length)) as Buffer;
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/** Contraseña temporal aleatoria, legible (base64url, ~12 caracteres). */
export function generateTemporaryPassword(): string {
  return randomBytes(9).toString('base64url');
}
