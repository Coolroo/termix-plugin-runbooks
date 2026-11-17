// Finishes a release that the shared workflow left as a draft (board BUG-012).
//
// Termix-Registry's plugin-release.yml makes the draft with `gh release
// create --draft`, then lists the releases to find its id. GitHub's list can
// lag the create by a few seconds, so the step sometimes finds nothing, says
// "No draft found for vX.Y.Z." and fails after everything else passed. This
// script runs in its own job after that failure: it waits for the draft,
// publishes it as the shared step would have, and does the stable release's
// clean-up. It does nothing unless the release job failed at that one step.
//
// Env: GITHUB_TOKEN, GITHUB_REPOSITORY, RUN_ID, BRANCH (dev-X.Y.Z), CHANNEL
// (stable or beta). Optional: GITHUB_STEP_SUMMARY, FINISH_TRIES (default 20),
// FINISH_WAIT_MS (default 3000), DRY_RUN=1 (find and report, change nothing).

import { appendFileSync } from "node:fs";

const PUBLISH_STEP = "Publish the release";
const env = process.env;
const repo = env.GITHUB_REPOSITORY;
const tries = Number(env.FINISH_TRIES ?? 20);
const waitMs = Number(env.FINISH_WAIT_MS ?? 3000);
const dryRun = env.DRY_RUN === "1";

function say(line) {
  console.log(line);
  if (env.GITHUB_STEP_SUMMARY)
    appendFileSync(env.GITHUB_STEP_SUMMARY, `${line}\n`);
}

async function api(method, path, body) {
  const response = await fetch(`https://api.github.com/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(
      `${method} ${path}: ${response.status} ${await response.text()}`,
    );
  }
  if (response.status === 204 || response.status === 404) return null;
  return response.json();
}

/** Whether the run's release job failed at the publish step, and only there. */
async function failedAtPublish() {
  const { jobs } = await api(
    "GET",
    `repos/${repo}/actions/runs/${env.RUN_ID}/jobs?per_page=100`,
  );
  const failed = jobs.flatMap((job) =>
    job.steps
      .filter((step) => step.conclusion === "failure")
      .map((step) => step.name),
  );
  return failed.length === 1 && failed[0] === PUBLISH_STEP;
}

/** The draft the release job made: v<base>, or the newest v<base>-beta.N. */
async function findDraft(base, channel) {
  const wanted =
    channel === "beta"
      ? (tag) =>
          new RegExp(`^v${base.replace(/\./g, "\\.")}-beta\\.\\d+$`).test(tag)
      : (tag) => tag === `v${base}`;
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    const releases = await api("GET", `repos/${repo}/releases?per_page=100`);
    const drafts = releases.filter(
      (release) => release.draft && wanted(release.tag_name),
    );
    if (drafts.length > 0) {
      return drafts.sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
    }
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  return null;
}

async function main() {
  const base = /^dev-(\d+\.\d+\.\d+)$/.exec(env.BRANCH ?? "")?.[1];
  if (!base) throw new Error(`BRANCH must be dev-X.Y.Z, not ${env.BRANCH}`);
  const channel = env.CHANNEL === "beta" ? "beta" : "stable";

  if (!(await failedAtPublish())) {
    say(
      `The release job did not fail at "${PUBLISH_STEP}" alone, so there is no draft to finish.`,
    );
    return;
  }
  const draft = await findDraft(base, channel);
  if (!draft) throw new Error(`No draft for v${base} after ${tries} tries.`);

  const assets = draft.assets.map((asset) => asset.name);
  const pack = draft.assets.find((asset) => asset.name.endsWith(".tmxplug"));
  if (
    !pack ||
    !assets.some((name) => name.endsWith(".tmxplug.sigstore.json"))
  ) {
    throw new Error(
      `Draft ${draft.tag_name} lacks its .tmxplug or .sigstore.json: ${assets.join(", ")}`,
    );
  }
  say(
    `Found draft ${draft.tag_name} (id ${draft.id}, target ${draft.target_commitish}): ${assets.join(", ")}`,
  );
  if (dryRun) {
    say("DRY_RUN: published nothing.");
    return;
  }

  // As the shared step does: publishing creates the tag at the target commit.
  await api("PATCH", `repos/${repo}/releases/${draft.id}`, {
    draft: false,
    prerelease: channel === "beta",
    target_commitish: draft.target_commitish,
  });
  say(`Published ${draft.tag_name}.`);

  if (channel === "stable") {
    // The shared clean-up step, which the failed job never reached.
    const releases = await api("GET", `repos/${repo}/releases?per_page=100`);
    for (const release of releases) {
      if (release.tag_name.startsWith(`v${base}-beta.`)) {
        await api("DELETE", `repos/${repo}/releases/${release.id}`);
        say(`Deleted beta release ${release.tag_name}.`);
      }
    }
    await api("DELETE", `repos/${repo}/git/refs/heads/${env.BRANCH}`);
    say(`Deleted branch ${env.BRANCH}.`);
  }
  if (pack.digest) say(`Pack: ${pack.name} ${pack.digest}`);
}

main().catch((error) => {
  say(`release-finish: ${error.message}`);
  process.exit(1);
});
