// Kiosk search behaviour of index.html, driven in a real (headless) browser.
// The hub-signin endpoint is mocked, so every request the page makes is counted.
//
//   node --test tests/*.test.mjs        (needs the `playwright` package and its chromium)
//
// History: 4a4bb81 searched ~250 ms after EVERY keystroke from the third letter,
// and the shared Hub kiosk exhausted the per-IP 30/hour search limit on
// 2026-09-28. The page now searches automatically once typing PAUSES, keeps every
// answer, and narrows a complete answer locally as more letters are typed.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { chromium, devices } from "playwright";

const API = "https://srmtohwucijjniwajkhp.supabase.co/functions/v1/hub-signin";
const HERE = new URL("..", import.meta.url);
const CURRENT = readFileSync(new URL("index.html", HERE), "utf8");
const PAUSE = 800;  // comfortably longer than the page's 500 ms pause

let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); });

// A tiny stand-in for the server: "full name contains the text", ordered, capped at 8.
const ROSTER = [
  "Gina Williams", "Gina Southbend", "Regina King", "Ginny Park", "Tess Williams",
  ...Array.from({ length: 12 }, (_, i) => `Wil Person${i}`),
  "Awoude Zialengo", "Catrina Baker", "Howard Dukes", "Lynetta Ladd", "Lorraine Exum", "Leslinda Leon", "Kim Phillips",
].map((n, i) => ({ participant_id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, display_name: n, business_name: `Biz ${i}` }));
const serverSearch = (q) => ROSTER.filter((r) => r.display_name.toLowerCase().includes(q.toLowerCase().replace(/\s+/g, " ").trim()))
  .sort((a, b) => a.display_name.localeCompare(b.display_name)).slice(0, 8);

async function open(html = CURRENT, { server } = {}) {
  const { defaultBrowserType, ...tablet } = devices["iPad (gen 7)"];  // chromium, tablet viewport + touch
  const ctx = await browser.newContext(tablet);
  const page = await ctx.newPage();
  const log = [];
  await page.route(API, async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204 });
    const body = JSON.parse(req.postData() || "{}");
    log.push(body);
    const r = server ? await server(body, log) : body.action === "search"
      ? { status: 200, json: { results: serverSearch(body.query) } }
      : { status: 200, json: { status: "recorded", visitor_status: "returning", visit_date_local: "2026-09-29" } };
    await route.fulfill({ status: r.status, contentType: "application/json", body: JSON.stringify(r.json ?? {}) });
  });
  await page.setContent(html, { waitUntil: "load" });
  const searches = () => log.filter((b) => b.action === "search");
  const settle = () => page.waitForTimeout(PAUSE);
  return { page, ctx, log, searches, settle };
}

test("no Search button: typing alone searches", async () => {
  const { page, ctx, searches } = await open();
  assert.equal(await page.locator("#searchBtn").count(), 0);
  assert.match(await page.textContent("label[for=nameQuery] .hint"), /at least 3 letters.*choose from the list/);
  await page.type("#nameQuery", "Gin", { delay: 120 });
  await page.waitForSelector("#results li");
  assert.equal(searches().length, 1);
  assert.equal(searches()[0].query, "Gin");
  await ctx.close();
});

test("0, 1, 2 characters never search (typing or Enter)", async () => {
  const { page, ctx, searches, settle } = await open();
  for (const s of ["G", "Gi", "  Gi  "]) {
    await page.fill("#nameQuery", s);
    await page.press("#nameQuery", "Enter");
    await settle();
  }
  assert.equal(searches().length, 0);
  assert.match(await page.textContent("#searchStatus"), /at least 3 letters/);
  await ctx.close();
});

test("steady typing sends ONE request, not one per letter", async () => {
  const { page, ctx, searches, settle } = await open();
  await page.type("#nameQuery", "Howard Dukes", { delay: 250 });   // brisk kiosk typing
  await settle();
  assert.equal(searches().length, 1, `sent ${searches().map((b) => b.query)}`);
  assert.equal(await page.locator("#results li").count(), 1);
  await ctx.close();
});

