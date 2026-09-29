// Kiosk search behaviour of index.html, driven in a real (headless) browser.
// The hub-signin endpoint is mocked, so every request the page makes is counted.
//
//   node --test tests/*.test.mjs        (needs the `playwright` package and its chromium)
//
// BEFORE (index.html at 4a4bb81) searched ~250 ms after every keystroke from the
// third letter. The shared Hub kiosk exhausted the per-IP 30/hour search limit on
// 2026-09-28. AFTER: one explicit Search (button or Enter) = one request.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { chromium, devices } from "playwright";

const API = "https://srmtohwucijjniwajkhp.supabase.co/functions/v1/hub-signin";
const HERE = new URL("..", import.meta.url);
const CURRENT = readFileSync(new URL("index.html", HERE), "utf8");

let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); });

const people = (n, q = "p") => Array.from({ length: n }, (_, i) => ({
  participant_id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
  display_name: `${q} Person ${i}`, business_name: `Biz ${i}`,
}));

// A page with a mocked endpoint. `server` decides each response; `log` records
// every request body the page sent.
async function open(html = CURRENT, { server, touch = true } = {}) {
  const { defaultBrowserType, ...ipad } = devices["iPad (gen 7)"];  // chromium with iPad viewport + touch
  const ctx = await browser.newContext(touch ? ipad : {});
  const page = await ctx.newPage();
  const log = [];
  await page.route(API, async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204 });
    const body = JSON.parse(req.postData() || "{}");
    log.push(body);
    const r = server ? await server(body, log) : { status: 200, json: { results: people(3, body.query) } };
    await route.fulfill({ status: r.status, contentType: "application/json", body: JSON.stringify(r.json ?? {}) });
  });
  await page.route("**/assets/**", (r) => r.fulfill({ status: 204 }));
  await page.setContent(html, { waitUntil: "load" });
  const searches = () => log.filter((b) => b.action === "search");
  const settle = () => page.waitForTimeout(400);  // longer than the old 250 ms debounce
  return { page, ctx, log, searches, settle };
}

test("0, 1, 2 characters: Search disabled and Enter does nothing", async () => {
  const { page, ctx, searches, settle } = await open();
  assert.equal(await page.isDisabled("#searchBtn"), true);
  for (const s of ["", "G", "Gi", "  Gi  "]) {
    await page.fill("#nameQuery", s);
    await page.press("#nameQuery", "Enter");
    await settle();
    assert.equal(await page.isDisabled("#searchBtn"), true, `disabled for ${JSON.stringify(s)}`);
  }
  assert.equal(searches().length, 0);
  assert.match(await page.textContent("#searchStatus"), /at least 3 letters/);
  await ctx.close();
});

test("3+ characters + Search tap = exactly one request", async () => {
  const { page, ctx, searches, settle } = await open();
  await page.fill("#nameQuery", "Gin");
  await settle();
  assert.equal(searches().length, 0, "typing alone never searches");
  await page.tap("#searchBtn");
  await page.waitForSelector("#results li");
  await settle();
  assert.equal(searches().length, 1);
  assert.equal(searches()[0].query, "Gin");
  await ctx.close();
});

test("Enter = exactly one request and never submits the form", async () => {
  const { page, ctx, log, searches, settle } = await open();
  await page.fill("#nameQuery", "Gina");
  await page.press("#nameQuery", "Enter");
  await page.waitForSelector("#results li");
  await settle();
  assert.equal(searches().length, 1);
  assert.equal(log.filter((b) => b.action === "submit").length, 0);
  assert.equal(await page.isVisible("#formError"), false);
  await ctx.close();
});

test("typing more characters without Search makes zero further requests", async () => {
  const { page, ctx, searches, settle } = await open();
  await page.fill("#nameQuery", "Gin");
  await page.tap("#searchBtn");
  await page.waitForSelector("#results li");
  await page.type("#nameQuery", "a Williams", { delay: 120 });
  await settle();
  assert.equal(searches().length, 1);
  assert.equal(await page.isHidden("#results"), true, "stale results are hidden once the name changes");
  await ctx.close();
});

