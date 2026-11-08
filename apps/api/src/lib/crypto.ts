import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";

export const newId = (): string => randomUUID();

/** Opaque session token for the client; only its SHA-256 hash is stored. */
export function newSessionToken(): { token: string; hash: Buffer } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

/** argon2id with the library's recommended defaults. */
export const hashPassword = (password: string): Promise<string> => hash(password);

// Verified when the account does not exist, so response time does not reveal it.
let dummyHash: Promise<string> | undefined;
export async function verifyPassword(stored: string | null, password: string): Promise<boolean> {
  if (!stored) {
    dummyHash ??= hash("dummy-password-for-timing");
    await verify(await dummyHash, password).catch(() => false);
    return false;
  }
  return verify(stored, password).catch(() => false);
}

// Crockford base32 (no I, L, O, U) so codes are easy to read aloud and type.
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Platform Student ID, e.g. S7K2M9QX4T. */
export function newStudentCode(): string {
  let code = "S";
  for (let i = 0; i < 9; i++) code += CROCKFORD[randomInt(32)];
  return code;
}
