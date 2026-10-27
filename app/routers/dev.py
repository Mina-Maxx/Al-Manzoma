from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel

from app.security.jwt import sign_dev_token

router = APIRouter(prefix="/dev", tags=["dev"])


class TokenRequest(BaseModel):
    sub: str
    expires_in: int = 3600


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"


@router.post("/token", response_model=TokenResponse)
def issue_dev_token(body: TokenRequest, request: Request) -> TokenResponse:
    settings = request.app.state.settings
    if not settings.dev_auth_active:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="not found"
        )
    token = sign_dev_token(settings, body.sub, body.expires_in)
    return TokenResponse(access_token=token)
