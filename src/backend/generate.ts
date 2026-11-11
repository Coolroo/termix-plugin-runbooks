/**
 * Makes a secret's value (1.4.2), on the server only. Each character, or
 * each word, is picked with crypto.randomInt, which draws uniformly from
 * 0..n-1 by rejection, so no character is likelier than another (no modulo
 * bias). The value goes straight to its store; nothing here keeps or logs
 * it.
 */

import { randomInt } from "node:crypto";
import { FORMATS, type SecretFormat } from "../shared/secret-steps.js";
import { WORDS } from "./wordlist.js";

/** `length` characters of `alphabet`, each one picked uniformly. */
export function pick(alphabet: string, length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet[randomInt(alphabet.length)];
  return out;
}

/** `count` words of the EFF long list, each picked uniformly, joined by "-". */
export function passphrase(count: number, words: readonly string[] = WORDS) {
  const out: string[] = [];
  for (let i = 0; i < count; i++) out.push(words[randomInt(words.length)]);
  return out.join("-");
}

/** A new value in the format and length a checked generate field gives. */
export function generateSecret(format: SecretFormat, length: number): string {
  const bounds = FORMATS[format];
  if (!Number.isInteger(length) || length < bounds.min || length > bounds.max) {
    throw new Error(`length ${length} is out of bounds for ${format}`);
  }
  return format === "words"
    ? passphrase(length)
    : pick(bounds.alphabet!, length);
}
