"""
signatures.py — service layer for `signature_requests`.

Mocked for the MVP, per the recommended build order: no real
DocuSign/Adobe Sign calls yet. Status is flipped by hand (or by a
simple endpoint call) to demo the full loop — commit -> finalize ->
sign -> completed — before real e-signature integration exists.
"""

from typing import Optional
from supabase import Client

from .models import SignatureRequestCreate, SignatureStatusUpdate


def create_signature_request(client: Client, payload: SignatureRequestCreate) -> dict:
    """
    One signature_requests row per finalized version. In a real
    integration this is where you'd call DocuSign's API and store the
    returned envelope id; for the MVP we just create the row directly
    in 'sent' status.
    """
    resp = (
        client.table("signature_requests")
        .insert(
            {
                "matter_id": payload.matter_id,
                "version_id": payload.version_id,
                "provider": payload.provider,
                "status": "sent",
            }
        )
        .execute()
    )
    return resp.data[0]


def update_signature_status(
    client: Client, request_id: str, payload: SignatureStatusUpdate
) -> dict:
    """
    Manually flips status for the demo (sent -> viewed -> signed ->
    completed). A real DocuSign integration would call this from a
    webhook instead of a person clicking a button in a demo UI.
    """
    resp = (
        client.table("signature_requests")
        .update({"status": payload.status})
        .eq("id", request_id)
        .execute()
    )
    if not resp.data:
        raise ValueError("Signature request not found")
    return resp.data[0]


def get_signature_status(client: Client, version_id: str) -> Optional[dict]:
    resp = (
        client.table("signature_requests")
        .select("*")
        .eq("version_id", version_id)
        .execute()
    )
    return resp.data[0] if resp.data else None
