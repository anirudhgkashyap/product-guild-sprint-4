"""
versions.py — service layer for the `versions` table + Storage.

Two access patterns live here, deliberately kept apart:

1. Normal commit/list/get flows use the USER-scoped client. RLS
   enforces "is this user actually a participant on this matter?"
   automatically — this file doesn't need to check that itself.

2. get_version_file_for_parsing() uses the SERVICE-role client, because
   the .docx parser needs to read the file regardless of who committed
   it. Since the service client bypasses RLS, this function manually
   re-implements the participant check before returning any bytes —
   this is the one rule from the architecture brief worth keeping in
   mind: "service role key = you are now responsible for the access
   check Postgres was doing for you."
"""

from typing import Optional
from supabase import Client
from fastapi import HTTPException

from .models import VersionCreate
from .supabase_client import get_service_client, is_matter_participant

STORAGE_BUCKET = "contract-documents"


def _file_path(matter_id: str, version_id: str, filename: str) -> str:
    # Matches the convention from the architecture brief exactly:
    # {matter_id}/{version_id}_{filename}
    return f"{matter_id}/{version_id}_{filename}"




def commit_version(
    client: Client,
    user_id: str,
    payload: VersionCreate,
    file_bytes: bytes,
    filename: str,
) -> dict:
    participant_resp = (
        client.table("matter_participants")
        .select("side")
        .eq("matter_id", payload.matter_id)
        .eq("user_id", user_id)
        .maybe_single()   # <-- returns None instead of raising when 0 rows match
        .execute()
    )

    if participant_resp is None or not participant_resp.data:
        raise HTTPException(403, "You are not a participant on this matter")

    side = participant_resp.data["side"]

    version_resp = (
        client.table("versions")
        .insert(
            {
                "matter_id": payload.matter_id,
                "commit_message": payload.commit_message,
                "parent_version_id": payload.parent_version_id,
                "committed_by": user_id,
                "side": side,
                "file_path": "",
                "file_name": filename,
            }
        )
        .execute()
    )
    version = version_resp.data[0]
    path = _file_path(payload.matter_id, version["id"], filename)

    try:
        client.storage.from_(STORAGE_BUCKET).upload(
            path,
            file_bytes,
            {
                "content-type": (
                    "application/vnd.openxmlformats-officedocument"
                    ".wordprocessingml.document"
                )
            },
        )
    except Exception:
        client.table("versions").delete().eq("id", version["id"]).execute()
        raise

    updated = (
        client.table("versions")
        .update({"file_path": path})
        .eq("id", version["id"])
        .execute()
    )
    return updated.data[0]


def list_versions(client: Client, matter_id: str) -> list[dict]:
    resp = (
        client.table("versions")
        .select("*")
        .eq("matter_id", matter_id)
        .order("version_number", desc=False)
        .execute()
    )
    return resp.data


def get_version(client: Client, version_id: str) -> Optional[dict]:
    resp = client.table("versions").select("*").eq("id", version_id).execute()
    return resp.data[0] if resp.data else None


def get_version_file_for_parsing(user_id: str, version_id: str) -> bytes:
    """
    Service-role path used by the .docx parsing job/endpoint. Because
    this bypasses RLS, we manually re-check participation before
    touching the file at all.

    Raises:
        ValueError: version doesn't exist
        PermissionError: user_id is not a participant on this matter
    """
    admin = get_service_client()

    version_resp = admin.table("versions").select("*").eq("id", version_id).execute()
    if not version_resp.data:
        raise ValueError("Version not found")
    version = version_resp.data[0]

    if not is_matter_participant(admin, user_id, version["matter_id"]):
        raise PermissionError("User is not a participant on this matter")

    return admin.storage.from_(STORAGE_BUCKET).download(version["file_path"])
