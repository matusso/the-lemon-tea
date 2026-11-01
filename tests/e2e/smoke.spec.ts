import { expect, test, type Page } from "@playwright/test";

const SESSION = process.env.E2E_SESSION ?? "openf1:9908";

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  (page as unknown as { errors: string[] }).errors = errors;
});

/** Pick the session through the header comboboxes (season, weekend, session) by typing to filter. */
async function pickSession(page: Page) {
  const info = await (await page.request.get(`/api/sessions/${SESSION}`)).json();
  const choose = async (box: string, text: string) => {
    await page.getByRole("combobox", { name: box }).click();
    await page.keyboard.type(text);
    await page.getByRole("option", { name: new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }).first().click();
  };
  await choose("Season", String(info.session.year));
  await choose("Race weekend", info.session.meetingName);
  await choose("Session", info.session.name);
}

test("command center loads a session, renders the circuit and advances the timing tower", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("THE LEMON TEA").first()).toBeVisible();
  await pickSession(page);
  await expect(page.getByText(/Driven-line estimate/)).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("canvas").first()).toBeVisible();
  await page.getByRole("button", { name: "16×" }).click();
  await page.getByRole("button", { name: /Play/ }).click();
  await page.waitForTimeout(3000);
  await expect(page.getByText(/\d{2}\.\d{3}/).first()).toBeVisible({ timeout: 30_000 });
  expect((page as unknown as { errors: string[] }).errors).toEqual([]);
});

test("telemetry lab compares the two fastest drivers with the A_minus_B convention", async ({ page }) => {
  await page.goto("/");
  await pickSession(page);
  await page.getByText("Telemetry Lab").click();
  await expect(page.getByText(/negative = A/i).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("canvas:visible").first()).toBeVisible();
  expect((page as unknown as { errors: string[] }).errors).toEqual([]);
});
