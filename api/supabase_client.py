"""
supabase_client.py — client factory.

Two distinct client types, matching the access-control section of the
architecture brief exactly:

- get_user_client(jwt): anon key + the requesting user's own JWT. RLS
  policies apply automatically, so Postgres filters every query to
  whatever this user is allowed to see. Use this for almost everything.

- get_service_client(): service role key, which BYPASSES RLS entirely.
  Only use where the backend genuinely needs cross-participant access
  (e.g. the .docx parser reading a file regardless of who uploaded it).
  Any code path using this client is responsible for re-implementing
  the "is this user allowed to see this matter?" check itself — see
  is_matter_participant() below.
"""

import os
from functools import lru_cache

from supabase import create_client, Client

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_PUBLISHABLE_KEY = os.environ["SUPABASE_PUBLISHABLE_KEY"]
SUPABASE_SECRET_KEY = os.environ["SUPABASE_SECRET_KEY"]


def get_user_client(jwt: str) -> Client:
    """
    Client scoped to one user's session. Because it authenticates with
    the user's own JWT, every query is filtered by RLS exactly as if
    the user ran it themselves in the Supabase dashboard — no manual
    "does user X own matter Y" checks needed anywhere that uses this.
    """
    client = create_client(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY)
    client.postgrest.auth(jwt)
    return client


@lru_cache
def get_service_client() -> Client:
    """
    Admin client. Bypasses RLS entirely. Cached because it's stateless
    and safe to reuse across requests, unlike the per-user client above
    which is tied to one specific JWT.
    """
    return create_client(SUPABASE_URL, SUPABASE_SECRET_KEY)


def is_matter_participant(client: Client, user_id: str, matter_id: str) -> bool:
    """
    Python-side mirror of the is_matter_participant() Postgres function.
    Call this ONLY when you're on the service-role client (which
    bypasses the database-level check). If you're on the user-scoped
    client, RLS already enforces this and calling it again is redundant.
    """
    resp = (
        client.table("matter_participants")
        .select("id")
        .eq("matter_id", matter_id)
        .eq("user_id", user_id)
        .limit(1)
        .execute()
    )
    return len(resp.data) > 0
