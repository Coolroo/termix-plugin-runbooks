import { describe, expect, it } from "vitest";
import { TOOLS } from "../../src/backend/agents/mcp/tools";
import { APP_FIELD, APP_PART } from "../../src/shared/secret-steps";
import { LIBRARY_REF, NAME } from "../../src/shared/names";

// The schemas are plain objects; reading them deeply is the point.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Schema = any;

function stepSchema(): Schema {
  const create = TOOLS.find((tool) => tool.name === "create_runbook");
  return (create!.inputSchema as Schema).properties.steps.items;
}

describe("MCP schema patterns", () => {
  it("match the regular expressions the server checks with", () => {
    const step = stepSchema().properties;
    expect(step.captures.items.properties.name.pattern).toBe(NAME.source);
    expect(step.secretCaptures.items.properties.name.pattern).toBe(NAME.source);
    expect(step.generate.properties.name.pattern).toBe(NAME.source);
    expect(step.ask.properties.name.pattern).toBe(NAME.source);
    for (const kind of ["generate", "ask"]) {
      const [, library, app] = step[kind].properties.store.oneOf;
      expect(library.properties.library.pattern).toBe(LIBRARY_REF.source);
      expect(app.properties.field.pattern).toBe(APP_FIELD.source);
    }
  });

  it("takes the library paths the server takes, and refuses the others", () => {
    const pattern = new RegExp(
      stepSchema().properties.generate.properties.store.oneOf[1].properties
        .library.pattern,
    );
    for (const ref of [
      "mine/db",
      "shared/registry/password",
      "mine/a/b/c/d",
      "mine/a/b/c/d/e",
      "shared/",
      "mine//x",
      "other/x",
      `mine/${"x".repeat(201)}`,
    ]) {
      expect(pattern.test(ref)).toBe(LIBRARY_REF.test(ref));
    }
  });

  it("takes an app path when the server takes each of its parts", () => {
    const pattern = new RegExp(
      stepSchema().properties.ask.properties.store.oneOf[2].properties.app
        .pattern,
    );
    for (const app of [
      "grafana/home-server",
      "a/b",
      "a",
      "a/b/c",
      "a b/c",
      `${"x".repeat(65)}/y`,
    ]) {
      const parts = app.split("/");
      expect(pattern.test(app)).toBe(
        parts.length === 2 && parts.every((part) => APP_PART.test(part)),
      );
    }
  });
});
