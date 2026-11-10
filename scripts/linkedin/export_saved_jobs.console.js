/*
 * LinkedIn saved jobs -> linkedin_saved_jobs.json (browser console snippet)
 * ========================================================================
 *
 * WHAT IT IS
 *   A snippet YOU paste into the developer console of YOUR OWN signed-in browser
 *   tab, on the "Saved" tab of LinkedIn's Job Tracker
 *   (https://www.linkedin.com/jobs-tracker/, formerly
 *   https://www.linkedin.com/my-items/saved-jobs/). It runs only when you start
 *   it, at human pace, and saves a JSON file for:
 *
 *     npm run import:linkedin-saved -- <path/to/linkedin_saved_jobs.json> --dry-run
 *     npm run import:linkedin-saved -- <path/to/linkedin_saved_jobs.json>
 *
 *   1. It walks the pages of your saved-jobs list (scrolling each page so every
 *      card renders, then clicking the list's own "Next" button) and reads each
 *      card's title, company and location as rendered.
 *   2. It opens each saved job's page from this same tab, one at a time, about
 *      2 seconds apart (randomized), and reads the rendered job description -
 *      the same page you would see by clicking the job.
 *   3. It downloads linkedin_saved_jobs.json.
 *
 * WHAT IT IS NOT
 *   - It does not sign in, read or copy cookies or tokens, or use any LinkedIn API.
 *     Your browser sends its own session exactly as it does when you browse.
 *   - It never unsaves, applies to, or changes anything.
 *   - Nothing in the repository runs it, schedules it, or drives a headless browser.
 *   - It stops at the first rate limit (HTTP 429), sign-in wall, checkpoint or
 *     "oops" page instead of continuing; run `await jdeLinkedInExport.resume()`
 *     later to fetch the descriptions it has not fetched yet.
 *
 * HOW TO USE (Chrome/Edge: F12 or Ctrl+Shift+J -> Console; Firefox: Ctrl+Shift+K)
 *   1. Open https://www.linkedin.com/jobs-tracker/ (Saved) and go to page 1.
 *      Run these npm commands in a terminal, not in the browser console.
 *   2. Paste this whole file into the console and press Enter. It runs the
 *      collection, fetches descriptions, prints a summary (expected vs collected)
 *      and downloads linkedin_saved_jobs.json.
 *   3. If it stopped early, `await jdeLinkedInExport.resume()` continues the
 *      description pass; `jdeLinkedInExport.download()` downloads what is
 *      collected so far; `jdeLinkedInExport.clear()` forgets the stored progress.
 *
 * OUTPUT (validated by LinkedInSavedJobItemSchema in src/ingestion/linkedInSavedExport.ts)
 *   [{ "title", "company", "url", "location", "description", "descriptionStatus",
 *      "linkedinJobId", "exportedAt", "sourcePage" }]
 *   - url is https://www.linkedin.com/jobs/view/<id>/ and linkedinJobId is <id>.
 *   - Anything not shown on the page is null - never "Unknown Company", a default
 *     city, or placeholder description text. descriptionStatus is OK, MISSING
 *     (page had no description) or FETCH_FAILED (the request failed). The
 *     importer reports MISSING / FETCH_FAILED items as invalid, so re-run
 *     `resume()` for them before importing.
 *   - The importer also accepts the earlier snippet's output, but treats its
 *     placeholders ("Unknown Company", a defaulted "Singapore", "Full description
 *     not available...", "Failed to fetch description...") as missing.
 *
 * LinkedIn changes its page markup; if a field stops being found, update the
 * selector lists below.
 */
