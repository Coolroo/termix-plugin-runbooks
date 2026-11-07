// node validate.mjs <schema.json> <index.json> [<file.tmxplug>]
// A JSON Schema subset validator covering every keyword registry-index-schema.json
// uses: type, required, additionalProperties:false, properties, $ref (#/$defs/..),
// items, pattern, const, minLength, maxLength, maxItems, uniqueItems, minimum,
// format (date-time, uri). Then the Termix checks (trust.ts verifyPluginArtifact,
// registries.ts pluginKeyId) against the file, if given.
import fs from "node:fs";
import crypto from "node:crypto";
const [schemaPath, indexPath, file] = process.argv.slice(2);
const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
const doc = JSON.parse(fs.readFileSync(indexPath, "utf8"));
const errors = [];
const used = new Set();
const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);
function check(s, v, at) {
  if (s.$ref) { used.add("$ref"); return check(s.$ref.replace("#/", "").split("/").reduce((o, k) => o[k], schema), v, at); }
  const t = typeOf(v);
  const err = (m) => errors.push(`${at || "/"}: ${m}`);
  if (s.type) { used.add("type"); const ok = s.type === t || (s.type === "number" && t === "integer"); if (!ok) return err(`type ${t}, want ${s.type}`); }
  if ("const" in s) { used.add("const"); if (v !== s.const) err(`const ${JSON.stringify(s.const)}`); }
  if (t === "string") {
    if (s.pattern) { used.add("pattern"); if (!new RegExp(s.pattern, "u").test(v)) err(`pattern ${s.pattern}`); }
    if (s.minLength != null) { used.add("minLength"); if ([...v].length < s.minLength) err(`minLength ${s.minLength}`); }
    if (s.maxLength != null) { used.add("maxLength"); if ([...v].length > s.maxLength) err(`maxLength ${s.maxLength}`); }
    if (s.format === "date-time") { used.add("format"); if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/.test(v) || isNaN(Date.parse(v))) err("format date-time"); }
    if (s.format === "uri") { used.add("format"); try { new URL(v); } catch { err("format uri"); } }
  }
  if (t === "integer" && s.minimum != null) { used.add("minimum"); if (v < s.minimum) err(`minimum ${s.minimum}`); }
  if (t === "array") {
    if (s.maxItems != null) { used.add("maxItems"); if (v.length > s.maxItems) err(`maxItems ${s.maxItems}`); }
    if (s.uniqueItems) { used.add("uniqueItems"); if (new Set(v.map((x) => JSON.stringify(x))).size !== v.length) err("uniqueItems"); }
    if (s.items) { used.add("items"); v.forEach((x, i) => check(s.items, x, `${at}/${i}`)); }
  }
  if (t === "object") {
    for (const r of s.required ?? []) { used.add("required"); if (!(r in v)) err(`required ${r}`); }
    for (const [k, x] of Object.entries(v)) {
      if (s.properties?.[k]) { used.add("properties"); check(s.properties[k], x, `${at}/${k}`); }
      else if (s.additionalProperties === false) { used.add("additionalProperties"); err(`additional property ${k}`); }
      else if (typeof s.additionalProperties === "object") { used.add("additionalProperties"); check(s.additionalProperties, x, `${at}/${k}`); }
    }
  }
}
check(schema, doc, "");
// Every keyword the schema holds must be one this validator knows.
const known = new Set(["$schema", "$id", "title", "description", "type", "additionalProperties", "required", "properties", "$defs", "$ref", "pattern", "const", "minLength", "maxLength", "maxItems", "uniqueItems", "minimum", "format", "items"]);
(function walk(s) {
  for (const k of Object.keys(s)) if (!known.has(k)) errors.push(`validator does not know keyword ${k}`);
  for (const sub of [...Object.values(s.properties ?? {}), ...Object.values(s.$defs ?? {}), s.items, s.additionalProperties])
    if (sub && typeof sub === "object") walk(sub);
})(schema);
if (errors.length) { console.log("SCHEMA: INVALID"); errors.forEach((e) => console.log("  " + e)); process.exitCode = 1; }
else console.log(`SCHEMA: valid (keywords checked: ${[...used].sort().join(", ")})`);

const keyId = crypto.createHash("sha256").update(Buffer.from(doc.publicKey, "base64")).digest("hex").slice(0, 16);
console.log(`keyId (registries.ts/trust.ts pluginKeyId): ${keyId}`);
if (file) {
  const buf = fs.readFileSync(file);
  const p = doc.plugins[0];
  const rel = [...(p.versions ?? []), ...(p.gated ?? [])][0];
  const digest = crypto.createHash("sha256").update(buf).digest();
  const key = crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(doc.publicKey, "base64")]), format: "der", type: "spki" });
  console.log(`sha256 matches file: ${digest.toString("hex") === rel.sha256}; size matches: ${buf.length === rel.size}; signature verifies: ${crypto.verify(null, digest, key, Buffer.from(rel.signature, "base64"))}`);
}