test("slow hunt-and-peck typing: a complete list is narrowed locally with no more requests", async () => {
  const { page, ctx, searches, settle } = await open();
  await page.type("#nameQuery", "Gin", { delay: 100 });
  await settle();                                   // pause -> 1 request, 4 matches (complete)
  await page.type("#nameQuery", "a Williams", { delay: 900 });   // pauses after every letter
  await settle();
  assert.equal(searches().length, 1);
  assert.deepEqual(await page.locator("#results li button").evaluateAll((b) => b.map((x) => x.firstChild.textContent)), ["Gina Williams"]);
  await ctx.close();
});

test("a full page of 8 is refined by the server when the text grows", async () => {
  const { page, ctx, searches, settle } = await open();
  await page.type("#nameQuery", "Wil", { delay: 100 });
  await settle();
  assert.equal(await page.locator("#results li").count(), 8);   // 14 match: capped, so incomplete
  await page.type("#nameQuery", "liams", { delay: 100 });
  await settle();
  assert.deepEqual(searches().map((b) => b.query), ["Wil", "Williams"]);
  assert.equal(await page.locator("#results li").count(), 2);
  await ctx.close();
});

test("backspacing to an earlier text reuses the answer; Enter searches immediately", async () => {
  const { page, ctx, searches, settle } = await open();
  await page.fill("#nameQuery", "Lyn");
  await page.press("#nameQuery", "Enter");          // immediately, no pause needed
  await page.waitForSelector("#results li", { timeout: 300 });
  await page.type("#nameQuery", "etta");
  await page.press("#nameQuery", "Backspace");
  await page.press("#nameQuery", "Backspace");
  await page.press("#nameQuery", "Backspace");
  await page.press("#nameQuery", "Backspace");
  await settle();
  assert.equal(searches().length, 1);
  assert.equal(await page.isVisible("#results"), true);
  await ctx.close();
});

test("Enter never submits the form", async () => {
  const { page, ctx, log, settle } = await open();
  await page.fill("#nameQuery", "Gina");
  await page.press("#nameQuery", "Enter");
  await settle();
  assert.equal(log.filter((b) => b.action === "submit").length, 0);
  assert.equal(await page.isVisible("#formError"), false);
  await ctx.close();
});

test("typing while a search is in flight: one follow-up request, for the latest text only", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { page, ctx, searches, settle } = await open(CURRENT, {
    server: async (b) => { if (b.query === "Wil") await gate; return { status: 200, json: { results: serverSearch(b.query) } }; },
  });
  await page.type("#nameQuery", "Wil", { delay: 50 });
  await settle();                                   // "Wil" in flight
  await page.type("#nameQuery", "l", { delay: 50 });
  await settle();
  await page.type("#nameQuery", "iams", { delay: 50 });
  await settle();
  release();
  await settle();
  assert.deepEqual(searches().map((b) => b.query), ["Wil", "Williams"]);
  assert.equal(await page.locator("#results li").count(), 2);
  await ctx.close();
});

test("results never exceed 8 even if the server sent more", async () => {
  const { page, ctx, settle } = await open(CURRENT, { server: (b) => ({ status: 200, json: { results: ROSTER.slice(0, 12) } }) });
  await page.fill("#nameQuery", "Wil");
  await page.press("#nameQuery", "Enter");
  await settle();
  assert.equal(await page.locator("#results li").count(), 8);
  await ctx.close();
});

test("search errors and 429 are visible and are retried, never cached", async () => {
  let status = 500;
  const { page, ctx, searches, settle } = await open(CURRENT, {
    server: (b) => status === 200 ? { status, json: { results: serverSearch(b.query) } } : { status, json: { error: "x" } },
  });
  await page.fill("#nameQuery", "Gina");
  await page.press("#nameQuery", "Enter");
  await settle();
  assert.match(await page.textContent("#formError"), /could not search/);
  status = 429;
  await page.press("#nameQuery", "Enter");
  await settle();
  assert.match(await page.textContent("#formError"), /Too many searches from this Hub device/);
  status = 200;
  await page.press("#nameQuery", "Enter");
  await page.waitForSelector("#results li");
  assert.equal(await page.isVisible("#formError"), false);
  assert.equal(searches().length, 3);
  await ctx.close();
});

