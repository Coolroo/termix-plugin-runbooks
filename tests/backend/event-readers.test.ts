/**
 * 1.4.10, phase 3: the readers of the wait events, on real output captured
 * from our hosts and tools (fixtures/event-readers.json: home-server's
 * Docker, systemd and stat as the sandbox user, and Termix 26.11.3's ssh2
 * against an OpenSSH 10.0 server with the key options Termix's key has
 * today and after home-server T-279).
 */
import { describe, expect, it } from "vitest";
import tls from "node:tls";
import {
  matchLog,
  parseUnitShow,
  readContainer,
  readDockerLogs,
  readForward,
  readHttp,
  readJournal,
  readLogError,
  readPlatform,
  readSftpStat,
  readSudoStat,
  readUnit,
  FORWARD_REFUSED,
  type ContainerMemory,
} from "../../src/backend/events/readers";
import {
  caBundleProblem,
  pemBlocks,
  trustedCas,
} from "../../src/backend/events/trust";
import fixtures from "./fixtures/event-readers.json";

const inspect = fixtures.dockerInspect;
const show = fixtures.systemctlShow;
const fresh = () => ({ restarts: null }) as ContainerMemory;

describe("container: docker container inspect", () => {
  it("reads starting, healthy and unhealthy from a container with a HEALTHCHECK", () => {
    expect(readContainer(inspect.starting, "healthy", fresh())).toEqual({
      verdict: "wait",
      result: "starting",
    });
    expect(readContainer(inspect.healthy, "healthy", fresh())).toEqual({
      verdict: "pass",
      result: "healthy",
    });
    expect(readContainer(inspect.unhealthy, "healthy", fresh())).toEqual({
      verdict: "wait",
      result: "unhealthy",
    });
    // Running is running, healthy or not yet.
    expect(readContainer(inspect.starting, "running", fresh()).verdict).toBe(
      "pass",
    );
  });

  it("fails at once when the container exited while it waits for healthy or running", () => {
    for (const state of ["healthy", "running"] as const) {
      const reading = readContainer(inspect["exited-3"], state, fresh());
      expect(reading.verdict).toBe("fail");
      expect(reading.result).toBe("exited (3)");
      expect(reading.error).toContain("exited with code 3");
    }
    // Stopped by docker stop: 137.
    expect(readContainer(inspect.stopped, "running", fresh()).result).toBe(
      "exited (137)",
    );
  });

  it("passes exited on an exited container and waits on a running one", () => {
    expect(readContainer(inspect["exited-3"], "exited", fresh())).toEqual({
      verdict: "pass",
      result: "exited (3)",
    });
    expect(
      readContainer(inspect["running-no-health"], "exited", fresh()).verdict,
    ).toBe("wait");
  });

  it("fails at once when the restart count grows while it waits", () => {
    const memory = fresh();
    // A crash loop: restarting, count 5 at the first check.
    const first = readContainer(inspect.restarting, "running", memory);
    expect(first).toEqual({
      verdict: "wait",
      result: "restarting (restart 5)",
    });
    expect(memory.restarts).toBe(5);
    const grown = inspect.restarting.stdout.replace(
      '"RestartCount":5',
      '"RestartCount":6',
    );
    const second = readContainer(
      { ...inspect.restarting, stdout: grown },
      "running",
      memory,
    );
    expect(second.verdict).toBe("fail");
    expect(second.error).toContain("restart count 5 → 6");
  });

  it("refuses healthy for a container with no health check", () => {
    const reading = readContainer(
      inspect["running-no-health"],
      "healthy",
      fresh(),
    );
    expect(reading.verdict).toBe("fail");
    expect(reading.error).toContain('wait for state "running" instead');
  });

  it("reads a missing container: gone passes, the others wait", () => {
    expect(readContainer(inspect.missing, "gone", fresh())).toEqual({
      verdict: "pass",
      result: "not found",
    });
    expect(readContainer(inspect.missing, "healthy", fresh())).toEqual({
      verdict: "wait",
      result: "not found",
    });
    expect(readContainer(inspect.healthy, "gone", fresh()).verdict).toBe(
      "wait",
    );
  });

  it("fails at once when the SSH user may not use Docker", () => {
    const reading = readContainer(
      {
        stdout: "",
        stderr:
          "permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock\n",
        code: 1,
      },
      "running",
      fresh(),
    );
    expect(reading.verdict).toBe("fail");
    expect(reading.error).toContain("docker group");
  });

  it("keeps only plain words from the host in the result", () => {
    const odd = inspect.healthy.stdout.replace(
      '"Status":"healthy"',
      '"Status":"<b>secret text</b>"',
    );
    expect(
      readContainer({ ...inspect.healthy, stdout: odd }, "healthy", fresh())
        .result,
    ).toBe("unknown");
  });
});

