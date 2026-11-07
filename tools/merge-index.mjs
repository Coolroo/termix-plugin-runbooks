// node merge-index.mjs <new-version-index.json> <current-index.json> <out.json>
// Keeps every release already listed, puts the new one first, and takes the plugin's
// own fields (description, features...) from the new index. Same publicKey required.
import fs from "node:fs";
const [fresh, current, out] = process.argv.slice(2);
const n = JSON.parse(fs.readFileSync(fresh, "utf8"));
const c = JSON.parse(fs.readFileSync(current, "utf8"));
if (n.publicKey !== c.publicKey) throw new Error("the public key changed: Termix would refuse the registry");
for (const np of n.plugins) {
  const cp = c.plugins.find((p) => p.id === np.id);
  if (!cp) continue;
  for (const list of ["versions", "gated"]) {
    const seen = new Set((np[list] ?? []).map((r) => r.version));
    const old = (cp[list] ?? []).filter((r) => !seen.has(r.version));
    if ((np[list] ?? []).length || old.length) np[list] = [...(np[list] ?? []), ...old];
  }
}
for (const cp of c.plugins) if (!n.plugins.some((p) => p.id === cp.id)) n.plugins.push(cp);
fs.writeFileSync(out, JSON.stringify(n, null, 2) + "\n");
for (const p of n.plugins) console.log(p.id, "versions:", (p.versions ?? []).map((r) => r.version).join(",") || "-", "gated:", (p.gated ?? []).map((r) => r.version).join(","));
