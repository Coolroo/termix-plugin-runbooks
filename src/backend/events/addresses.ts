/**
 * The addresses an http item may reach from Termix (BUG-022 M4). An
 * address is read in every spelling first: IPv4 as decimal, octal or hex
 * (the URL parser writes those as dotted decimal), and IPv6 with an IPv4
 * address inside (IPv4-mapped ::ffff:a.b.c.d in any form, IPv4-compatible
 * ::a.b.c.d, IPv4-translated ::ffff:0:a.b.c.d, NAT64 64:ff9b::/96), which
 * is judged as that IPv4 address.
 *
 * "refused": Termix never reaches it for a runbook. Loopback, unspecified,
 * link-local, multicast and reserved, the local-use NAT64 prefix, and
 * Termix's own addresses (a service that listens on all of Termix's
 * addresses answers on each).
 *
 * "private": a private network (RFC 1918, the tailnet's 100.64.0.0/10,
 * unique local fc00::/7, and the small special ranges core refuses too).
 * Only these get core's allowPrivateHosts.
 *
 * "public": everything else; core's own check refuses a private answer.
 */

import net from "node:net";
import os from "node:os";

export type AddressKind = "refused" | "private" | "public";

/** IPv4 ranges by kind, as [network, prefix]. */
const IPV4: Array<[string, number, AddressKind]> = [
  ["0.0.0.0", 8, "refused"],
  ["127.0.0.0", 8, "refused"],
  ["169.254.0.0", 16, "refused"],
  ["224.0.0.0", 4, "refused"],
  ["240.0.0.0", 4, "refused"],
  ["10.0.0.0", 8, "private"],
  ["100.64.0.0", 10, "private"],
  ["172.16.0.0", 12, "private"],
  ["192.0.0.0", 24, "private"],
  ["192.168.0.0", 16, "private"],
  ["198.18.0.0", 15, "private"],
];

/** IPv6 ranges (with no IPv4 inside) by kind, as [first bytes, bits]. */
const IPV6: Array<[number[], number, AddressKind]> = [
  [[0xfe, 0x80], 10, "refused"],
  [[0xff], 8, "refused"],
  // Local-use NAT64 (RFC 8215): where the IPv4 part sits varies.
  [[0x00, 0x64, 0xff, 0x9b, 0x00, 0x01], 48, "refused"],
  [[0xfc], 7, "private"],
  [[0xfe, 0xc0], 10, "private"],
];

function inPrefix(bytes: number[], first: number[], bits: number): boolean {
  for (let bit = 0; bit < bits; bit++) {
    const byte = bit >> 3;
    const mask = 0x80 >> (bit & 7);
    if ((bytes[byte] & mask) !== ((first[byte] ?? 0) & mask)) return false;
  }
  return true;
}

/** The 16 bytes of an IPv6 address (net.isIP said 6), or null. */
function ipv6Bytes(address: string): number[] | null {
  let text = address;
  const tail: number[] = [];
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    tail.push(...dotted[1].split(".").map(Number));
    text = `${text.slice(0, dotted.index)}0:0`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const words = (part: string) =>
    part === "" ? [] : part.split(":").map((word) => parseInt(word, 16));
  const head = words(halves[0]);
  const rest = halves.length === 2 ? words(halves[1]) : [];
  const fill = 8 - head.length - rest.length;
  if (fill < 0 || (halves.length === 1 && fill !== 0)) return null;
  const all = [...head, ...new Array<number>(fill).fill(0), ...rest];
  const bytes = all.flatMap((word) => [word >> 8, word & 0xff]);
  if (tail.length) bytes.splice(12, 4, ...tail);
  return bytes.some((byte) => Number.isNaN(byte)) ? null : bytes;
}

function zero(bytes: number[], from: number, to: number): boolean {
  return bytes.slice(from, to).every((byte) => byte === 0);
}

/**
 * The IPv4 address an IPv6 address carries, when it is one of the forms
 * that reach an IPv4 address: mapped, compatible, translated, NAT64.
 */
function embeddedIpv4(bytes: number[]): string | null {
  const v4 = bytes.slice(12).join(".");
  const mapped = zero(bytes, 0, 10) && bytes[10] === 0xff && bytes[11] === 0xff;
  const translated =
    zero(bytes, 0, 8) &&
    bytes[8] === 0xff &&
    bytes[9] === 0xff &&
    zero(bytes, 10, 12);
  const compatible = zero(bytes, 0, 12);
  const nat64 =
    bytes[0] === 0x00 &&
    bytes[1] === 0x64 &&
    bytes[2] === 0xff &&
    bytes[3] === 0x9b &&
    zero(bytes, 4, 12);
  return mapped || translated || compatible || nat64 ? v4 : null;
}

/**
 * One address in one spelling: an IPv4 address dotted, an IPv6 address as
 * its 32 hex digits; an IPv6 address with an IPv4 address inside as that
 * IPv4 address (so ::ffff:127.0.0.1 and ::ffff:7f00:1 read 127.0.0.1).
 * Null when it is not an address.
 */
export function canonicalAddress(raw: string): string | null {
  let address = raw
    .trim()
    .replace(/^\[|\]$/g, "")
    .replace(/%.*$/, "")
    .toLowerCase();
  if (net.isIP(address) === 0) {
    // 2130706433, 0177.0.0.1, 0x7f.1: the URL parser reads them as IPv4.
    try {
      address = new URL(`http://${address}/`).hostname.replace(/^\[|\]$/g, "");
    } catch {
      return null;
    }
    if (net.isIP(address) === 0) return null;
  }
  if (net.isIP(address) === 4) {
    return address
      .split(".")
      .map((part) => String(Number(part)))
      .join(".");
  }
  const bytes = ipv6Bytes(address);
  if (!bytes) return null;
  // :: and ::1 have the compatible form's zeros, but are IPv6's own.
  if (zero(bytes, 0, 15) && (bytes[15] === 0 || bytes[15] === 1)) {
    return bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  return (
    embeddedIpv4(bytes) ??
    bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("")
  );
}

function ipv4Kind(address: string): AddressKind {
  const bytes = address.split(".").map(Number);
  for (const [network, prefix, kind] of IPV4) {
    if (inPrefix(bytes, network.split(".").map(Number), prefix)) return kind;
  }
  return "public";
}

/**
 * The kind of an address without Termix's own addresses: what a URL may
 * name when a step is written.
 */
export function rangeKind(raw: string): AddressKind | null {
  const address = canonicalAddress(raw);
  if (address === null) return null;
  if (net.isIP(address) === 4) return ipv4Kind(address);
  const bytes = (address.match(/../g) ?? []).map((pair) => parseInt(pair, 16));
  // :: and ::1.
  if (zero(bytes, 0, 15) && bytes[15] <= 1) return "refused";
  for (const [first, bits, kind] of IPV6) {
    if (inPrefix(bytes, first, bits)) return kind;
  }
  return "public";
}

/** Termix's own addresses, each as canonicalAddress gives it. */
function ownAddresses(): Set<string> {
  const own = new Set<string>();
  for (const list of Object.values(os.networkInterfaces())) {
    for (const each of list ?? []) {
      const address = canonicalAddress(each.address);
      if (address) own.add(address);
    }
  }
  return own;
}

/** The kind of an address, with Termix's own addresses refused. */
export function addressKind(raw: string): AddressKind {
  const kind = rangeKind(raw);
  if (kind === null) return "refused";
  if (kind === "refused") return kind;
  return ownAddresses().has(canonicalAddress(raw)!) ? "refused" : kind;
}
