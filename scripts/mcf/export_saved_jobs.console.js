/*
 * MyCareersFuture saved jobs -> mcf_saved_jobs.json (browser console snippet)
 * ==========================================================================
 *
 * WHAT IT IS
 *   A snippet YOU paste into the developer console of YOUR OWN signed-in browser
 *   tab on the MyCareersFuture "Saved jobs" page
 *   (https://www.mycareersfuture.gov.sg/saved-jobs). It runs only when you start
 *   it, at human pace, and saves a JSON file for:
 *
 *     npm run import:mcf-saved -- <path/to/mcf_saved_jobs.json> --dry-run
 *     npm run import:mcf-saved -- <path/to/mcf_saved_jobs.json>
 *
 *   1. It walks the pages of your Saved jobs list as rendered (clicking the list's
 *      own "Next" button and waiting for the list to change) and reads each job
 *      card's link, which carries the MCF job id.
 *   2. For each saved job it requests the job's public details exactly as the
 *      MyCareersFuture job page does when you open that job
 *      (GET https://api.mycareersfuture.gov.sg/v2/jobs/<job id> with the site's
 *      "mcf-client: jobseeker" header), one at a time, about 2 seconds apart.
 *      The request carries no cookies or credentials (job details are public).
 *   3. It keeps only the fields listed under OUTPUT and downloads
 *      mcf_saved_jobs.json. Recruiter contact data (for example
 *      metadata.emailRecipient), view counts and every other field of the
 *      response are dropped in the browser and never written to the file.
 *
 * WHAT IT IS NOT
 *   - It does not sign in, read or copy cookies or tokens, or call any account API.
 *   - It never unsaves, applies to, or changes anything.
 *   - Nothing in the repository runs it, schedules it, or drives a headless browser.
 *   - It stops at the first rate limit (HTTP 429), server error or non-JSON
 *     (error) page instead of continuing; run `await jdeMcfExport.resume()`
 *     later to fetch the details it has not fetched yet.
 *
 * TERMS
 *   MyCareersFuture's Terms of Use do not allow storing site content in a
 *   retrieval system without SWDA's written permission. Use this only for your
 *   own saved jobs and personal job search; see docs/source-compliance-matrix.md.
 *
 * HOW TO USE (Chrome/Edge: F12 or Ctrl+Shift+J -> Console; Firefox: Ctrl+Shift+K)
 *   1. Sign in, open https://www.mycareersfuture.gov.sg/saved-jobs, leave the
 *      filter on "All Job Status" and stay on page 1.
 *   2. Paste this whole file into the console and press Enter. It collects the
 *      list, fetches details, prints a summary (expected vs collected) and
 *      downloads mcf_saved_jobs.json.
 *   3. If it stopped early, `await jdeMcfExport.resume()` continues the detail
 *      pass; `jdeMcfExport.download()` downloads what is collected so far;
 *      `jdeMcfExport.clear()` forgets the stored progress.
 *
 * OUTPUT (validated by McfSavedJobItemSchema in src/ingestion/mcfSavedExport.ts)
 *   [{ "title", "company", "url", "description", "descriptionStatus", "location",
 *      "salary": { "min", "max", "currency", "period" } | null, "employmentType",
 *      "postedAt", "expiresAt", "mcfJobUuid", "exportedAt", "sourcePage",
 *      "originalPostedAt", "availabilityStatus", "availabilityEvidence", "postingCheckedAt",
 *      "postingRecheckFailedAt", "postingRecheckFailure" }]
 *   - postedAt is MCF's posting date (its newPostingDate, else originalPostingDate);
 *     originalPostedAt is originalPostingDate, so a repost can be told apart.
 *     availabilityStatus is OPEN / CLOSED from MCF's job status ("Open",
 *     "Re-open", "Closed"), else UNKNOWN; postingCheckedAt is when the job
 *     details were read. `await jdeMcfExport.refresh()` re-reads every job; a
 *     re-read that fails (e.g. HTTP 404) keeps the earlier details and check
 *     time and sets postingRecheckFailedAt / postingRecheckFailure.
 *   - url is the card's https://www.mycareersfuture.gov.sg/job/<category>/<slug>-<id>
 *     without its query string; mcfJobUuid is the trailing 32-hex <id>.
 *   - Anything MCF does not show is null: a hidden employer, hidden salary or
 *     hidden address stays null - never "Unknown", a default city or placeholder
 *     text. MCF lists salaries in Singapore dollars, so currency is "SGD".
 *   - descriptionStatus is OK, MISSING (MCF has no such job any more, or it has
 *     no description) or FETCH_FAILED (the request failed). The importer reports
 *     MISSING / FETCH_FAILED items as invalid.
 *
 * MyCareersFuture changes its page markup; if the list stops being found,
 * update the SELECTORS below (they come from the site's data-testid/data-cy
 * attributes as of November 2026).
 */
