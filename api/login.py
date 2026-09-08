import os
from fastapi import APIRouter, HTTPException, status
from gotrue.errors import AuthApiError
from supabase import Client, create_client

# 1. Instantiate client globally to reuse connection pooling
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_PUBLISHABLE_KEY = os.getenv("SUPABASE_PUBLISHABLE_KEY")

supabase: Client = create_client(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY)

router = APIRouter()


@router.post("/signup", status_code=status.HTTP_201_CREATED)
def signup(payload: SignupRequest):
    """
    Create a new Supabase Auth user.
    """
    try:
        # Step 1: Call Supabase Auth
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

        # Step 2: Verify user returned
        if response.user is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Failed to register user.",
            )

        # Step 3: Format response
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

    except AuthApiError as e:
        # Step 4: Handle specific Supabase Auth errors (400 level)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=e.message,
        )

    except HTTPException:
        raise

    except Exception:
        # Step 5: Catch unexpected server errors without exposing internal stack trace
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="An internal error occurred during sign up.",
        )
