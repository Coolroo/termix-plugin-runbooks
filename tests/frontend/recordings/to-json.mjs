import fs from "node:fs";
const [, , dir, ...specs] = process.argv;
const out = {};
for (const spec of specs) {
  const [name, cols] = spec.split(":");
  const log = fs.readFileSync(`${dir}/${name}.log`);
  const start = log.indexOf(10) + 1;
  const sizes = fs
    .readFileSync(`${dir}/${name}.tm`, "utf8")
    .trim()
    .split("\n")
    .map((l) => Number(l.split(" ")[1]));
  let at = start;
  const chunks = sizes.map((n) => {
    const c = log.subarray(at, at + n).toString("utf8");
    at += n;
    return c;
  });
  const send = chunks.findIndex((c) => c.includes("\u001b[7m"));
  const exit = chunks.findIndex(
    (c, i) => i > send && /exit\r\n/.test(c) && c.includes("\u001b[?2004h"),
  );
  out[name] = {
    cols: Number(cols),
    before: chunks.slice(0, send),
    after: chunks.slice(send),
  };
}
process.stdout.write(JSON.stringify(out, null, 1) + "\n");
