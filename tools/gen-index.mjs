// node gen-index.mjs <manifest.json> <CHANGELOG.md> <file.tmxplug> <file.sig> <publicKey> <url> <publishedAt> <out.json>
import fs from "node:fs";
import crypto from "node:crypto";
const [mf, cl, file, sigf, pub, url, publishedAt, out] = process.argv.slice(2);
const m = JSON.parse(fs.readFileSync(mf, "utf8"));
const buf = fs.readFileSync(file);
const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
const signature = fs.readFileSync(sigf, "utf8").trim();
const log = fs.readFileSync(cl, "utf8");
const sec = log.split(/^## /m).find((s) => s.startsWith(`${m.version}\n`));
const notes = sec ? sec.slice(m.version.length + 1).trim() : undefined;
const major = (m.engine.api.match(/\d+/) || [])[0];
const release = {
  version: m.version,
  api: major,
  url,
  sha256,
  signature,
  size: buf.length,
  capabilities: m.capabilities,
  engine: { api: m.engine.api, termix: m.engine.termix },
  releaseNotesUrl: `${m.repository}/releases/tag/v${m.version}`,
  ...(notes ? { notes } : {}),
  publishedAt,
};
// Like Termix-Registry's placeReleases: a release Termix 26.10.2 can't run
// (engine.termix excludes it) goes in gated, which builds up to 26.10.2 never read.
const ge = m.engine.termix.match(/^>=\s*(\d+)\.(\d+)\.(\d+)$/);
if (!ge) throw new Error(`engine.termix ${m.engine.termix}: only >=X.Y.Z handled here`);
const cmp = (a, b) => a.reduce((r, v, i) => r || v - b[i], 0);
const gated = cmp([26, 10, 2], ge.slice(1).map(Number)) < 0;
const index = {
  $schema: "https://raw.githubusercontent.com/Termix-SSH/Termix-Registry/main/registry-index-schema.json",
  registry: "coolroo",
  name: "Coolroo Plugins",
  apiVersion: 1,
  publicKey: pub,
  updatedAt: new Date(publishedAt).toISOString(),
  plugins: [
    {
      id: m.id,
      name: m.name,
      description: m.description,
      author: typeof m.author === "string" ? m.author : m.author.name,
      category: m.category,
      repository: m.repository,
      icon: m.icon,
      features: m.features,
      docs: m.docs,
      versions: gated ? [] : [release],
      ...(gated ? { gated: [release] } : {}),
      contributes: Object.keys(m.contributes ?? {}).filter((k) => /^[A-Za-z]+$/.test(k)).sort(),
    },
  ],
};
fs.writeFileSync(out, JSON.stringify(index, null, 2) + "\n");
console.log(`wrote ${out} (gated: ${gated})`);
