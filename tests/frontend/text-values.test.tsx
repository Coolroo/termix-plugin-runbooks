import { describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { Markdown } from "../../src/frontend/ui/Markdown";
import { fillMarkdown } from "../../src/shared/fill";
import {
  card,
  clickStep,
  fakeApi,
  locales,
  makeRunbook,
  openRunbook,
  useRenderedApp,
} from "./helpers";

useRenderedApp();

// A captured value that tries to add Markdown of its own.
const NASTY =
  "[x](https://e.example) ![i](https://e.example/a.png) **b** _u_ <b>hi</b> https://e.example";

const runbook = makeRunbook(
  [
    clickStep({
      id: 1,
      title: "Approve the route",
      body: "In the admin console, find `{{ts_ip}}` and approve it.\n\n```\ntailscale ping {{ts_ip}}\n```",
      expect: "The machine {{ts_ip}} shows **Connected**.",
    }),
    clickStep({
      id: 2,
      title: "Check the key",
      body: "Find the key of {{node_key}} in the list.",
      expect: "`{{node_key}}` shows as approved.",
    }),
    clickStep({
      id: 3,
      title: "Read the banner",
      body: "The banner said: {{banner}}\n\nIn code: `{{banner}}`",
    }),
    clickStep({
      id: 4,
      title: "Fetch",
      hostId: 1,
      hostName: "web-1",
      command: "fetch app-{{ver}}.tgz",
      resolvedCommand: "fetch app-1.2.3.tgz",
      commandHash: "a".repeat(64),
      body: "Fetch for {{later}}.",
    }),
    clickStep({
      id: 5,
      title: "Check in the browser",
      command: "Get-Item {{ver}}",
      resolvedCommand: "Get-Item 1.2.3",
      where: "browser on {{ts_ip}}",
    }),
  ],
  {
    title: "Tailnet",
    createdAt: "2026-11-11T10:00:00.000Z",
    updatedAt: "2026-11-11T10:05:00.000Z",
    progress: { done: 0, failed: 0, total: 4 },
    values: { ts_ip: "100.64.0.7" },
    effectiveValues: [
      { name: "ts_ip", value: "100.64.0.7", source: "author" },
      { name: "banner", value: NASTY, source: "capture", stepId: 9, runId: 3 },
      { name: "ver", value: "1.2.3", source: "capture", stepId: 9, runId: 3 },
    ],
    nextStepId: 1,
  },
);

const api = () => fakeApi({ detail: runbook });

const open = (client: ReturnType<typeof api>) =>
  openRunbook(client, { title: "Tailnet", shows: "Approve the route" });

describe("values in a step's text (1.4.3)", () => {
  it("shows a click step's body and expect with the value, and Copy copies it", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    await open(api());
    const text = card(1).textContent!;
    expect(text).toContain("find 100.64.0.7 and approve it");
    expect(text).toContain("The machine 100.64.0.7 shows Connected.");
    expect(text).not.toContain("{{");
    expect(card(1).querySelector("code")!.textContent).toBe("100.64.0.7");
    expect(card(1).querySelector("strong")!.textContent).toBe("Connected");
    expect(card(1).querySelector("[data-missing]")).toBeNull();
    const block = card(1).querySelector("[data-code-block]")!;
    fireEvent.click(block.querySelector("[data-copy]")!);
    expect(writeText).toHaveBeenCalledWith("tailscale ping 100.64.0.7");
  });

  it("marks a value not set yet, names it, and keeps Done and Failed", async () => {
    const client = api();
    await open(client);
    const marker = "(value node_key: not set yet)";
    expect(card(2).textContent).toContain(`Find the key of ${marker} in`);
    expect(card(2).querySelector("code")!.textContent).toBe(marker);
    const line = card(2).querySelector("[data-missing]")!;
    expect(line.textContent).toBe(
      locales.step.missingText.replace("{{names}}", "node_key"),
    );
    const done = card(2).querySelector<HTMLButtonElement>(
      '[data-manual="done"]',
    )!;
    expect(done.disabled).toBe(false);
    expect(
      card(2).querySelector<HTMLButtonElement>('[data-manual="failed"]')!
        .disabled,
    ).toBe(false);
    fireEvent.click(done);
    await vi.waitFor(() =>
      expect(client.post).toHaveBeenCalledWith("/steps/2/manual", {
        outcome: "done",
        note: "",
      }),
    );
  });

  it("shows a captured value as text: no link, image, emphasis or HTML", async () => {
    await open(api());
    const shown = card(3);
    expect(shown.querySelector("a")).toBeNull();
    expect(shown.querySelector("img")).toBeNull();
    expect(shown.querySelector("strong, em, b, h1")).toBeNull();
    expect(shown.textContent).toContain(`The banner said: ${NASTY}`);
    // Raw in the code span.
    expect(shown.querySelector("code")!.textContent).toBe(NASTY);
  });

  it("leaves commands as they were: a value missing from the text does not stop Run", async () => {
    await open(api());
    const run = [...card(4).querySelectorAll("button")].find(
      (button) => button.textContent === locales.step.run,
    )!;
    expect(run.disabled).toBe(false);
    expect(card(4).querySelector("pre")!.textContent).toBe(
      "fetch app-1.2.3.tgz",
    );
    expect(card(4).querySelector("[data-missing]")!.textContent).toBe(
      locales.step.missingText.replace("{{names}}", "later"),
    );
  });

  it("fills where in the outside label, as plain text", async () => {
    await open(api());
    expect(card(5).querySelector("[data-outside-where]")!.textContent).toBe(
      "Run outside Termix: browser on 100.64.0.7",
    );
  });
});

