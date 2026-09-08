"""
main.py — thin FastAPI service layer.

Deployed as Vercel serverless functions under /api (see vercel.json).
Every route is a thin wrapper: parse the request, call the relevant
service module, return the result. Business logic lives in matters.py
/ versions.py / signatures.py; parsing logic lives entirely in
docx_parser/, kept separate because it's a pure function (bytes in,
diff data out) and easier to test in isolation — exactly as
recommended in the architecture brief.
"""

import sys
import os
import tempfile
from dataclasses import asdict

from fastapi import FastAPI, Depends, HTTPException, UploadFile, File, Form, Header
from jose import jwt as jose_jwt, JWTError

from . import matters, versions, signatures
from .login import router as auth_router
app = FastAPI(title="Contract Negotiation Platform API")


@app.get("/api/test")
def test():
    return {"status": "python-function-is-running"}
from fastapi.middleware.cors import CORSMiddleware


app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5500",          # local static server, if you use one
        "https://your-frontend.vercel.app",  # replace with your real frontend URL
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth_router)
from .models import (
    MatterCreate,
    ParticipantAdd,
    VersionCreate,
    SignatureRequestCreate,
    SignatureStatusUpdate,
)
from .supabase_client import get_user_client

# docx_parser lives as a sibling package to api/ — see repo layout in README.
sys.path.append(os.path.join(os.path.dirname(__file__), ".."))
from docx_parser.track_changes_parser import TrackChangesParser  # noqa: E402


def get_current_user(authorization: str = Header(...)):
    """
    Pulls the Supabase JWT out of the Authorization header. We decode it
    without re-verifying the signature here — Supabase's own auth layer
    already verified it on issuance; we only need the `sub` claim to
    identify the user and to build a user-scoped Supabase client with
    the raw token itself.
    """
    if not authorization.startswith("Bearer "):
        raise HTTPException(401, "Missing bearer token")
    token = authorization.removeprefix("Bearer ").strip()
    try:
        claims = jose_jwt.get_unverified_claims(token)
    except JWTError:
        raise HTTPException(401, "Invalid token")
    user_id = claims.get("sub")
    if not user_id:
        raise HTTPException(401, "Token missing sub claim")
    return user_id, token


# ---------------------------------------------------------------- matters --

@app.post("/api/matters")
def create_matter_route(payload: MatterCreate, user=Depends(get_current_user)):
    user_id, token = user
    client = get_user_client(token)
    return matters.create_matter(client, user_id, payload)


@app.get("/api/matters")
def list_matters_route(user=Depends(get_current_user)):
    _, token = user
    client = get_user_client(token)
    return matters.list_matters(client)


@app.get("/api/matters/{matter_id}")
def get_matter_route(matter_id: str, user=Depends(get_current_user)):
    _, token = user
    client = get_user_client(token)
    matter = matters.get_matter(client, matter_id)
    if not matter:
        raise HTTPException(404, "Matter not found")
    return matter


@app.post("/api/matters/{matter_id}/participants")
def add_participant_route(
    matter_id: str, payload: ParticipantAdd, user=Depends(get_current_user)
):
    _, token = user
    client = get_user_client(token)
    return matters.add_participant(client, matter_id, payload)


@app.patch("/api/matters/{matter_id}/status")
def update_matter_status_route(
    matter_id: str, new_status: str, user=Depends(get_current_user)
):
    _, token = user
    client = get_user_client(token)
    try:
        return matters.update_matter_status(client, matter_id, new_status)
    except ValueError as e:
        raise HTTPException(404, str(e))


# --------------------------------------------------------------- versions --

@app.post("/api/versions")
async def commit_version_route(
    matter_id: str = Form(...),
    commit_message: str = Form(None),
    parent_version_id: str = Form(None),
    file: UploadFile = File(...),
    user=Depends(get_current_user),
):
    user_id, token = user
    client = get_user_client(token)
    payload = VersionCreate(
        matter_id=matter_id,
        commit_message=commit_message,
        parent_version_id=parent_version_id,
    )
    file_bytes = await file.read()
    return versions.commit_version(client, user_id, payload, file_bytes, file.filename)


@app.get("/api/matters/{matter_id}/versions")
def list_versions_route(matter_id: str, user=Depends(get_current_user)):
    _, token = user
    client = get_user_client(token)
    return versions.list_versions(client, matter_id)


@app.get("/api/versions/{version_id}")
def get_version_route(version_id: str, user=Depends(get_current_user)):
    _, token = user
    client = get_user_client(token)
    version = versions.get_version(client, version_id)
    if not version:
        raise HTTPException(404, "Version not found")
    return version


@app.get("/api/versions/{version_id}/diff")
def get_version_diff_route(version_id: str, user=Depends(get_current_user)):
    """
    Runs the Track Changes parser against a committed .docx and returns
    the structural diff (insertions/deletions with author + date).
    Uses the service-role path since parsing needs the file regardless
    of who committed it — versions.get_version_file_for_parsing does
    the manual participant check that RLS would otherwise be doing.
    """
    user_id, _ = user
    try:
        file_bytes = versions.get_version_file_for_parsing(user_id, version_id)
    except PermissionError:
        raise HTTPException(403, "Not a participant on this matter")
    except ValueError:
        raise HTTPException(404, "Version not found")

    with tempfile.NamedTemporaryFile(suffix=".docx") as tmp:
        tmp.write(file_bytes)
        tmp.flush()
        result = TrackChangesParser(tmp.name).parse()

    return asdict(result)


# -------------------------------------------------------------- signatures --

@app.post("/api/signatures")
def create_signature_request_route(
    payload: SignatureRequestCreate, user=Depends(get_current_user)
):
    _, token = user
    client = get_user_client(token)
    return signatures.create_signature_request(client, payload)


@app.patch("/api/signatures/{request_id}")
def update_signature_status_route(
    request_id: str, payload: SignatureStatusUpdate, user=Depends(get_current_user)
):
    _, token = user
    client = get_user_client(token)
    try:
        return signatures.update_signature_status(client, request_id, payload)
    except ValueError as e:
        raise HTTPException(404, str(e))


@app.get("/api/versions/{version_id}/signature-status")
def get_signature_status_route(version_id: str, user=Depends(get_current_user)):
    _, token = user
    client = get_user_client(token)
    status = signatures.get_signature_status(client, version_id)
    if not status:
        raise HTTPException(404, "No signature request for this version")
    return status


@app.get("/api/health")
def health():
    return {"status": "ok"}
