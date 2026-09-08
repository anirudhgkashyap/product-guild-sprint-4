/**
 * config.js — single place to point the frontend at your backend.
 *
 * API_BASE:
 *   The FastAPI service. Left as "/api" because vercel.json rewrites
 *   /api/* to api/main.py — if you deploy the frontend from the same
 *   Vercel project as the backend, this just works with no change.
 *
 * SUPABASE_URL / SUPABASE_ANON_KEY:
 *   A few reads/writes (matter participants, comments, and generating
 *   signed download links for committed .docx files) don't have a
 *   FastAPI route yet. Rather than block the UI on new endpoints, the
 *   frontend talks to Supabase directly for those, using the anon key
 *   + the user's own session — RLS still applies, so this is exactly
 *   as safe as going through the API. The anon key is meant to be
 *   public; never put the service-role key here.
 */
window.APP_CONFIG = {
  API_BASE: "/api",
  SUPABASE_URL: "https://yqxlggragsgivrdkiwft.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_bI6XJEemKtoh6N5-1xg3NA_X78hTtMh",
  STORAGE_BUCKET: "contract-documents",
};