describe("unit: systemctl show --timestamp=unix", () => {
  // The exits in the captures are at @1795471893 and @1795472099.
  const before = 1795471880;
  const after = 1795471900;

  it("parses key=value lines in systemd's own order", () => {
    expect(parseUnitShow(show["t038-fail"].stdout)).toMatchObject({
      LoadState: "loaded",
      ActiveState: "failed",
      Result: "exit-code",
      ExecMainStatus: "3",
      ExecMainExitTimestamp: "@1795471893",
    });
  });

  it("passes active on a running unit", () => {
    expect(readUnit(show["t038-run"], "active", before)).toEqual({
      verdict: "pass",
      result: "active (running)",
    });
  });

  it("passes finished on a unit that ended with success after the step started", () => {
    expect(readUnit(show["t038-ok"], "finished", before)).toEqual({
      verdict: "pass",
      result: "finished (success)",
    });
    // The same end before the step started is an earlier run: not yet.
    const stale = readUnit(show["t038-ok"], "finished", after);
    expect(stale.verdict).toBe("wait");
    expect(stale.result).toContain("not run since the step started");
  });

  it("fails at once on a unit that failed after the step started", () => {
    const reading = readUnit(show["t038-fail"], "finished", before);
    expect(reading).toMatchObject({
      verdict: "fail",
      result: "failed (exit-code, status 3)",
    });
    expect(reading.error).toContain("Result=exit-code, exit status 3");
    expect(readUnit(show["t038-fail"], "active", before).verdict).toBe("fail");
    // An old failure does not fail a wait for it to come up.
    expect(readUnit(show["t038-fail"], "active", after).verdict).toBe("wait");
  });

  it("waits on a unit that is starting or restarting", () => {
    expect(readUnit(show.activating, "finished", before)).toEqual({
      verdict: "wait",
      result: "activating (start)",
    });
    expect(readUnit(show["auto-restart"], "active", before)).toEqual({
      verdict: "wait",
      result: "activating (auto-restart)",
    });
    expect(readUnit(show["t038-run"], "finished", before).verdict).toBe("wait");
  });

  it("fails at once on a unit that is not loaded, with words for a transient unit", () => {
    for (const key of ["nosuch-t038", "oneshot-done"] as const) {
      const reading = readUnit(show[key], "finished", before);
      expect(reading.verdict).toBe("fail");
      expect(reading.error).toContain("use a job item");
    }
  });

  it("fails at once when systemctl does not know --timestamp", () => {
    const reading = readUnit(
      {
        stdout: "",
        stderr: "systemctl: unrecognized option '--timestamp=unix'\n",
        code: 1,
      },
      "active",
      before,
    );
    expect(reading.verdict).toBe("fail");
  });
});