test("selection: one chosen entrepreneur, and it is what gets submitted", async () => {
  const { page, ctx, log, settle } = await open();
  await page.type("#nameQuery", "Gin", { delay: 60 });
  await page.waitForSelector("#results li");
  await page.tap("#results li:nth-child(2) button");
  assert.equal(await page.isHidden("#results"), true);
  const first = await page.textContent("#chosenName");
  await page.tap("#changeChoice");
  await page.press("#nameQuery", "Enter");            // same text: from memory, no request
  await page.tap("#results li:nth-child(3) button");
  const second = await page.textContent("#chosenName");
  assert.notEqual(first, second);
  assert.equal(await page.locator(".chosen").count(), 1);
  await page.selectOption("#visitType", "appointment");
  await page.tap("#submitBtn");
  await page.waitForSelector("#successScreen:not([hidden])");
  await settle();
  const submits = log.filter((b) => b.action === "submit");
  assert.equal(submits.length, 1);
  assert.equal(submits[0].participant_id, serverSearch("Gin")[2].participant_id);
  assert.equal(log.filter((b) => b.action === "search").length, 1);
  await ctx.close();
});

test("next visitor starts clean: nothing remembered from the previous one", async () => {
  const { page, ctx, searches, settle } = await open();
  await page.fill("#nameQuery", "Gina");
  await page.press("#nameQuery", "Enter");
  await page.tap("#results li button");
  await page.selectOption("#visitType", "walk_in");
  await page.tap("#submitBtn");
  await page.tap("#againBtn");
  await page.fill("#nameQuery", "Gina");
  await page.press("#nameQuery", "Enter");
  await page.waitForSelector("#results li");
  await settle();
  assert.equal(searches().length, 2);
  await ctx.close();
});

// ------------------------------------------------------------ busy shift
// A 9/28-style rush on one kiosk: 8 visitors, names typed at tablet speed with a
// hesitation mid-name, plus one person typing a long sentence into the box (what
// actually happened on 9/29 at 14:13 UTC). The mock enforces an hourly limit and
// counts what each version of the page spends.
const SHIFT = ["Awoude Zialengo", "Catrina Baker", "Howard Dukes", "Gina Williams",
               "Lynetta Ladd", "Lorraine Exum", "Leslinda Leon", "Kim Phillips"];
const RAMBLE = "Gina here for my 10am with the marketing team please";

async function runShift(html, limit) {
  const { page, ctx, searches } = await open(html, {
    server: (b, log) => log.filter((x) => x.action === "search").length > limit
      ? { status: 429, json: { error: "rate_limited" } } : { status: 200, json: { results: serverSearch(b.query) } },
  });
  for (const name of [...SHIFT, RAMBLE]) {
    await page.fill("#nameQuery", "");
    const [a, b] = [name.slice(0, 5), name.slice(5)];
    await page.type("#nameQuery", a, { delay: 350 });
    await page.waitForTimeout(1200);                 // hesitates, looks at the list
    await page.type("#nameQuery", b, { delay: 350 });
    await page.waitForTimeout(900);
  }
  const limited = (await page.textContent("#formError")).includes("Too many");
  const n = searches().length;
  await ctx.close();
  return { n, limited };
}

test("busy shift: the per-keystroke page blows the old 30/hour limit; the new page uses a handful", { timeout: 240_000 }, async () => {
  const old = execFileSync("git", ["show", "4a4bb814a3d0ab625c4c084200a9ac93e5df31d6:index.html"], { cwd: HERE, encoding: "utf8" });
  const before = await runShift(old, 30);
  const now = await runShift(CURRENT, 30);            // judged against the OLD, stricter limit
  console.log(`busy shift, 8 visitors + 1 long ramble: per-keystroke page ${before.n} searches, new page ${now.n}`);
  assert.ok(before.n > 30 && before.limited, `old page should blow the limit, made ${before.n}`);
  assert.equal(now.limited, false);
  assert.ok(now.n <= 2 * (SHIFT.length + 1), `at most two requests per visitor, made ${now.n}`);
  assert.ok(now.n * 3 <= 60, "three such rushes in one hour still fit the 60/hour limit");
});

