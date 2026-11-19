# The Streamlit dashboard

Streamlit is the **results dashboard**, not a second install. Electron does setup,
runs the pipeline, and owns your configuration. Streamlit is where you go when you
want to read, filter, and work through what the pipeline found.

The important part: Streamlit loads the same `.env.local` that `npm run setup`
wrote, so there is nothing to configure a second time.

## Where it fits

| | Electron app | Streamlit dashboard |
| --- | --- | --- |
| Setup wizard | yes | no |
| Owns keys and database config | yes | reads the same file |
| Ingests and ranks jobs | yes | no |
| Browse and filter results | basic | the full view |
| Manual application workflow | limited | the main surface |

Recommended sequence for a new user:

1. Install the app, complete the wizard, let one discovery pass finish.
2. Use the app day to day — it runs the pipeline in the background.
3. When you want to actually read the shortlist in depth, open the dashboard.

Do **not** put both in front of a new user at the same time. That is a fork in
the road at the moment they are least able to choose, and it is the reason this
document exists.

## Prerequisites

- Python 3.11 or newer
- The repository cloned (the dashboard is part of it)
- A `.env.local` — created by `npm run setup`, or by the app's wizard

```bash
python -m pip install -r requirements.txt
```

## Run it

From the repository root, with `.env.local` present:

```bash
streamlit run streamlit_app.py
```

Streamlit prints a local URL (normally `http://localhost:8501`). Open it in a
browser. That is the whole setup.

### Reading vs writing

- **Reading** (shortlist, job details, archive) goes straight to PostgreSQL using
  `DATABASE_URL` from `.env.local`. This works with only the dashboard running.
- **Writing** (manual application steps, approvals, document generation) goes
  through the API, using `JDEC_API_BASE_URL`.

If you only want to read results, you can start nothing else. If you want to make
changes from the dashboard, an API has to be listening:

```bash
npm run dev      # API + web UI on http://localhost:3000
```

That port matches the `JDEC_API_BASE_URL="http://localhost:3000"` default in
`.env.example`, so no edit is needed.

The packaged desktop app runs its own API on loopback port **3217**, and picks a
nearby port if 3217 is taken. If you want the dashboard to make changes while the
desktop app is running instead of `npm run dev`, point the dashboard at that port:

```env
JDEC_API_BASE_URL="http://127.0.0.1:3217"
```

`streamlit run` prints the port it actually bound, and the app logs its own.

## Hosted Streamlit is a different, harder thing

Everything above is the **local** mode. Putting the dashboard on Streamlit
Community Cloud requires a publicly reachable HTTPS API, `JDEC_API_TOKEN`, and a
database the cloud can reach. `streamlit_runtime.py` enforces that: a non-loopback
`JDEC_API_BASE_URL` must be HTTPS and must come with a token.

That is a legitimate deployment, but it is an operations project, not onboarding.
Keep it out of the beginner path. `.streamlit/secrets.toml.template` is the
starting point if you ever want it.

## When it does not start

`streamlit_runtime.py` fails fast with a specific message rather than an empty
dashboard:

- **"requires a valid HTTPS JDEC_API_BASE_URL"** — you have set a non-local API
  URL without HTTPS, so Streamlit assumes hosted mode. For local use, point it at
  `http://localhost:3000` or leave it unset.
- **"Check DATABASE_URL in .env.local, then restart both windows"** — the database
  probe failed. Confirm `npm run setup` completed and that the same `.env.local`
  is in the directory you started Streamlit from.
- **Empty tables, no error** — the pipeline has not produced results yet. Run a
  discovery pass in the app first.