describe("escaped values render as the same characters", () => {
  const cases = [
    "[x](https://e.example)",
    "![i](https://e.example/a.png)",
    "# Heading",
    "- item",
    "1. item",
    "> quote",
    "*em* **strong** _u_ ~~s~~",
    "<b>hi</b><script>x()</script>",
    "&amp; &lt;",
    "https://e.example www.e.example a@b.example",
    "a | b | c",
    "`tick` and ``two``",
    "back\\slash \\* star",
  ];
  for (const value of cases) {
    it(`shows ${JSON.stringify(value)} as text`, () => {
      const { text } = fillMarkdown("{{v}}", { v: value });
      const { container, unmount } = render(<Markdown source={text} />);
      const root = container.firstElementChild!;
      expect(
        root.querySelector(
          "a, img, h1, h2, h3, ul, ol, blockquote, em, strong, del, b, script, code, table",
        ),
      ).toBeNull();
      expect(root.textContent).toBe(value);
      unmount();
    });
  }

  it("keeps a link the author wrote around a value", () => {
    const { text } = fillMarkdown(
      "[Open]({{url}}) or https://{{ip}}:8443/ or <https://{{ip}}/x>",
      { url: "https://admin.e.example/m?a=1&b_c=(2)", ip: "100.64.0.7" },
    );
    const { container } = render(<Markdown source={text} />);
    const links = [...container.querySelectorAll("a")].map((a) =>
      a.getAttribute("href"),
    );
    expect(links).toEqual([
      "https://admin.e.example/m?a=1&b_c=(2)",
      "https://100.64.0.7:8443/",
      "https://100.64.0.7/x",
    ]);
  });

  it("shows a backtick value in a code span and a fence exactly", () => {
    const value = "a`b``c ```";
    const inline = fillMarkdown("`{{v}}`", { v: value }).text;
    const fenced = fillMarkdown("```\n{{v}}\n```", { v: "x\n```\ny" }).text;
    const { container } = render(
      <>
        <Markdown source={inline} />
        <Markdown source={fenced} />
      </>,
    );
    const codes = container.querySelectorAll("code");
    expect(codes[0].textContent).toBe(value);
    expect(codes[1].textContent).toBe("x\n```\ny\n");
  });
});
