"""
login.py — authentication endpoints for the frontend.

Supabase Auth remains the source of truth for authentication.
This module simply provides FastAPI endpoints that the frontend
can use to sign users in / sign users up.
"""

import os

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from supabase import create_client


router = APIRouter(prefix="/api/auth", tags=["auth"])


SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_PUBLISHABLE_KEY = os.environ["SUPABASE_PUBLISHABLE_KEY"]


# -------------------------------------------------------------------
# Request models
# -------------------------------------------------------------------

class LoginRequest(BaseModel):
    email: str
    password: str


class SignupRequest(BaseModel):
    email: str
    password: str
    full_name: str


# -------------------------------------------------------------------
# Login
# -------------------------------------------------------------------

@router.post("/login")
def login(payload: LoginRequest):
    """
    Authenticate a user through Supabase Auth.

    The returned access_token is the JWT that the frontend should
    send to protected FastAPI endpoints using:

        Authorization: Bearer <access_token>
    """

    try:
        supabase = create_client(
            SUPABASE_URL,
            SUPABASE_PUBLISHABLE_KEY,
        )

        response = supabase.auth.sign_in_with_password(
            {
                "email": payload.email,
                "password": payload.password,
            }
        )

    except Exception as e:
        raise HTTPException(
            status_code=401,
            detail=f"Supabase login error: {str(e)}",
        )

    if response.user is None or response.session is None:
        raise HTTPException(
            status_code=401,
            detail="Invalid email or password",
        )

    return {
        "user": {
            "id": response.user.id,
            "email": response.user.email,
        },
        "access_token": response.session.access_token,
        "refresh_token": response.session.refresh_token,
    }


# -------------------------------------------------------------------
# Signup
# -------------------------------------------------------------------

@router.post("/signup")
def signup(payload: SignupRequest):
    """
    Create a new Supabase Auth user.
    """

    try:
        # Step 1: create Supabase client
        supabase = create_client(
            SUPABASE_URL,
            SUPABASE_PUBLISHABLE_KEY,
        )

        # Step 2: contact Supabase Auth
        response = supabase.auth.sign_up(
            {
                "email": payload.email,
                "password": payload.password,
                "options": {
                    "data": {
                        "full_name": payload.full_name,
                    }
                },
            }
        )

        # Step 3: verify response
        if response.user is None:
            raise HTTPException(
                status_code=400,
                detail="Supabase returned no user",
            )

        result = {
            "user": {
                "id": response.user.id,
                "email": response.user.email,
            }
        }

        if response.session:
            result["access_token"] = response.session.access_token
            result["refresh_token"] = response.session.refresh_token
            result["email_confirmation_required"] = False
        else:
            result["email_confirmation_required"] = True

        return result

    except HTTPException:
        raise

    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"SIGNUP DEBUG ERROR: {type(e).__name__}: {str(e)}",
        )
