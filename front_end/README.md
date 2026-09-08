# Frontend — Contract Negotiation Platform

Static HTML/CSS/JS implementing the four screens from the Figma mockups
(Active Negotiations, Version Timeline, Commit New Version, Compare
Versions) plus a login/signup screen designed to match the same visual
system (no mockup was provided for it).

## Files

Everything lives flat in one folder on purpose — no `css/`/`js/`
subfolders — so it survives being downloaded/unzipped as individual
files without anything breaking:

```
index.html            redirect to login or dashboard based on session
login.html            sign in / sign up
dashboard.html + dashboard.js     Active Negotiations
matter.html + matter.js           Version Timeline for one matter
commit.html + commit.js           Commit New Version
compare.html + compare.js         Compare Versions + finalize + e-sign
styles.css            shared design system (one file, all pages)
api.js                API client, session/auth helpers, Supabase helpers
config.js             ⚠️ fill this in before running anything
CORS_PATCH.txt        a snippet for api/main.py — see "Stuck on sign in?" below
```

## Stuck on sign-in, or the page looks unstyled?

Two separate things cause this, check both:

1. **Files must stay together, flat, in one folder.** If `styles.css`
   or `api.js` land somewhere other than next to the `.html` files
   (e.g. downloaded one at a time into a Downloads folder full of other
   stuff), the page loses all styling (you'll see plain black-and-white
   browser-default text) *and* the sign-in form stops working, because
   the JS that intercepts the submit never loads — the button just does
   a plain page reload instead of calling the API. Unzip the provided
   `frontend.zip` in place rather than downloading files individually,
   or keep them together if you do.
2. **CORS.** If the frontend is served from a different origin than the
   API (a different Vercel deployment, a local static server, opening
   the file directly), the browser blocks the login request before your
   route code even runs — from the UI this looks identical to "nothing
   happens." `api/main.py` doesn't have CORS middleware yet; see
   `CORS_PATCH.txt` for the two lines to add. If you deploy the frontend
   from the same Vercel project as the backend (so `/api` is
   same-origin), you don't need this at all.

## Setup

1. **API_BASE** in `config.js` is `/api`, matching `vercel.json`'s
   rewrite of `/api/*` to `api/main.py`. Deploy this frontend from the
   same Vercel project as the backend and it works with no changes.
2. **SUPABASE_URL / SUPABASE_ANON_KEY** in `config.js` — see "Why
   Supabase is called directly" below. The anon key is safe to ship in
   frontend code (that's what it's for); never put the service-role
   key here.
3. Everything else is plain static files — no build step.

## Why Supabase is called directly for a few things

`main.py`'s current routes don't cover everything the mockups show:
reading *who else* is on a matter, reading/posting comments, or
generating a download link for a committed file. Rather than block the
UI on new backend routes, the frontend uses `supabase-js` directly
(loaded from CDN) for those, authenticated with the same access token
you get back from `/api/auth/login` — so Postgres RLS enforces exactly
the same rules it would if a FastAPI route did it. This is a common,
legitimate pattern in Supabase apps: FastAPI for real business logic,
`supabase-js` for RLS-scoped reads/writes.

If you'd rather not expose the anon key / add supabase-js to the
frontend, the alternative is adding a handful of GET routes to the
backend (`GET /api/matters/{id}/participants`, `GET
/api/versions/{id}/comments`, `POST` for comments, and a download/
signed-URL route) and swapping the `Db.*` calls in `js/api.js` for
`Api.*` calls — the rest of the frontend doesn't need to change.

## Known gaps / simplifications (backend-driven)

These aren't frontend bugs — they're places where the current backend
doesn't yet have what the mockup implies. Flagging them so you know
what "finishing the four Figma screens" still needs on the backend
side:

- **Inviting a counterparty** needs their Supabase user UUID today —
  there's no "invite by email" endpoint, so the "New Negotiation"
  modal has a raw ID field as a stopgap.
- **"Your turn" / "Awaiting counterparty"** is computed on the frontend
  (compare `committed_by` on the latest version against the logged-in
  user), since there's no status field for it in the schema.
- **Compare Versions** shows the tracked-changes fragments
  (`w:ins`/`w:del` text) that `track_changes_parser.py` pulls out of
  the *"to"* version's own XML — deletions in the left panel,
  insertions in the right. It cannot reconstruct full side-by-side
  paragraph text for an arbitrary pair of versions, because the parser
  only extracts the changed runs, not the surrounding unchanged text.
  Good enough to show what changed; not a full two-document diff yet.
- **"Mark as final"** calls `PATCH /api/matters/{id}/status` with
  `executed` — there's no per-version "final" flag exposed via the API
  yet (the `versions.status` column exists in the schema but nothing
  writes to it).
- **E-signature signer rows** all show the same status pill, because
  `signature_requests` tracks one status for the whole request, not
  per-signer. The "Mark as sent/viewed/signed/completed" buttons mirror
  the manual-flip demo flow described in `signatures.py`.
- **"Notify counterparty immediately"** toggle is UI-only — there's no
  email/notification backend yet. The commit itself becomes visible to
  the counterparty as soon as it's created (RLS handles that), just
  without a proactive notification.
- **Login page** has no source mockup; it borrows the dark-navy/blue
  system from the other four screens.

## Local preview

Any static file server works, e.g.:

```
cd frontend
python3 -m http.server 5500
```

Then open `http://localhost:5500/login.html`. Note the backend needs
CORS enabled for a non-Vercel origin like this — for a real deploy,
serve both from the same Vercel project so `/api` is same-origin.
