/**
 * Synthetic LinkedIn guest posting pages (/jobs-guest/jobs/api/jobPosting/<id>),
 * shaped like the markup the export snippet reads. No real postings, employers
 * or people. Every page also carries a "similar jobs" card with its own <time>,
 * which must never be read as the posting's date.
 */
const SIMILAR_JOBS = `
<section class="similar-jobs">
  <ul>
    <li><div class="base-card job-search-card">
      <h3 class="base-search-card__title">Synthetic Other Role</h3>
      <time class="job-search-card__listdate" datetime="2026-01-02">10 months ago</time>
    </div></li>
  </ul>
</section>`;

const DESCRIPTION = `
<div class="description__text description__text--rich">
  <div class="show-more-less-html__markup">
    <p>About the role: Example Synthetic Analytics is hiring a data engineer for its synthetic platform team.</p>
    <p>Responsibilities: design data models, build reporting pipelines and coordinate delivery with product squads.</p>
    <p>Requirements: experience with SQL, Python, cloud warehouses and clear written communication.</p>
  </div>
</div>`;

const TOP_CARD = (postedText: string | null, extra = "") => `
<section class="top-card-layout container-lined overflow-hidden babybear:rounded-[0px]">
  <div class="top-card-layout__entity-info">
    <h2 class="top-card-layout__title font-sans text-lg">Synthetic Data Engineer</h2>
    <h4 class="top-card-layout__second-subline">
      <span class="topcard__flavor"><a class="topcard__org-name-link" href="https://example.invalid/company">Example Synthetic Analytics</a></span>
      <span class="topcard__flavor topcard__flavor--bullet">Singapore, Singapore</span>
      ${postedText === null ? "" : `<span class="posted-time-ago__text topcard__flavor--metadata">
        ${postedText}
      </span>`}
      <span class="num-applicants__caption topcard__flavor--metadata">Over 100 applicants</span>
    </h4>
    ${extra}
  </div>
</section>`;

const APPLY_BUTTON = `<button class="sign-up-modal__outlet top-card-layout__cta mt-2 top-card-layout__cta--primary btn-md btn-primary" data-tracking-control-name="public_jobs_apply-link-onsite">Apply</button>`;

/** Open posting with JSON-LD datePosted / validThrough and the relative age text. */
export const GUEST_PAGE_OPEN_ABSOLUTE = `<!DOCTYPE html><html><head>
<script type="application/ld+json">{"@context":"http://schema.org","@type":"JobPosting","title":"Synthetic Data Engineer","datePosted":"2026-10-28T09:12:00.000Z","validThrough":"2026-12-27T09:12:00.000Z","hiringOrganization":{"@type":"Organization","name":"Example Synthetic Analytics"}}</script>
</head><body>
${TOP_CARD("2 weeks ago", APPLY_BUTTON)}
${DESCRIPTION}
${SIMILAR_JOBS}
</body></html>`;

/** Open posting with only the relative age text (the usual guest fragment). */
export const GUEST_PAGE_OPEN_RELATIVE = `<section class="core-rail">
${TOP_CARD("Reposted 3 days ago", APPLY_BUTTON)}
${DESCRIPTION}
${SIMILAR_JOBS}
</section>`;

/** Closed posting: the "No longer accepting applications" banner, no apply button. */
export const GUEST_PAGE_CLOSED = `<section class="core-rail">
${TOP_CARD("1 month ago", `<figure class="closed-job">
  <figcaption class="closed-job__flavor--closed">No longer accepting applications</figcaption>
</figure>`)}
${DESCRIPTION}
${SIMILAR_JOBS}
</section>`;

/** Neither a posted age nor an apply button nor a closed banner. */
export const GUEST_PAGE_NO_SIGNALS = `<section class="core-rail">
${TOP_CARD(null)}
${DESCRIPTION}
${SIMILAR_JOBS}
</section>`;
