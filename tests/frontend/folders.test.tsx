import { describe, expect, it } from "vitest";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  fakeApi,
  makeRunbook,
  makeSummary,
  pressEscape,
  useRenderedApp,
  type FakeApi,
} from "./helpers";
import type { RunbookListEntry } from "../../src/frontend/api-types";
import {
  groupRunbooks,
  titleMatches,
} from "../../src/frontend/runbooks/list-groups";

const render = useRenderedApp();

/** Titles like the real list: three projects, every state. */
const LIST: RunbookListEntry[] = [
  makeSummary({
    id: 1,
    title: "Try loader 0.48.1 on wyatt-pc",
    folder: "gbtvg-coop",
  }),
  makeSummary({
    id: 2,
    title: "Free disk space on test VM 2",
    folder: "gbtvg-coop",
  }),
  makeSummary({
    id: 3,
    title: "Images through the mirror",
    folder: "home-server",
  }),
  makeSummary({ id: 4, title: "Runbooks 1.4.10 release", folder: "termix" }),
  makeSummary({ id: 5, title: "Pi-hole over IPv6", folder: null }),
  makeSummary({
    id: 6,
    title: "Try loader 0.47.0 on test VM 1",
    folder: "GBTVG-coop",
    status: "done",
  }),
  makeSummary({
    id: 7,
    title: "Registry digests",
    folder: "home-server",
    status: "done",
  }),
  makeSummary({
    id: 8,
    title: "Old Pinchflat move",
    folder: null,
    status: "abandoned",
  }),
];

async function showList(
  options: {
    list?: RunbookListEntry[];
    listState?: unknown;
    client?: FakeApi;
  } = {},
) {
  const client =
    options.client ??
    fakeApi({
      list: options.list ?? LIST,
      detail: makeRunbook([], { id: 1, title: "Detail" }),
      listState: options.listState,
    });
  const app = await render(client);
  app.renderTab("runbooks", { isVisible: true });
  await screen.findByText("Try loader 0.48.1 on wyatt-pc");
  // The stored choices arrive after the list.
  await act(async () => {});
  return client;
}

const section = (status: string) =>
  document.querySelector(`[data-list-section="${status}"]`) as HTMLElement;
const toggle = (status: string) =>
  document.querySelector(`[data-section-toggle="${status}"]`) as HTMLElement;
const folders = (status: string) =>
  [...section(status).querySelectorAll("[data-list-folder]")].map((el) =>
    el.getAttribute("data-list-folder"),
  );
const folderRow = (status: string, folder: string) =>
  section(status).querySelector(
    `[data-list-folder="${folder}"] [aria-expanded]`,
  ) as HTMLElement;
const rowsIn = (status: string, folder: string) =>
  [
    ...section(status).querySelectorAll(
      `[data-list-folder="${folder}"] [data-runbook-row]`,
    ),
  ].map((el) => Number(el.getAttribute("data-runbook-row")));
const putBodies = (client: FakeApi) =>
  client.put.mock.calls
    .filter(([url]) => url === "/list-state")
    .map(([, body]) => body);