describe("log: docker logs and journalctl -o json", () => {
  it("reads docker logs --timestamps in time order, each line once", () => {
    const first = readDockerLogs(fixtures.dockerLogs.timestamps, null);
    expect(first.lines).toEqual([
      "error: config invalid",
      "first line",
      "ready to serve",
    ]);
    expect(first.last).toBe("2026-11-23T22:14:49.602996781Z");
    // The next check asks --since the last time: that line comes again
    // and is dropped.
    const again = readDockerLogs(
      {
        stdout:
          "2026-11-23T22:14:49.602996781Z ready to serve\n2026-11-23T22:14:50.000000001Z next\n",
        stderr: "",
        code: 0,
      },
      first.last,
    );
    expect(again.lines).toEqual(["next"]);
  });

  it("reads MESSAGE and the cursor from journalctl -o json --output-fields=MESSAGE", () => {
    const read = readJournal(fixtures.journal["fields-cursor"].stdout);
    expect(read.lines[1]).toBe("oneshot runs");
    expect(read.cursor).toMatch(/^s=/);
    const next = readJournal(fixtures.journal["after-cursor-new"].stdout);
    expect(next.lines[0]).toBe("oneshot ends");
    // The full JSON (without --output-fields) reads the same.
    expect(readJournal(fixtures.journal.ok.stdout).lines).toContain(
      "job says hello",
    );
    expect(readJournal(fixtures.journal.none.stdout)).toEqual({
      lines: [],
      cursor: null,
    });
  });

  it("reads a MESSAGE written as bytes", () => {
    const bytes = [...Buffer.from("café ready")];
    expect(
      readJournal(`{"MESSAGE":${JSON.stringify(bytes)},"__CURSOR":"c1"}\n`),
    ).toEqual({ lines: ["café ready"], cursor: "c1" });
  });

  it("matches new lines in order: failPattern first, then pattern", () => {
    const lines = readDockerLogs(fixtures.dockerLogs.timestamps, null).lines;
    expect(matchLog(lines, /ready to serve/, null, 0)).toEqual({
      verdict: "pass",
      result: "matched",
    });
    const failed = matchLog(lines, /ready to serve/, /^error:/, 0);
    expect(failed.verdict).toBe("fail");
    expect(failed.error).toContain("failPattern");
    expect(matchLog(lines, /listening/, null, 4)).toEqual({
      verdict: "wait",
      result: "no match yet (7 new lines)",
    });
  });

  it("reads a missing container and a refused sudo", () => {
    expect(readLogError(fixtures.dockerLogs.missing, "container")).toEqual({
      verdict: "wait",
      result: "not found",
    });
    expect(readLogError(fixtures.sudoRefused, "unit")).toMatchObject({
      verdict: "fail",
      result: "sudo refused",
    });
    expect(readLogError(fixtures.dockerLogs.since, "container")).toBeNull();
  });
});

describe("file: SFTP stat and sudo stat", () => {
  const sftp = fixtures.ssh2.sftp;

  it("reads ssh2's stat attributes", () => {
    expect(readSftpStat(sftp.file, "exists")).toEqual({
      verdict: "pass",
      result: "file exists, 13 bytes",
    });
    expect(readSftpStat(sftp.empty, "nonEmpty")).toEqual({
      verdict: "wait",
      result: "file exists, 0 bytes",
    });
    expect(readSftpStat(sftp.file, "nonEmpty").verdict).toBe("pass");
    expect(readSftpStat(sftp.dir, "exists").result).toBe("directory exists");
    expect(readSftpStat(sftp.dir, "nonEmpty").verdict).toBe("fail");
    expect(readSftpStat(sftp.file, "gone").verdict).toBe("wait");
    // SFTP works with Termix's key as it is today (no-port-forwarding).
    expect(readSftpStat(sftp.withNoPortForwardingKey, "exists").verdict).toBe(
      "pass",
    );
  });

  it("reads ssh2's errors: no such file, permission denied", () => {
    expect(readSftpStat(sftp.missing, "gone")).toEqual({
      verdict: "pass",
      result: "not there",
    });
    expect(readSftpStat(sftp.missing, "exists").verdict).toBe("wait");
    const denied = readSftpStat(sftp.denied, "exists");
    expect(denied.verdict).toBe("fail");
    expect(denied.error).toContain("sudo: true");
  });

  it("reads stat -c '%s %F' and its errors", () => {
    const stat = fixtures.stat;
    expect(readSudoStat(stat.file, "exists").result).toBe(
      "file exists, 6 bytes",
    );
    expect(readSudoStat(stat.empty, "nonEmpty").verdict).toBe("wait");
    expect(readSudoStat(stat.dir, "exists").result).toBe("directory exists");
    expect(readSudoStat(stat.nosuch, "gone").verdict).toBe("pass");
    expect(readSudoStat(stat.nosuch, "exists")).toEqual({
      verdict: "wait",
      result: "not there",
    });
    expect(readSudoStat(stat.denied, "exists").verdict).toBe("fail");
    expect(readSudoStat(fixtures.sudoRefused, "exists")).toMatchObject({
      verdict: "fail",
      result: "sudo refused",
    });
  });
});