test("repeating the same query (any case/spacing) is served from cache", async () => {
  const { page, ctx, searches, settle } = await open();
  await page.fill("#nameQuery", "Gina");
  await page.tap("#searchBtn");
  await page.waitForSelector("#results li");
  await page.tap("#searchBtn");
  await page.press("#nameQuery", "Enter");
  await page.fill("#nameQuery", "  gina ");
  await page.tap("#searchBtn");
  await settle();
  assert.equal(searches().length, 1);
  assert.equal(await page.locator("#results li").count(), 3, "cached results are shown again");
  await ctx.close();
});

test("changed query + Search = one new request", async () => {
  const { page, ctx, searches, settle } = await open();
  await page.fill("#nameQuery", "Gin");
  await page.tap("#searchBtn");
  await page.waitForSelector("#results li");
  await page.fill("#nameQuery", "Gina W");
  await page.tap("#searchBtn");
  await page.waitForSelector("#results li");
  await settle();
  assert.deepEqual(searches().map((b) => b.query), ["Gin", "Gina W"]);
  await ctx.close();
});

test("results never exceed 8 even if the server sent more", async () => {
  const { page, ctx, settle } = await open(CURRENT, { server: (b) => ({ status: 200, json: { results: people(12, b.query) } }) });
  await page.fill("#nameQuery", "Wil");
  await page.tap("#searchBtn");
  await page.waitForSelector("#results li");
  await settle();
  assert.equal(await page.locator("#results li").count(), 8);
  await ctx.close();
});

test("search errors and 429 are visible, and are not cached", async () => {
  let status = 500;
  const { page, ctx, searches, settle } = await open(CURRENT, {
    server: (b) => status === 200 ? { status, json: { results: people(2, b.query) } } : { status, json: { error: "x" } },
  });
  await page.fill("#nameQuery", "Gina");
  await page.tap("#searchBtn");
  await settle();
  assert.equal(await page.isVisible("#formError"), true);
  assert.match(await page.textContent("#formError"), /could not search/);

  status = 429;
  await page.tap("#searchBtn");
  await settle();
  assert.match(await page.textContent("#formError"), /Too many searches from this Hub device/);

  status = 200;
  await page.tap("#searchBtn");
  await page.waitForSelector("#results li");
  assert.equal(await page.isVisible("#formError"), false, "a successful search clears the error");
  assert.equal(searches().length, 3, "failures were retried, not served from cache");
  await ctx.close();
});

test("Search is disabled while a request is in flight (no double tap)", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { page, ctx, searches, settle } = await open(CURRENT, {
    server: async (b) => { await gate; return { status: 200, json: { results: people(1, b.query) } }; },
  });
  await page.fill("#nameQuery", "Gina");
  await page.tap("#searchBtn");
  await settle();
  assert.equal(await page.isDisabled("#searchBtn"), true);
  await page.press("#nameQuery", "Enter");
  await page.tap("#searchBtn", { force: true });
  release();
  await page.waitForSelector("#results li");
  await settle();
  assert.equal(searches().length, 1);
  assert.equal(await page.isDisabled("#searchBtn"), false);
  await ctx.close();
});

test("selection: one chosen entrepreneur, and it is what gets submitted", async () => {
  const { page, ctx, log, settle } = await open();
  await page.fill("#nameQuery", "Gina");
  await page.tap("#searchBtn");
  await page.waitForSelector("#results li");
  await page.tap("#results li:nth-child(2) button");
  assert.equal(await page.isHidden("#results"), true);
  assert.equal(await page.textContent("#chosenName"), "Gina Person 1");
  // Change -> pick another: still exactly one choice.
  await page.tap("#changeChoice");
  await page.tap("#searchBtn");                // same query: cached, no request
  await page.tap("#results li:nth-child(3) button");
  assert.equal(await page.textContent("#chosenName"), "Gina Person 2");
  assert.equal(await page.locator(".chosen").count(), 1);
  await page.selectOption("#visitType", "appointment");
  await page.tap("#submitBtn");
  await page.waitForSelector("#successScreen:not([hidden])");
  await settle();
  const submits = log.filter((b) => b.action === "submit");
  assert.equal(submits.length, 1);
  assert.equal(submits[0].participant_id, people(3)[2].participant_id);
  assert.equal(log.filter((b) => b.action === "search").length, 1);
  await ctx.close();
});