(async () => {
  "use strict";

  const STORAGE_KEY = "jde_linkedin_saved_export_v2";
  const MAX_PAGES = 40;
  const PAGE_SETTLE_MS = 2000;
  const PAGE_CHANGE_POLL_MS = 250;
  const PAGE_CHANGE_TIMEOUT_MS = 15000;
  const DESCRIPTION_BASE_DELAY_MS = 2000;
  const DESCRIPTION_JITTER_MS = 1000;
  const MAX_SCROLL_STEPS = 600;
  const BOTTOM_IDLE_CHECKS = 3;
  const BOTTOM_IDLE_WAIT_MS = 1500;

  const SELECTORS = {
    jobLink: "a[href*='/jobs/view/']",
    card: "li, .entity-list-item, .reusable-search__result-container",
    company: [".entity-list-item__subtitle", ".entity-result__primary-subtitle"],
    location: [".entity-list-item__caption", ".entity-result__secondary-subtitle"],
    paginationRoot: [".artdeco-pagination", "nav[aria-label*='agination']", "[class*='pagination']"],
    nextButton: [".artdeco-pagination__button--next"],
    activePage: [
      ".artdeco-pagination__indicator--number.active",
      ".artdeco-pagination__indicator--number.selected",
      "[aria-current='true']",
      "[aria-current='page']",
    ],
    description: [
      ".jobs-description-content",
      ".show-more-less-html__markup",
      "[id^='job-details']",
      ".jobs-box__html-content",
      ".jobs-description",
      ".description__text",
    ],
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const clean = (value) => (value || "").replace(/\s+/g, " ").trim();
  const firstLine = (value) => (value || "").split(/\r?\n/).map(clean).find(Boolean) || null;
  const jitter = () => DESCRIPTION_BASE_DELAY_MS + Math.floor((Math.random() - 0.5) * DESCRIPTION_JITTER_MS);

  class StopError extends Error {}

  function jobIdFromHref(href) {
    try {
      const url = new URL(href, location.origin);
      const match = url.pathname.match(/\/jobs\/view\/(?:[^/]*-)?(\d{5,20})(?:\/|$)/i);
      return match ? match[1] : null;
    } catch (error) {
      return null;
    }
  }

  function loadState() {
    try {
      const state = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      if (state && typeof state === "object" && state.jobs) return state;
    } catch (error) {
      console.warn("[jde] Stored progress was unreadable and is ignored.", error);
    }
    return { jobs: {}, order: [], expectedTotal: null, sourcePage: location.href, pagesVisited: 0 };
  }

  function saveState(state) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function textOf(root, selectors) {
    for (const selector of selectors) {
      const element = root && root.querySelector(selector);
      const text = element && clean(element.innerText);
      if (text) return text;
    }
    return null;
  }

  function headerTotal() {
    const candidates = [...document.querySelectorAll("h1, h2, h3, button, a, span")]
      .map((element) => clean(element.innerText))
      .filter((text) => text.length < 60);
    for (const text of candidates) {
      const match = text.match(/^Saved\s*\((\d[\d,]*)\)$/i) || text.match(/^Saved jobs?\s*\(?(\d[\d,]*)\)?$/i);
      if (match) return Number(match[1].replace(/,/g, ""));
    }
    return null;
  }

  function paginationRoot() {
    for (const selector of SELECTORS.paginationRoot) {
      const root = document.querySelector(selector);
      if (root) return root;
    }
    return null;
  }

  function activePageNumber() {
    const root = paginationRoot();
    if (!root) return null;
    for (const selector of SELECTORS.activePage) {
      const element = root.querySelector(selector);
      const text = element && clean(element.innerText);
      if (text && /^\d+$/.test(text)) return Number(text);
    }
    return null;
  }

  /** Next control of the list's own pagination only; a loose "next" text match elsewhere is ignored. */
  function nextControl() {
    const root = paginationRoot();
    if (!root) return null;
    for (const selector of SELECTORS.nextButton) {
      const element = root.querySelector(selector) || document.querySelector(selector);
      if (element) return element;
    }
    return [...root.querySelectorAll("button, a")].find((element) => {
      const label = clean(element.getAttribute("aria-label") || element.innerText).toLowerCase();
      return label === "next" || label === "next page";
    }) || null;
  }

  function isDisabled(element) {
    return element.disabled || element.getAttribute("aria-disabled") === "true" || element.classList.contains("artdeco-button--disabled");
  }

  function scrollableAncestor(element) {
    let node = element && element.parentElement;
    while (node && node !== document.body) {
      const style = getComputedStyle(node);
      if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 10) return node;
      node = node.parentElement;
    }
    return null;
  }

  /**
   * Scroll the list container (when it scrolls itself) and the window in steps so lazy cards
   * render, reading cards after every step: the Job Tracker list loads more cards as it scrolls
   * and may drop cards that scrolled out of view. At the bottom it waits for more cards to load
   * before treating the list as finished.
   */
  async function renderWholePage(onStep) {
    const container = scrollableAncestor(document.querySelector(SELECTORS.jobLink));
    for (const target of [container, document.scrollingElement].filter(Boolean)) {
      let idleAtBottom = 0;
      for (let step = 0; step < MAX_SCROLL_STEPS && idleAtBottom < BOTTOM_IDLE_CHECKS; step += 1) {
        const lastTop = target.scrollTop;
        const lastHeight = target.scrollHeight;
        target.scrollTop = Math.min(target.scrollTop + Math.max(200, target.clientHeight * 0.8), target.scrollHeight);
        await sleep(300);
        onStep();
        if (target.scrollTop === lastTop && target.scrollHeight === lastHeight) {
          idleAtBottom += 1;
          await sleep(BOTTOM_IDLE_WAIT_MS);
          onStep();
        } else {
          idleAtBottom = 0;
        }
      }
    }
    await sleep(PAGE_SETTLE_MS);
  }

  function pageJobIds() {
    return [...new Set([...document.querySelectorAll(SELECTORS.jobLink)].map((link) => jobIdFromHref(link.href)).filter(Boolean))];
  }

  function readCards(state) {
    let added = 0;
    for (const link of document.querySelectorAll(SELECTORS.jobLink)) {
      const id = jobIdFromHref(link.href);
      if (!id || state.jobs[id]) continue;
      const title = firstLine(link.innerText);
      if (!title) continue; // e.g. a logo link; the titled link for the same job follows.
      const card = link.closest(SELECTORS.card);
      let company = textOf(card, SELECTORS.company);
      let place = textOf(card, SELECTORS.location);
      if (company && !place && company.includes("·")) {
        const [left, right] = company.split("·").map(clean);
        company = left || null;
        place = right || null;
      }
      state.jobs[id] = {
        title,
        company: company || null,
        url: `https://www.linkedin.com/jobs/view/${id}/`,
        location: place || null,
        description: null,
        descriptionStatus: null,
        linkedinJobId: id,
        exportedAt: null,
        sourcePage: state.sourcePage,
      };
      state.order.push(id);
      added += 1;
    }
    return added;
  }

  async function waitForPageChange(previousIds, previousPage) {
    const previous = previousIds.join(",");
    const started = Date.now();
    while (Date.now() - started < PAGE_CHANGE_TIMEOUT_MS) {
      await sleep(PAGE_CHANGE_POLL_MS);
      const ids = pageJobIds();
      const page = activePageNumber();
      if ((ids.length > 0 && ids.join(",") !== previous) || (page !== null && previousPage !== null && page !== previousPage)) return;
    }
    throw new StopError(`The saved-jobs list did not move past page ${previousPage ?? "?"} within ${PAGE_CHANGE_TIMEOUT_MS / 1000}s after clicking Next. Nothing was skipped; check the page, then run the snippet again.`);
  }

  async function collectCards(state) {
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      let added = 0;
      await renderWholePage(() => { added += readCards(state); });
      added += readCards(state);
      if (state.order.length === 0) {
        throw new StopError("No saved-job links were found on this page. Make sure the Saved tab of the Job Tracker is open and its list has loaded, then paste the snippet again.");
      }
      state.pagesVisited += 1;
      saveState(state);
      console.log(`[jde] Page ${activePageNumber() ?? page}: ${added} new saved job(s), ${state.order.length} total.`);
      const next = nextControl();
      if (!next || isDisabled(next)) return;
      const ids = pageJobIds();
      const activePage = activePageNumber();
      next.click();
      await waitForPageChange(ids, activePage);
    }
    console.warn(`[jde] Stopped after the ${MAX_PAGES}-page cap.`);
  }

  function looksBlocked(response, html) {
    const finalUrl = response.url || "";
    if (/\/(checkpoint|authwall|login|uas\/login)\b/i.test(finalUrl)) return "a sign-in or checkpoint page";
    if (/<title>[^<]*(security verification|sign in|checkpoint)[^<]*<\/title>/i.test(html)) return "a sign-in or checkpoint page";
    if (/\b(oops|something went wrong)\b/i.test(html) && !/job/i.test(html.slice(0, 2000))) return "an \"oops\" error page";
    return null;
  }

  function descriptionFrom(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    for (const selector of SELECTORS.description) {
      const element = doc.querySelector(selector);
      const text = element && (element.textContent || "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
      if (text) return text.replace(/^About the job\s*/i, "").trim();
    }
    return null;
  }

  async function fetchDescriptions(state) {
    const pending = state.order.filter((id) => state.jobs[id].descriptionStatus !== "OK");
    console.log(`[jde] Fetching ${pending.length} description(s), one at a time, about ${DESCRIPTION_BASE_DELAY_MS / 1000}s apart.`);
    for (let index = 0; index < pending.length; index += 1) {
      const job = state.jobs[pending[index]];
      let response;
      let html = "";
      try {
        response = await fetch(job.url, { credentials: "include", headers: { accept: "text/html" } });
        if (response.status === 429) {
          throw new StopError(`LinkedIn rate limited the request (HTTP 429) at job ${job.linkedinJobId}; ${pending.length - index} description(s) not fetched. Wait, then run: await jdeLinkedInExport.resume()`);
        }
        html = await response.text();
      } catch (error) {
        if (error instanceof StopError) throw error;
        job.descriptionStatus = "FETCH_FAILED";
        job.description = null;
        saveState(state);
        console.warn(`[jde] ${job.linkedinJobId}: request failed (${error && error.message}).`);
        await sleep(jitter());
        continue;
      }
      const blocked = looksBlocked(response, html);
      if (blocked) {
        throw new StopError(`LinkedIn returned ${blocked} at job ${job.linkedinJobId}; ${pending.length - index} description(s) not fetched. Resolve it in the browser, then run: await jdeLinkedInExport.resume()`);
      }
      if (!response.ok) {
        job.descriptionStatus = "FETCH_FAILED";
        job.description = null;
      } else {
        const description = descriptionFrom(html);
        job.description = description;
        job.descriptionStatus = description ? "OK" : "MISSING";
      }
      job.exportedAt = new Date().toISOString();
      saveState(state);
      console.log(`[jde] ${index + 1}/${pending.length} ${job.linkedinJobId}: ${job.descriptionStatus}`);
      if (index < pending.length - 1) await sleep(jitter());
    }
  }

  function summary(state) {
    const jobs = state.order.map((id) => state.jobs[id]);
    const count = (status) => jobs.filter((job) => job.descriptionStatus === status).length;
    const expected = state.expectedTotal;
    console.log(`[jde] Saved jobs expected (page header): ${expected ?? "not shown"}; collected: ${jobs.length}; pages visited: ${state.pagesVisited}.`);
    console.log(`[jde] Descriptions OK: ${count("OK")}; MISSING: ${count("MISSING")}; FETCH_FAILED: ${count("FETCH_FAILED")}; not fetched yet: ${count(null)}.`);
    if (expected !== null && expected !== jobs.length) {
      console.warn(`[jde] Collected ${jobs.length} of ${expected} saved jobs. Check the list, then run the snippet again (already collected jobs are kept).`);
    }
  }

  function download() {
    const state = loadState();
    const jobs = state.order.map((id) => state.jobs[id]);
    if (jobs.length === 0) {
      console.warn("[jde] Nothing collected yet.");
      return;
    }
    const blob = new Blob([JSON.stringify(jobs, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "linkedin_saved_jobs.json";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    console.log(`[jde] Downloaded linkedin_saved_jobs.json with ${jobs.length} job(s).`);
  }

  async function runDescriptions(state) {
    try {
      await fetchDescriptions(state);
    } catch (error) {
      if (!(error instanceof StopError)) throw error;
      console.error(`[jde] STOPPED: ${error.message}`);
    }
    summary(state);
    download();
  }

  async function resume() {
    await runDescriptions(loadState());
  }

  function clear() {
    localStorage.removeItem(STORAGE_KEY);
    console.log("[jde] Stored export progress was cleared.");
  }

  window.jdeLinkedInExport = { resume, download, clear, summary: () => summary(loadState()) };

  if (!/\/(?:jobs-tracker|my-items\/saved-jobs)/.test(location.pathname)) {
    console.error("[jde] Open https://www.linkedin.com/jobs-tracker/ (Job Tracker > Saved), go to page 1, and paste the snippet again.");
    return;
  }
  const state = loadState();
  state.sourcePage = location.origin + location.pathname;
  state.expectedTotal = headerTotal() ?? state.expectedTotal;
  try {
    await collectCards(state);
  } catch (error) {
    if (!(error instanceof StopError)) throw error;
    console.error(`[jde] STOPPED: ${error.message}`);
    summary(state);
    return;
  }
  await runDescriptions(state);
})();