describe("port: forwardOut", () => {
  const forward = fixtures.ssh2.forward;

  it("reads a channel that opened as open", () => {
    expect(forward.open.ok).toBe(true);
    expect(readForward(null, "open")).toEqual({
      verdict: "pass",
      result: "port open",
    });
    expect(readForward(null, "closed").verdict).toBe("wait");
  });

  it("reads connect failed (reason 2) as closed", () => {
    expect(forward.closed.error.reason).toBe(2);
    expect(readForward(forward.closed.error, "closed")).toEqual({
      verdict: "pass",
      result: "port closed",
    });
    expect(readForward(forward.closed.error, "open").verdict).toBe("wait");
  });

  it("fails at once on administratively prohibited (reason 1), never as closed", () => {
    // Today's key (no-port-forwarding), and an address the new key's
    // permitopen does not allow: both say only "open failed".
    for (const failure of [
      forward.noPortForwardingKey.error,
      forward.otherAddress.error,
    ]) {
      expect(failure.message).toBe("(SSH) Channel open failure: open failed");
      for (const state of ["open", "closed"] as const) {
        expect(readForward(failure, state)).toEqual({
          verdict: "fail",
          result: "forwarding refused",
          error: FORWARD_REFUSED,
        });
      }
    }
  });
});

describe("http: the answer and TLS", () => {
  const item = { status: 200, contains: null };

  it("passes on the status, and checks contains in the body", () => {
    expect(readHttp({ status: 200, body: "ok\n" }, item)).toEqual({
      verdict: "pass",
      result: "HTTP 200",
    });
    expect(readHttp({ status: 503, body: "" }, item)).toEqual({
      verdict: "wait",
      result: "HTTP 503",
    });
    expect(
      readHttp(
        { status: 200, body: "starting" },
        { status: 200, contains: "ok" },
      ),
    ).toEqual({ verdict: "wait", result: "HTTP 200, text not found" });
  });

  it("reads Node's certificate errors as words, and waits", () => {
    const tlsFixtures = fixtures.ssh2.tls;
    expect(
      readHttp({ error: tlsFixtures.publicRootsOnly.error }, item),
    ).toEqual({ verdict: "wait", result: "certificate not trusted" });
    expect(readHttp({ error: tlsFixtures.wrongName.error }, item)).toEqual({
      verdict: "wait",
      result: "certificate name mismatch",
    });
  });

  it("fails at once on a refused forward and waits on a closed port", () => {
    const forward = fixtures.ssh2.forward;
    expect(
      readHttp({ error: forward.noPortForwardingKey.error }, item).verdict,
    ).toBe("fail");
    expect(readHttp({ error: forward.closed.error }, item)).toEqual({
      verdict: "wait",
      result: "port closed",
    });
  });
});

describe("platform: the SSH server's version string", () => {
  it("reads Windows OpenSSH and Bitvise as Windows, ours as other", () => {
    expect(readPlatform(fixtures.ssh2.remoteVer)).toBe("other");
    expect(readPlatform("OpenSSH_for_Windows_9.5")).toBe("windows");
    expect(
      readPlatform("9.32 FlowSsh: Bitvise SSH Server (WinSSHD) 9.32"),
    ).toBe("windows");
    expect(readPlatform(undefined)).toBeNull();
  });
});

describe("Extra trusted CAs", () => {
  const ca = `-----BEGIN CERTIFICATE-----
MIIBljCCATygAwIBAgIUY3vUjbqI8YxW0n3o4oRZ1D2w3XUwCgYIKoZIzj0EAwIw
GzEZMBcGA1UEAwwQUnVuYm9va3MgdGVzdCBDQTAeFw0yNjExMjMyMjEwMDBaFw0z
NjExMjEyMjEwMDBaMBsxGTAXBgNVBAMMEFJ1bmJvb2tzIHRlc3QgQ0EwWTATBgcq
hkjOPQIBBggqhkjOPQMBBwNCAAQ=
-----END CERTIFICATE-----`;

  it("takes empty, refuses keys and text that is not a certificate", () => {
    expect(caBundleProblem("")).toBeNull();
    expect(caBundleProblem(undefined)).toBeNull();
    expect(caBundleProblem("hello")).toContain("BEGIN CERTIFICATE");
    expect(caBundleProblem("-----BEGIN PRIVATE KEY-----\nx")).toContain(
      "private key",
    );
    expect(caBundleProblem(ca)).toContain("cannot be read");
  });

  it("adds the setting's certificates to the public roots, never instead of them", () => {
    expect(trustedCas("")).toHaveLength(tls.rootCertificates.length);
    expect(trustedCas("not pem")).toHaveLength(tls.rootCertificates.length);
    expect(pemBlocks(`${ca}\n${ca}`)).toHaveLength(2);
  });
});
