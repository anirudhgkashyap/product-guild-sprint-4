"""
matters.py — service layer for the `matters` and `matter_participants`
tables.

Every function here takes an already-scoped Supabase client (built via
supabase_client.get_user_client) and relies on Postgres RLS to enforce
visibility. There are no manual permission checks in this file — we're
always on the user-scoped client here, so the database is already
doing that work.
"""

from typing import Optional
from supabase import Client

from .models import MatterCreate, ParticipantAdd


def create_matter(client: Client, user_id: str, payload: MatterCreate) -> dict:
    """
    Creates a matter and adds the creator as its first participant on
    the 'drafting' side. Two inserts — if the second one fails, we roll
    back the first, rather than leaving a matter with zero participants
    (which would be invisible to everyone, including its creator, the
    moment RLS is applied — nobody would be able to add participants to
    fix it either).
    """
    matter_resp = (
        client.table("matters")
        .insert(
            {
                "title": payload.title,
                "description": payload.description,
                "created_by": user_id,
                "status": "active",
            }
        )
        .execute()
    )
    matter = matter_resp.data[0]

    return matter


def list_matters(client: Client) -> list[dict]:
    """RLS already restricts this to matters the caller participates in."""
    resp = (
        client.table("matters")
        .select("*")
        .order("created_at", desc=True)
        .execute()
    )
    return resp.data


def get_matter(client: Client, matter_id: str) -> Optional[dict]:
    resp = client.table("matters").select("*").eq("id", matter_id).execute()
    return resp.data[0] if resp.data else None


def add_participant(client: Client, matter_id: str, payload: ParticipantAdd) -> dict:
    """
    Adds the counterparty (or another colleague) to a matter. RLS on
    matter_participants means only existing participants of THIS matter
    can add new ones — if the caller isn't already on it, Postgres
    rejects the insert regardless of what this function does.
    """
    resp = (
        client.table("matter_participants")
        .insert(
            {"matter_id": matter_id, "user_id": payload.user_id, "side": payload.side}
        )
        .execute()
    )
    return resp.data[0]


def update_matter_status(client: Client, matter_id: str, new_status: str) -> dict:
    """
    Carried-over open item from the architecture brief: the current
    update policy lets either side move status — including to
    'in_signature' — with no check that both sides agreed first. Fine
    for the demo; worth tightening (e.g. requiring both sides to flag a
    version "ready") before this goes near real use.
    """
    resp = (
        client.table("matters").update({"status": new_status}).eq("id", matter_id).execute()
    )
    if not resp.data:
        raise ValueError("Matter not found or not permitted")
    return resp.data[0]
