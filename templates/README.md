# Templates

Starting points for the two things every install has to customise: your career
facts and your lanes. Both are copied into place and edited — the templates
themselves are not read at runtime.

## Profile: `profile/evidence_sources.template.json`

The profile importer reads `private/profile/evidence_sources.json` (override the
location with `PROFILE_DIR`). `private/` is gitignored, so a fresh clone has
nothing to fill in — that is what this template is for.

```bash
mkdir -p private/profile
cp templates/profile/evidence_sources.template.json private/profile/evidence_sources.json
# edit private/profile/evidence_sources.json with your own career facts
npm run profile:import
```

Each entry is validated against `EvidenceSourceInputSchema`:

| Field | Required | Notes |
| --- | --- | --- |
| `source_key` | yes | Unique, 1-128 chars, lowercase snake_case |
| `source_type` | yes | Free text, e.g. `CV`, `LINKEDIN_EXPORT`, `PERFORMANCE_REVIEW` |
| `label` | yes | Human-readable description, 1-256 chars |
| `uri` | no | A URL, or `null` |
| `source_date` | no | `YYYY-MM-DD`, or `null` |
| `verification_status` | no | `VERIFIED`, `SELF_ATTESTED`, or `UNVERIFIED` (default) |
| `metadata` | no | Free-form object; nothing in it is used for matching |

`source_key` is the identity of the evidence. Re-running the importer with the
same keys updates those facts rather than duplicating them.

## Lanes: `lanes/lane.template.yml`

The six lanes in `config/lanes/` are worked examples. This template is the blank
one for adding a seventh, or for replacing the shipped six with your own.

```bash
cp templates/lanes/lane.template.yml config/lanes/my_lane.yml
# edit lane_key, display_name, concepts, prototypes and thresholds
# then add it to config/lanes/registry.yml under `lanes:`
```

Thresholds are the part worth tuning. `minimum_domain_score` and
`minimum_function_score` gate on the concept lists; `minimum_semantic_score`
compares the posting against your `prototypes`. Raising them narrows the lane,
lowering them widens it. Start from the shipped values and change one at a time.

`budget.maximum_ai_interpretations_per_run` is the cost control: it caps how many
postings in this lane may be sent to an AI model per pipeline run.

Because `config/` ships with the desktop installer and lanes are seeded into the
database, edited lanes are picked up on the next seed. To force a re-seed of an
already-seeded workspace, see `scripts/workspace_lanes.ts`.