test("next visitor starts clean: no cached results carried over", async () => {
  const { page, ctx, searches } = await open(CURRENT, {
    server: (b) => b.action === "submit"
      ? { status: 200, json: { status: "recorded", visitor_status: "returning", visit_date_local: "2026-09-29" } }
      : { status: 200, json: { results: people(1, b.query) } },
  });
  await page.fill("#nameQuery", "Gina");
  await page.tap("#searchBtn");
  await page.tap("#results li button");
  await page.selectOption("#visitType", "walk_in");
  await page.tap("#submitBtn");
  await page.tap("#againBtn");
  assert.equal(await page.isDisabled("#searchBtn"), true);
  await page.fill("#nameQuery", "Gina");
  await page.tap("#searchBtn");
  await page.waitForSelector("#results li");
  assert.equal(searches().length, 2);
  await ctx.close();
});

// ------------------------------------------------------------ busy shift
// A 9/28-style evening rush: 8 visitors in one hour on one kiosk, each typed at
// iPad speed (350 ms/key), some mistyping and correcting. The mock enforces the
// server's hourly search limit and counts what each version of the page spends.
const SHIFT = [
  "Awoude Zialengo", "Catrina Baker", "Howard Dukes", "Gina Williams",
  "Lynetta Ladd", "Lorraine Exum", "Leslinda Leon", "Kim Phillips",
];

async function runShift(html, { explicit, limit }) {
  const { page, ctx, searches } = await open(html, {
    server: (b, log) => {
      if (b.action !== "search") return { status: 200, json: { status: "recorded" } };
      const used = log.filter((x) => x.action === "search").length;
      return used > limit ? { status: 429, json: { error: "rate_limited" } }
                          : { status: 200, json: { results: people(2, b.query) } };
    },
  });
  let limited = 0;
  for (const [i, name] of SHIFT.entries()) {
    await page.fill("#nameQuery", "");
    // every other visitor first types just the first name and has to refine
    const first = name.split(" ")[0];
    await page.type("#nameQuery", i % 2 ? first : name, { delay: 350 });
    if (explicit) { await page.press("#nameQuery", "Enter"); await page.waitForTimeout(300); }
    if (i % 2) {
      await page.type("#nameQuery", name.slice(first.length), { delay: 350 });
      if (explicit) { await page.tap("#searchBtn"); }
    }
    await page.waitForTimeout(400);
    if ((await page.textContent("#formError")).includes("Too many")) limited++;
  }
  const n = searches().length;
  await ctx.close();
  return { n, limited };
}

test("busy shift: the OLD page burns the 30/hour limit; the NEW page stays far below 60/hour", { timeout: 180_000 }, async () => {
  const old = execFileSync("git", ["show", "4a4bb814a3d0ab625c4c084200a9ac93e5df31d6:index.html"], { cwd: HERE, encoding: "utf8" });
  const before = await runShift(old, { explicit: false, limit: 30 });
  const afterRun = await runShift(CURRENT, { explicit: true, limit: 60 });
  console.log(`busy shift, 8 visitors: old page ${before.n} searches (${before.limited} visitors saw 429), new page ${afterRun.n} searches`);
  assert.ok(before.n > 30, `old page should exceed 30 searches, made ${before.n}`);
  assert.ok(before.limited > 0);
  assert.equal(afterRun.n, SHIFT.length + SHIFT.length / 2, "one search per lookup, one more per refinement");
  assert.equal(afterRun.limited, 0);
  assert.ok(afterRun.n * 4 <= 60, "even four such rushes in one hour fit the new limit");
});
