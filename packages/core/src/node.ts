// SPDX-License-Identifier: MIT
// Node-only entry (@tollbooth/core/node): key-file I/O. The root entry stays
// platform-free for Workers; anything touching the filesystem lives here.
import { readFile, writeFile } from "node:fs/promises";
import {
  fromBase64Url,
  generateSecretKey,
  publicKeyOf,
  toBase64Url,
} from "./keys.js";

export interface SiteKey {
  secretKey: Uint8Array;
  publicKey: Uint8Array;
  /** True exactly once, on generation — the caller prints the public key on this flag (AC-1.2). */
  created: boolean;
}

/**
 * Load the site key from `path`, or generate one and write it with mode 0600.
 * A malformed existing file throws rather than being overwritten: silently
 * replacing a site key would orphan every receipt it ever signed.
 */
export async function loadOrCreateSiteKey(path: string): Promise<SiteKey> {
  let text: string | undefined;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (text !== undefined) {
    let secretKey: Uint8Array;
    try {
      secretKey = fromBase64Url(text.trim());
      if (secretKey.length !== 32) throw new Error("wrong length");
    } catch {
      throw new Error(
        `site key file ${path}: expected a 32-byte base64url seed`,
      );
    }
    return {
      secretKey,
      publicKey: await publicKeyOf(secretKey),
      created: false,
    };
  }
  const secretKey = generateSecretKey();
  // "wx": exclusive create — a concurrent starter loses cleanly instead of clobbering.
  await writeFile(path, `${toBase64Url(secretKey)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  return { secretKey, publicKey: await publicKeyOf(secretKey), created: true };
}
