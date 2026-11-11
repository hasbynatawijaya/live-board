import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type Page } from "@playwright/test";

async function openTwo(browser: Browser) {
  const board = `e2e-${Math.random().toString(36).slice(2, 10)}`;
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();
  await a.goto(`/?board=${board}`);
  await b.goto(`/?board=${board}`);
  await expect(a.getByRole("status")).toHaveText("Live");
  await expect(b.getByRole("status")).toHaveText("Live");
  return { a, b, ctxA, ctxB };
}

const notes = (page: Page) => page.locator(".note");

test("a note and its text appear for the other person", async ({ browser }) => {
  const { a, b } = await openTwo(browser);
  await a.getByRole("button", { name: "Add note" }).click();
  await a.getByLabel("Note text").fill("Plan the launch");
  await expect(b.getByLabel("Note text")).toHaveValue("Plan the launch");
});

test("moving a note with the keyboard moves it for the other person", async ({ browser }) => {
  const { a, b } = await openTwo(browser);
  await a.getByRole("button", { name: "Add note" }).click();
  await expect(notes(b)).toHaveCount(1);
  const before = await notes(b).getAttribute("style");

  // Add note focuses the new note's text; Escape returns focus to the note.
  await expect(a.getByLabel("Note text")).toBeFocused();
  await a.keyboard.press("Escape");
  await expect(notes(a)).toBeFocused();
  await a.keyboard.press("Shift+ArrowRight");
  await a.keyboard.press("Shift+ArrowDown");
  await expect.poll(() => notes(b).getAttribute("style")).not.toBe(before);
  expect(await notes(b).getAttribute("style")).toBe(await notes(a).getAttribute("style"));
});

test("shows who else is on the board", async ({ browser }) => {
  const { a, b } = await openTwo(browser);
  await a.getByLabel("Your name").fill("Ana");
  await expect(b.getByRole("list", { name: "1 other person here" })).toContainText("Ana");
});

test("edits made offline reach the other person after reconnecting", async ({ browser }) => {
  const { a, b, ctxA } = await openTwo(browser);
  await a.getByRole("button", { name: "Add note" }).click();
  await expect(notes(b)).toHaveCount(1);

  await ctxA.setOffline(true);
  await expect(a.getByRole("status")).toContainText("saved on this device");
  await a.getByLabel("Note text").fill("written offline");
  await a.waitForTimeout(500);
  await expect(b.getByLabel("Note text")).toHaveValue("");

  await ctxA.setOffline(false);
  await expect(a.getByRole("status")).toHaveText("Live", { timeout: 15_000 });
  await expect(b.getByLabel("Note text")).toHaveValue("written offline");
});

test("has no detectable accessibility violations", async ({ browser }) => {
  const { a } = await openTwo(browser);
  await a.getByRole("button", { name: "Add note" }).click();
  await a.getByLabel("Note text").fill("Check contrast");
  const results = await new AxeBuilder({ page: a }).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
});