// ------------------------------------------------------------ same-day visits
// Every physical visit is recorded; membership earns at most ONE punch per South
// Bend day. The mock is the server's contract: one row per submission_id, and a
// punch only for the first visit of that participant's day.
function visitServer() {
  const rows = [];
  return (b) => {
    if (b.action === "search") return { status: 200, json: { results: serverSearch(b.query) } };
    let row = rows.find((r) => r.sid === b.submission_id);
    const replay = !!row;
    if (!row) rows.push(row = { sid: b.submission_id, pid: b.participant_id, date: "2026-09-30", id: `visit-${rows.length + 1}` });
    const mine = rows.filter((r) => r.pid === row.pid);
    const had = mine.indexOf(row) > 0;                  // an earlier visit today already punched
    return { status: 200, json: { status: replay ? "already_recorded" : "recorded", visit_id: row.id,
      visit_date_local: row.date, visitor_status: mine[0] === row ? "first_visit" : "returning",
      membership_punch_awarded: !had, already_had_qualifying_visit_today: had } };
  };
}
async function signIn(page, name) {
  await page.fill("#nameQuery", name);
  await page.press("#nameQuery", "Enter");
  await page.tap("#results li button");
  await page.selectOption("#visitType", "walk_in");
  await page.tap("#submitBtn");
  await page.waitForSelector("#successScreen:not([hidden])");
  return { head: await page.textContent("#successHeadline"), detail: await page.textContent("#successDetail") };
}
const PUNCH = "Your physical Hub visit has been recorded. You earned today's membership punch.";
const NO_PUNCH = "Your physical Hub visit has been recorded. Today's membership punch was already earned earlier, so your membership level will not increase again today.";

test("a second visit the same day is a success, is recorded, and earns no second punch", async () => {
  const { page, ctx, log } = await open(CURRENT, { server: visitServer() });
  const one = await signIn(page, "Gina Williams");
  assert.equal(one.head, "You're signed in — first recorded Hub visit");
  assert.equal(one.detail, PUNCH);
  await page.tap("#againBtn");
  const two = await signIn(page, "Gina Williams");
  assert.equal(two.head, "You're signed in — welcome back");     // not "first" again on the first day
  assert.equal(two.detail, NO_PUNCH);
  assert.equal(await page.isHidden("#formError"), true);
  const subs = log.filter((b) => b.action === "submit");
  assert.equal(subs.length, 2);
  assert.notEqual(subs[0].submission_id, subs[1].submission_id, "two visits are two submissions");
  assert.doesNotMatch(CURRENT, /so we have not added a duplicate/);
  await ctx.close();
});

test("a failed sign-in retries with the SAME submission_id and shows the original punch answer", async () => {
  const real = visitServer();
  let calls = 0;
  const { page, ctx, log } = await open(CURRENT, { server: (b) => {
    if (b.action !== "submit") return real(b);
    const r = real(b);                                   // the write lands...
    return ++calls === 1 ? { status: 502, json: { error: "submit_failed" } } : r;   // ...but the answer is lost
  } });
  await page.fill("#nameQuery", "Gina Williams");
  await page.press("#nameQuery", "Enter");
  await page.tap("#results li button");
  await page.selectOption("#visitType", "walk_in");
  await page.tap("#submitBtn");
  await page.waitForSelector("#formError:not([hidden])");
  assert.equal(await page.textContent("#submitBtn"), "Try again");
  await page.tap("#submitBtn");
  await page.waitForSelector("#successScreen:not([hidden])");
  assert.equal(await page.textContent("#successDetail"), PUNCH);   // the retry is not a second visit
  const subs = log.filter((b) => b.action === "submit");
  assert.equal(subs.length, 2);
  assert.equal(subs[0].submission_id, subs[1].submission_id);
  await ctx.close();
});

test("an old server's already_signed_in_today never claims the visit was recorded", async () => {
  const { page, ctx } = await open(CURRENT, { server: (b) => b.action === "search"
    ? { status: 200, json: { results: serverSearch(b.query) } }
    : { status: 200, json: { status: "already_signed_in_today", visitor_status: "returning", visit_date_local: "2026-09-30" } } });
  const r = await signIn(page, "Gina Williams");
  assert.equal(r.detail, "You already signed in earlier today, so this sign-in was not added again.");
  assert.doesNotMatch(r.detail, /has been recorded/);
  await ctx.close();
});
