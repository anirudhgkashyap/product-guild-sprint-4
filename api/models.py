"""
models.py — Pydantic request bodies for the FastAPI routes.

Kept deliberately thin: these mirror the table shapes from the schema
brief (matters, versions, comments, signature_requests) closely enough
to validate input, without trying to be a full ORM layer.
"""

from typing import Optional, Literal
from pydantic import BaseModel


class MatterCreate(BaseModel):
    title: str
    description: Optional[str] = None


class ParticipantAdd(BaseModel):
    user_id: str
    side: Literal["drafting", "counterparty"]


class VersionCreate(BaseModel):
    matter_id: str
    commit_message: Optional[str] = None
    parent_version_id: Optional[str] = None


class SignatureRequestCreate(BaseModel):
    matter_id: str
    version_id: str
    provider: Literal["mock", "docusign", "adobe_sign"] = "mock"


class SignatureStatusUpdate(BaseModel):
    status: Literal[
        "not_sent",
        "sent",
        "viewed",
        "signed",
        "completed",
        "declined",
    ]
