# MVP Backend — Spike 1 (.docx parser) + Spike 2 (FastAPI service layer)

## Layout

```
mvp-backend/
├── docx_parser/
│   ├── track_changes_parser.py   # the actual spike: w:ins/w:del extraction
│   └── make_test_docx.py         # builds a fixture .docx with real tracked changes
├── api/
│   ├── supabase_client.py        # user-scoped vs service-role client factory
│   ├── models.py                 # Pydantic request bodies
│   ├── matters.py                # matters + matter_participants
│   ├── versions.py               # versions table + Storage + parsing handoff
│   ├── signatures.py             # mocked signature_requests
│   └── main.py                   # FastAPI app, one route per use-case
├── requirements.txt
└── vercel.json
```

## 1. Running the parsing spike standalone

No server needed — this is a pure function you can validate right now:

```bash
pip install -r requirements.txt
cd docx_parser
python make_test_docx.py sample.docx      # builds a fixture with tracked changes
python track_changes_parser.py sample.docx --json out.json
```

Swap `sample.docx` for a real redlined contract once you have one —
the parser doesn't care how the file was produced, only that it has
real `w:ins`/`w:del` markup, which any Word "Track Changes" save will have.

**What "validated" means here:** the parser correctly separated two
authors, two dates, one insertion+deletion pair in the same paragraph,
and left the untouched third paragraph alone. That's the structural
signal the rest of the product depends on.

## 2. Running the API locally

Set the three env vars from the Supabase project settings:

```bash
export SUPABASE_URL="https://xxxx.supabase.co"
export SUPABASE_ANON_KEY="..."
export SUPABASE_SERVICE_ROLE_KEY="..."   # keep this one out of the frontend, obviously

cd mvp-backend
uvicorn api.main:app --reload --port 8000
```

Every route expects `Authorization: Bearer <supabase-jwt>` — this is
the JWT Supabase Auth hands your frontend after login; the API doesn't
issue its own tokens.

Quick smoke test once a matter/version exist:
```bash
curl -H "Authorization: Bearer $JWT" http://localhost:8000/api/matters
curl -H "Authorization: Bearer $JWT" http://localhost:8000/api/versions/<version_id>/diff
```

## 3. Deploying to Vercel

`vercel.json` routes every `/api/*` request to the single FastAPI app
in `api/main.py` (rather than one function per file), since the routes
share service modules and a client factory. Set the same three env
vars in the Vercel project settings before deploying.

## What's intentionally NOT here

- Real DocuSign/Adobe Sign calls — `signatures.py` is mocked, per the
  recommended build order (mock signing last).
- Clause-level/semantic diffing — the parser above is structural only.
- The stricter "both sides must agree before finalizing" status check
  flagged as an open item in the architecture brief — current code
  matches what the schema's RLS policy allows today (either side can
  move status), not the tightened version.