describe("the list's sections and folders (1.4.10)", () => {
  it("groups by state then folder, A to Z with No folder last, with counts", async () => {
    await showList();
    expect(
      [...document.querySelectorAll("[data-list-section]")].map((el) =>
        el.getAttribute("data-list-section"),
      ),
    ).toEqual(["open", "done", "abandoned"]);
    expect(
      [...document.querySelectorAll("[data-section-count]")].map(
        (el) => el.textContent,
      ),
    ).toEqual(["5", "2", "1"]);
    expect(folders("open")).toEqual([
      "gbtvg-coop",
      "home-server",
      "termix",
      "",
    ]);
    expect(rowsIn("open", "gbtvg-coop")).toEqual([1, 2]);
    expect(within(folderRow("open", "gbtvg-coop")).getByText("2")).toBeTruthy();
    expect(within(folderRow("open", "")).getByText("No folder")).toBeTruthy();
  });

  it("starts with Open expanded, Done and Abandoned collapsed, as buttons with aria-expanded", async () => {
    await showList();
    expect(toggle("open").tagName).toBe("BUTTON");
    expect(toggle("open").getAttribute("aria-expanded")).toBe("true");
    expect(toggle("done").getAttribute("aria-expanded")).toBe("false");
    expect(toggle("abandoned").getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Registry digests")).toBeNull();
    // The section is named by its heading.
    expect(
      screen.getByRole("heading", { name: /Done/ }).querySelector("button"),
    ).toBe(toggle("done"));
  });

  it("opens Done, joins two spellings of a folder, and keeps the choice", async () => {
    const client = await showList();
    fireEvent.click(toggle("done"));
    expect(toggle("done").getAttribute("aria-expanded")).toBe("true");
    expect(folders("done")).toEqual(["GBTVG-coop", "home-server"]);
    expect(rowsIn("done", "GBTVG-coop")).toEqual([6]);
    expect(putBodies(client).at(-1)).toEqual({ "section:done": false });
    fireEvent.click(toggle("open"));
    expect(section("open").querySelector("[data-runbook-row]")).toBeNull();
    expect(putBodies(client).at(-1)).toEqual({
      "section:done": false,
      "section:open": true,
    });
  });

  it("collapses a folder by click or keyboard, and keeps it per section", async () => {
    const client = await showList();
    const row = folderRow("open", "home-server");
    expect(row.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(row);
    expect(rowsIn("open", "home-server")).toEqual([]);
    expect(putBodies(client).at(-1)).toEqual({
      "folder:open:home-server": true,
    });
    fireEvent.keyDown(folderRow("open", "home-server"), { key: "Enter" });
    expect(rowsIn("open", "home-server")).toEqual([3]);
    expect(putBodies(client).at(-1)).toEqual({
      "folder:open:home-server": false,
    });
  });

  it("shows what the person chose before, from the server", async () => {
    const client = await showList({
      listState: {
        "section:done": false,
        "section:abandoned": false,
        "folder:open:termix": true,
        "folder:done:gbtvg-coop": true,
      },
    });
    expect(client.get).toHaveBeenCalledWith("/list-state");
    await waitFor(() =>
      expect(toggle("done").getAttribute("aria-expanded")).toBe("true"),
    );
    expect(toggle("abandoned").getAttribute("aria-expanded")).toBe("true");
    expect(rowsIn("open", "termix")).toEqual([]);
    expect(folderRow("open", "termix").getAttribute("aria-expanded")).toBe(
      "false",
    );
    // One folder in other letters is one choice.
    expect(rowsIn("done", "GBTVG-coop")).toEqual([]);
    expect(rowsIn("done", "home-server")).toEqual([7]);
    expect(putBodies(client)).toEqual([]);
  });

  it("works when the stored choices cannot be read: the defaults hold", async () => {
    const client = fakeApi({
      list: LIST,
      detail: makeRunbook([], { id: 1 }),
      get: (url) => (url === "/list-state" ? "not a state" : undefined),
    });
    await showList({ client });
    expect(toggle("open").getAttribute("aria-expanded")).toBe("true");
    expect(toggle("done").getAttribute("aria-expanded")).toBe("false");
  });
});

describe("the list's search (1.4.10)", () => {
  it("filters titles across sections and opens what matches, without keeping it", async () => {
    const client = await showList();
    const box = screen.getByPlaceholderText("Search runbook titles");
    fireEvent.change(box, { target: { value: "loader" } });
    expect(toggle("done").getAttribute("aria-expanded")).toBe("true");
    expect(section("abandoned")).toBeNull();
    expect(rowsIn("open", "gbtvg-coop")).toEqual([1]);
    expect(rowsIn("done", "GBTVG-coop")).toEqual([6]);
    expect(
      [...document.querySelectorAll("[data-section-count]")].map(
        (el) => el.textContent,
      ),
    ).toEqual(["1", "1"]);
    // A toggle while searching is not kept.
    fireEvent.click(toggle("done"));
    expect(toggle("done").getAttribute("aria-expanded")).toBe("false");
    expect(putBodies(client)).toEqual([]);
    fireEvent.change(box, { target: { value: "nothing like it" } });
    expect(document.querySelector("[data-list-section]")).toBeNull();
    expect(screen.getByText(/No runbook title matches/)).toBeTruthy();
    fireEvent.change(box, { target: { value: "" } });
    expect(toggle("done").getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText("Pi-hole over IPv6")).toBeTruthy();
  });

  it("matches every word, in any letters", () => {
    expect(titleMatches("Try loader 0.48.1 on wyatt-pc", "LOADER wyatt")).toBe(
      true,
    );
    expect(titleMatches("Try loader 0.48.1 on wyatt-pc", "loader vm")).toBe(
      false,
    );
    expect(groupRunbooks(LIST, "mirror")).toEqual([
      {
        status: "open",
        count: 1,
        folders: [{ folder: "home-server", rows: [LIST[2]] }],
      },
    ]);
  });
});

describe("Move to folder and Rename folder (1.4.10)", () => {
  function client(posts: Array<[string, unknown]>) {
    return fakeApi({
      list: LIST,
      detail: makeRunbook([], { id: 5, title: "Pi-hole over IPv6" }),
      post: async (url, body) => {
        posts.push([url, body]);
        return { data: makeRunbook([], { id: 5 }) };
      },
    });
  }

  it("moves a row's runbook to an existing folder, from the row's actions", async () => {
    const posts: Array<[string, unknown]> = [];
    await showList({ client: client(posts) });
    const action = document.querySelector('[data-move-folder="5"]')!;
    expect(action.getAttribute("aria-label")).toBe("Move to folder");
    fireEvent.click(action);
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain(
      'Move "Pi-hole over IPv6" to a folder',
    );
    expect(dialog.textContent).toContain("It is in no folder now.");
    expect(
      [...dialog.querySelectorAll("[data-folder-choice]")].map(
        (el) => el.textContent,
      ),
    ).toEqual(["gbtvg-coop", "home-server", "termix"]);
    // No folder is offered only to a runbook in one.
    expect(dialog.querySelector("[data-move-none]")).toBeNull();
    const move = dialog.querySelector(
      "[data-move-confirm]",
    ) as HTMLButtonElement;
    expect(move.disabled).toBe(true);
    fireEvent.click(
      dialog.querySelector('[data-folder-choice="home-server"]')!,
    );
    expect(
      dialog
        .querySelector('[data-folder-choice="home-server"]')!
        .getAttribute("aria-pressed"),
    ).toBe("true");
    fireEvent.click(move);
    await waitFor(() =>
      expect(posts).toEqual([
        ["/runbooks/5/folder", { folder: "home-server" }],
      ]),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("takes a new name, says what is wrong with a bad one, and moves to No folder", async () => {
    const posts: Array<[string, unknown]> = [];
    await showList({ client: client(posts) });
    fireEvent.click(document.querySelector('[data-move-folder="3"]')!);
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("It is in home-server now.");
    const box = dialog.querySelector("[data-folder-name]") as HTMLInputElement;
    expect(box.value).toBe("home-server");
    const note = () => dialog.querySelector("[data-folder-note]")!.textContent;
    const move = dialog.querySelector(
      "[data-move-confirm]",
    ) as HTMLButtonElement;
    fireEvent.change(box, { target: { value: "home-server/registry" } });
    expect(note()).toContain('no "/"');
    expect(box.getAttribute("aria-invalid")).toBe("true");
    expect(move.disabled).toBe(true);
    fireEvent.change(box, { target: { value: "x".repeat(61) } });
    expect(note()).toContain("at most 60");
    fireEvent.change(box, { target: { value: "TERMIX" } });
    expect(note()).toBe("Same folder as termix: it goes there.");
    fireEvent.change(box, { target: { value: "  Registry  " } });
    fireEvent.submit(box.closest("form")!);
    await waitFor(() =>
      expect(posts).toEqual([["/runbooks/3/folder", { folder: "Registry" }]]),
    );
    fireEvent.click(document.querySelector('[data-move-folder="3"]')!);
    const again = await screen.findByRole("dialog");
    fireEvent.click(again.querySelector("[data-move-none]")!);
    await waitFor(() =>
      expect(posts.at(-1)).toEqual(["/runbooks/3/folder", { folder: null }]),
    );
  });

  it("cancels with Esc and sends nothing", async () => {
    const posts: Array<[string, unknown]> = [];
    await showList({ client: client(posts) });
    fireEvent.click(document.querySelector('[data-move-folder="1"]')!);
    await pressEscape("dialog");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(posts).toEqual([]);
  });

  it("renames a folder from its row; the name must change", async () => {
    const posts: Array<[string, unknown]> = [];
    await showList({ client: client(posts) });
    // No folder has no rename.
    expect(
      folderRow("open", "").querySelector("[data-rename-folder]"),
    ).toBeNull();
    const action = folderRow("open", "gbtvg-coop").querySelector(
      "[data-rename-folder]",
    )!;
    expect(action.getAttribute("aria-label")).toBe("Rename folder gbtvg-coop");
    fireEvent.click(action);
    const dialog = await screen.findByRole("dialog");
    // The click did not toggle the folder.
    expect(rowsIn("open", "gbtvg-coop")).toEqual([1, 2]);
    expect(dialog.textContent).toContain("Rename folder gbtvg-coop");
    const box = dialog.querySelector("[data-folder-name]") as HTMLInputElement;
    const rename = dialog.querySelector(
      "[data-rename-confirm]",
    ) as HTMLButtonElement;
    expect(rename.disabled).toBe(true);
    fireEvent.change(box, { target: { value: "Home-Server" } });
    expect(dialog.querySelector("[data-folder-note]")!.textContent).toBe(
      "Same folder as home-server: it goes there.",
    );
    fireEvent.change(box, { target: { value: "Ghostbusters mod" } });
    fireEvent.click(rename);
    await waitFor(() =>
      expect(posts).toEqual([
        ["/folders/rename", { from: "gbtvg-coop", to: "Ghostbusters mod" }],
      ]),
    );
  });

  it("moves the open runbook from its page, with the folders there are", async () => {
    const posts: Array<[string, unknown]> = [];
    const runbook = makeRunbook([], {
      id: 6,
      title: "Try loader 0.47.0 on test VM 1",
      status: "done",
      folder: "GBTVG-coop",
    });
    const api = fakeApi({
      list: LIST,
      detail: runbook,
      post: async (url, body) => {
        posts.push([url, body]);
        return { data: { ...runbook, folder: "Ghostbusters mod" } };
      },
    });
    const app = await render(api);
    app.renderTab("runbooks", { isVisible: true });
    await screen.findByText("Pi-hole over IPv6");
    fireEvent.click(toggle("done"));
    fireEvent.click(screen.getByText("Try loader 0.47.0 on test VM 1"));
    await screen.findByRole("heading", {
      name: "Try loader 0.47.0 on test VM 1",
    });
    expect(document.querySelector("[data-runbook-folder]")!.textContent).toBe(
      "GBTVG-coop",
    );
    fireEvent.click(document.querySelector("[data-runbook-move]")!);
    const dialog = await screen.findByRole("dialog");
    expect(api.get).toHaveBeenCalledWith("/folders");
    expect(
      [...dialog.querySelectorAll("[data-folder-choice]")].map(
        (el) => el.textContent,
      ),
    ).toEqual(["gbtvg-coop", "home-server", "termix"]);
    fireEvent.change(dialog.querySelector("[data-folder-name]")!, {
      target: { value: "Ghostbusters mod" },
    });
    fireEvent.click(dialog.querySelector("[data-move-confirm]")!);
    await waitFor(() =>
      expect(posts).toEqual([
        ["/runbooks/6/folder", { folder: "Ghostbusters mod" }],
      ]),
    );
    await waitFor(() =>
      expect(document.querySelector("[data-runbook-folder]")!.textContent).toBe(
        "Ghostbusters mod",
      ),
    );
  });
});