(async () => {
  "use strict";

  const STORAGE_KEY = "jde_mcf_saved_export_v1";
  const JOB_API = "https://api.mycareersfuture.gov.sg/v2/jobs/";
  const MAX_PAGES = 100;
  const FIRST_RENDER_TIMEOUT_MS = 20000;
  const PAGE_CHANGE_POLL_MS = 250;
  const PAGE_CHANGE_TIMEOUT_MS = 20000;
  const PAGE_SETTLE_MS = 1000;
  const DETAIL_BASE_DELAY_MS = 2000;
  const DETAIL_JITTER_MS = 1000;

  const SELECTORS = {
    header: "[data-cy='saved-jobs-page__header']",
    list: "[data-testid='card-list']",
    jobLink: "a[data-testid='job-card-link'], a[href*='/job/']",
    cardTitle: "[data-testid='job-card__job-title'], [data-cy='job-card__job-title'], h3, h2",
    loader: "[data-testid='card-loader-container']",
    empty: "[data-testid='bookmarked-job-not-found'], [data-testid='filtered-bookmarked-job-not-found'], #no-saved-job-content",
    pagination: "[data-testid='pagination']",
    next: "[data-cy='pagination__next'], button[aria-label='Next']",
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const clean = (value) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "");
  const orNull = (value) => clean(value) || null;
  const jitter = () => DETAIL_BASE_DELAY_MS + Math.floor((Math.random() - 0.5) * DETAIL_JITTER_MS);

  class StopError extends Error {}

  /** /job/<category>/<slug>-<uuid> or /job/<slug>-<uuid> on mycareersfuture.gov.sg. */
  function jobFromHref(href) {
    try {
      const url = new URL(href, location.origin);
      if (!/(^|\.)mycareersfuture\.gov\.sg$/i.test(url.hostname)) return null;
      const match = url.pathname.match(/^\/job\/(?:[^/]+\/)?(?:[^/]*-)?([0-9a-f]{32})\/?$/i);
      if (!match) return null;
      return {
        uuid: match[1].toLowerCase(),
        url: "https://www.mycareersfuture.gov.sg" + url.pathname.replace(/\/$/, ""),
      };
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
    return { jobs: {}, order: [], pageCounts: [], expectedTotal: null, sourcePage: location.origin + location.pathname };
  }

  function saveState(state) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (error) {
      console.warn("[jde] Progress could not be stored in this browser; download() before closing the tab.", error);
    }
  }

  function listRoot() {
    return document.querySelector(SELECTORS.list) || document.querySelector("main") || document.body;
  }

  function pageJobs() {
    const seen = new Map();
    for (const link of listRoot().querySelectorAll(SELECTORS.jobLink)) {
      const job = jobFromHref(link.getAttribute("href") || "");
      if (!job) continue;
      const titleElement = link.querySelector(SELECTORS.cardTitle);
      const cardTitle = orNull(titleElement && titleElement.textContent);
      const known = seen.get(job.uuid);
      if (!known) seen.set(job.uuid, { ...job, cardTitle });
      else if (!known.cardTitle && cardTitle) known.cardTitle = cardTitle;
    }
    return [...seen.values()];
  }

  function pageParam() {
    const value = new URLSearchParams(location.search).get("page");
    return value === null ? 0 : Number(value);
  }

  /** A saved-jobs total, if the page shows one ("12 saved jobs"); MCF usually does not. */
  function shownTotal() {
    const texts = [...document.querySelectorAll("h1, h2, h3, p, span")]
      .map((element) => clean(element.textContent))
      .filter((text) => text.length > 0 && text.length < 60);
    for (const text of texts) {
      const match = text.match(/^(\d[\d,]*)\s+saved jobs?$/i) || text.match(/^saved jobs?\s*\((\d[\d,]*)\)$/i);
      if (match) return Number(match[1].replace(/,/g, ""));
    }
    return null;
  }

  function nextControl() {
    const root = document.querySelector(SELECTORS.pagination);
    if (!root) return null;
    const next = root.querySelector(SELECTORS.next);
    return next && !next.disabled && next.getAttribute("aria-disabled") !== "true" ? next : null;
  }

  async function waitForFirstRender() {
    const started = Date.now();
    while (Date.now() - started < FIRST_RENDER_TIMEOUT_MS) {
      if (!document.querySelector(SELECTORS.loader) && (pageJobs().length > 0 || document.querySelector(SELECTORS.empty))) return;
      await sleep(PAGE_CHANGE_POLL_MS);
    }
    throw new StopError("The Saved jobs list did not render within 20s. Check that you are signed in and the list is visible, then paste the snippet again.");
  }

  async function waitForPageChange(previousIds, previousPage) {
    const previous = previousIds.join(",");
    const started = Date.now();
    while (Date.now() - started < PAGE_CHANGE_TIMEOUT_MS) {
      await sleep(PAGE_CHANGE_POLL_MS);
      if (document.querySelector(SELECTORS.loader)) continue;
      const ids = pageJobs().map((job) => job.uuid);
      if (pageParam() !== previousPage && ids.length > 0 && ids.join(",") !== previous) {
        await sleep(PAGE_SETTLE_MS);
        return;
      }
    }
    throw new StopError(`The Saved jobs list did not move past page ${previousPage + 1} within ${PAGE_CHANGE_TIMEOUT_MS / 1000}s after clicking Next. Nothing was skipped; check the page, then paste the snippet again (collected jobs are kept).`);
  }

  async function collectList(state) {
    await waitForFirstRender();
    state.pageCounts = [];
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const jobs = pageJobs();
      let added = 0;
      for (const job of jobs) {
        if (state.jobs[job.uuid]) continue;
        state.jobs[job.uuid] = {
          // The title as rendered on the card; replaced by the job page's title once details load.
          title: job.cardTitle,
          company: null,
          url: job.url,
          description: null,
          descriptionStatus: null,
          location: null,
          salary: null,
          employmentType: null,
          postedAt: null,
          expiresAt: null,
          mcfJobUuid: job.uuid,
          exportedAt: null,
          sourcePage: state.sourcePage,
          originalPostedAt: null,
          availabilityStatus: null,
          availabilityEvidence: null,
          postingCheckedAt: null,
          postingRecheckFailedAt: null,
          postingRecheckFailure: null,
        };
        state.order.push(job.uuid);
        added += 1;
      }
      state.pageCounts.push(jobs.length);
      saveState(state);
      console.log(`[jde] Page ${pageParam() + 1}: ${jobs.length} card(s), ${added} new; ${state.order.length} collected.`);
      const next = nextControl();
      if (!next) return;
      const ids = jobs.map((job) => job.uuid);
      const current = pageParam();
      next.click();
      await waitForPageChange(ids, current);
    }
    console.warn(`[jde] Stopped after the ${MAX_PAGES}-page cap.`);
  }

  /** Plain text from MCF's description HTML, parsed inertly (DOMParser runs no scripts). */
  function htmlToText(html) {
    if (typeof html !== "string" || html.trim() === "") return null;
    const doc = new DOMParser().parseFromString(html, "text/html");
    doc.querySelectorAll("script, style").forEach((element) => element.remove());
    doc.querySelectorAll("br").forEach((element) => element.replaceWith("\n"));
    doc.querySelectorAll("li").forEach((element) => element.prepend("- "));
    doc.querySelectorAll("p, div, li, ul, ol, h1, h2, h3, h4, h5, h6, tr, table").forEach((element) => element.append("\n"));
    const text = (doc.body.textContent || "")
      .replace(/ /g, " ")
      .split("\n")
      .map((line) => line.replace(/[ \t]+/g, " ").trim())
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return text || null;
  }

  /** The employer as MCF shows it: the hiring company for agency posts, else the posting company; null when hidden. */
  function companyOf(detail) {
    const metadata = detail.metadata || {};
    const hiring = detail.hiringCompany && !metadata.isHideHiringEmployerName ? orNull(detail.hiringCompany.name) : null;
    if (hiring) return hiring;
    return metadata.isHideEmployerName ? null : orNull(detail.postedCompany && detail.postedCompany.name);
  }

  function locationOf(detail) {
    const address = detail.address;
    if (!address || (detail.metadata && detail.metadata.isHideCompanyAddress)) return null;
    if (address.isOverseas) {
      return orNull([address.foreignAddress1, address.foreignAddress2, address.overseasCountry].map(clean).filter(Boolean).join(", "));
    }
    const street = [address.block, address.street].map(clean).filter(Boolean).join(" ");
    const parts = [street, clean(address.building), address.postalCode ? `Singapore ${clean(address.postalCode)}` : ""].filter(Boolean);
    return parts.length > 0 ? parts.join(", ") : null;
  }

  function salaryOf(detail) {
    const salary = detail.salary;
    if (!salary || (detail.metadata && detail.metadata.isHideSalary)) return null;
    const amount = (value) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null);
    const min = amount(salary.minimum);
    const max = amount(salary.maximum);
    const period = orNull(salary.type && salary.type.salaryType);
    if ((min === null && max === null) || !period) return null;
    return { min, max, currency: "SGD", period };
  }

  function isoDate(value) {
    const text = clean(value);
    return /^\d{4}-\d{2}-\d{2}/.test(text) ? text : null;
  }

  /** Keeps only the export schema's fields; everything else in the response is dropped here. */
  function applyDetail(job, detail) {
    const metadata = detail.metadata || {};
    const description = htmlToText(detail.description);
    job.title = orNull(detail.title) || job.title;
    job.company = companyOf(detail);
    job.description = description;
    job.descriptionStatus = description && job.title ? "OK" : "MISSING";
    job.location = locationOf(detail);
    job.salary = salaryOf(detail);
    job.employmentType = orNull((detail.employmentTypes || []).map((entry) => clean(entry && entry.employmentType)).filter(Boolean).join(", "));
    job.postedAt = isoDate(metadata.newPostingDate) || isoDate(metadata.originalPostingDate);
    job.originalPostedAt = isoDate(metadata.originalPostingDate);
    job.expiresAt = isoDate(metadata.expiryDate);
    const jobStatus = clean(detail.status && detail.status.jobStatus);
    job.availabilityStatus = /^(open|re-?open(ed)?)$/i.test(jobStatus) ? "OPEN" : /^closed$/i.test(jobStatus) ? "CLOSED" : "UNKNOWN";
    job.availabilityEvidence = jobStatus ? `MyCareersFuture job status: ${jobStatus}`.slice(0, 300) : null;
  }

  /**
   * Jobs to (re)read: no details yet, never checked, or a refresh() requested after the last
   * successful read that has not yet been attempted.
   */
  const needsFetch = (job, state) => job.descriptionStatus !== "OK"
    || !job.postingCheckedAt
    || Boolean(state.refreshRequestedAt
      && job.postingCheckedAt < state.refreshRequestedAt
      && !(job.postingRecheckFailedAt && job.postingRecheckFailedAt >= state.refreshRequestedAt));

  /** A re-check that failed: earlier details and facts keep their original postingCheckedAt; the failure is recorded. */
  function recordFailedRecheck(job, reason) {
    job.postingRecheckFailedAt = new Date().toISOString();
    job.postingRecheckFailure = reason.slice(0, 300);
  }

  async function fetchDetails(state) {
    const pending = state.order.filter((uuid) => needsFetch(state.jobs[uuid], state));
    console.log(`[jde] Fetching ${pending.length} job detail(s), one at a time, about ${DETAIL_BASE_DELAY_MS / 1000}s apart.`);
    for (let index = 0; index < pending.length; index += 1) {
      const job = state.jobs[pending[index]];
      const remaining = pending.length - index;
      let response;
      try {
        response = await fetch(JOB_API + encodeURIComponent(job.mcfJobUuid), {
          method: "GET",
          credentials: "omit",
          headers: { accept: "application/json", "mcf-client": "jobseeker" },
        });
      } catch (error) {
        throw new StopError(`The request for job ${job.mcfJobUuid} failed (${error && error.message}); ${remaining} detail(s) not fetched. Check the connection, then run: await jdeMcfExport.resume()`);
      }
      if (response.status === 429) {
        throw new StopError(`MyCareersFuture rate limited the request (HTTP 429) at job ${job.mcfJobUuid}; ${remaining} detail(s) not fetched. Wait, then run: await jdeMcfExport.resume()`);
      }
      if (response.status >= 500) {
        throw new StopError(`MyCareersFuture returned an error page (HTTP ${response.status}) at job ${job.mcfJobUuid}; ${remaining} detail(s) not fetched. Try later with: await jdeMcfExport.resume()`);
      }
      const readAt = new Date().toISOString();
      const previouslyRead = job.descriptionStatus === "OK" && Boolean(job.postingCheckedAt);
      if (!response.ok && previouslyRead) {
        // A failed re-check (including 404/410) keeps what was read before, with its own check time.
        recordFailedRecheck(job, `HTTP ${response.status}`);
      } else if (response.status === 404 || response.status === 410) {
        job.descriptionStatus = "MISSING";
      } else if (!response.ok) {
        if (job.descriptionStatus !== "OK") job.descriptionStatus = "FETCH_FAILED";
      } else {
        if (!/application\/json/i.test(response.headers.get("content-type") || "")) {
          throw new StopError(`MyCareersFuture returned a non-JSON (error) page at job ${job.mcfJobUuid}; ${remaining} detail(s) not fetched. Check the site in the browser, then run: await jdeMcfExport.resume()`);
        }
        const detail = await response.json();
        if (!detail || String(detail.uuid || "").toLowerCase() !== job.mcfJobUuid) {
          throw new StopError(`MyCareersFuture returned a different job than ${job.mcfJobUuid}; nothing was recorded for it. Run: await jdeMcfExport.resume()`);
        }
        applyDetail(job, detail);
        job.postingCheckedAt = readAt;
        job.postingRecheckFailedAt = null;
        job.postingRecheckFailure = null;
      }
      job.exportedAt = new Date().toISOString();
      saveState(state);
      console.log(`[jde] ${index + 1}/${pending.length} ${job.mcfJobUuid}: ${job.descriptionStatus}`);
      if (index < pending.length - 1) await sleep(jitter());
    }
  }

  function summary(state) {
    const jobs = state.order.map((uuid) => state.jobs[uuid]);
    const count = (status) => jobs.filter((job) => job.descriptionStatus === status).length;
    const pages = state.pageCounts || [];
    const perPage = pages.length > 1 ? pages[0] : null;
    const range = perPage === null
      ? (pages.length === 1 ? `${pages[0]}` : "unknown")
      : `${(pages.length - 1) * perPage + 1}-${pages.length * perPage}`;
    const shortPages = perPage === null ? [] : pages.slice(0, -1).map((n, i) => ({ n, page: i + 1 })).filter((entry) => entry.n !== perPage);
    console.log(`[jde] Saved jobs expected: ${state.expectedTotal ?? "no count shown by MCF"}; pagination implies ${range}; collected: ${jobs.length} over ${pages.length} page(s).`);
    console.log(`[jde] Details OK: ${count("OK")}; MISSING: ${count("MISSING")}; FETCH_FAILED: ${count("FETCH_FAILED")}; not fetched yet: ${count(null)}.`);
    if (state.expectedTotal !== null && state.expectedTotal !== jobs.length) {
      console.warn(`[jde] Collected ${jobs.length} of ${state.expectedTotal} saved jobs. Check the list, then paste the snippet again (collected jobs are kept).`);
    }
    for (const entry of shortPages) {
      console.warn(`[jde] Page ${entry.page} showed ${entry.n} card(s), not ${perPage}; some cards may not have rendered. Paste the snippet again to re-walk the list.`);
    }
  }

  function download() {
    const state = loadState();
    const jobs = state.order.map((uuid) => state.jobs[uuid]);
    if (jobs.length === 0) {
      console.warn("[jde] Nothing collected yet.");
      return;
    }
    const blob = new Blob([JSON.stringify(jobs, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "mcf_saved_jobs.json";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    console.log(`[jde] Downloaded mcf_saved_jobs.json with ${jobs.length} job(s).`);
  }

  async function runDetails(state) {
    try {
      await fetchDetails(state);
    } catch (error) {
      if (!(error instanceof StopError)) throw error;
      console.error(`[jde] STOPPED: ${error.message}`);
    }
    summary(state);
    download();
  }

  async function resume() {
    await runDetails(loadState());
  }

  /** Re-reads every saved job's details (dates and open/closed status), then downloads. */
  async function refresh() {
    // Earlier details and their check times are kept until a re-read succeeds.
    const state = loadState();
    state.refreshRequestedAt = new Date().toISOString();
    saveState(state);
    await runDetails(state);
  }

  function clear() {
    localStorage.removeItem(STORAGE_KEY);
    console.log("[jde] Stored export progress was cleared.");
  }

  window.jdeMcfExport = { resume, refresh, download, clear, summary: () => summary(loadState()) };

  if (location.hostname !== "www.mycareersfuture.gov.sg" || !/^\/saved-jobs\/?$/.test(location.pathname)) {
    console.error("[jde] Open https://www.mycareersfuture.gov.sg/saved-jobs (signed in), stay on page 1, and paste the snippet again.");
    return;
  }
  if (new URLSearchParams(location.search).has("status")) {
    console.error("[jde] Set the filter to \"All Job Status\" so closed saved jobs are included, go to page 1, and paste the snippet again.");
    return;
  }
  if (pageParam() !== 0) {
    console.error("[jde] Go to page 1 of your Saved jobs and paste the snippet again.");
    return;
  }
  if (!document.querySelector(SELECTORS.header)) {
    console.warn("[jde] The \"Saved jobs\" page header was not found; MCF may have changed its markup. Continuing with the job links on the page.");
  }
  const state = loadState();
  state.sourcePage = location.origin + location.pathname;
  try {
    await collectList(state);
  } catch (error) {
    if (!(error instanceof StopError)) throw error;
    console.error(`[jde] STOPPED: ${error.message}`);
    summary(state);
    return;
  }
  state.expectedTotal = shownTotal() ?? state.expectedTotal;
  saveState(state);
  await runDetails(state);
})();
