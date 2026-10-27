from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

STATIC_DIR = Path(__file__).resolve().parents[1] / "dashboard"
INDEX_HTML = STATIC_DIR / "index.html"

router = APIRouter(prefix="/dashboard", tags=["dashboard"])


class DashboardConfig(BaseModel):
    # Public values only. The service-role key is NEVER returned here.
    supabase_url: str
    supabase_anon_key: str


@router.get("/config", response_model=DashboardConfig)
def dashboard_config(request: Request) -> DashboardConfig:
    settings = request.app.state.settings
    return DashboardConfig(
        supabase_url=settings.supabase_url,
        supabase_anon_key=settings.supabase_anon_key,
    )


# Supabase auth links return here with the tokens in the URL fragment; the SPA
# (index.html) reads and handles them. These routes keep the URLs pretty and
# allow-list friendly.
@router.get("/accept-invite", include_in_schema=False)
def accept_invite() -> FileResponse:
    return FileResponse(INDEX_HTML)


@router.get("/reset-password", include_in_schema=False)
def reset_password() -> FileResponse:
    return FileResponse(INDEX_HTML)


def mount_static(app) -> None:
    """Serve the dashboard SPA. Call AFTER including ``router`` so that
    ``/dashboard/config`` is matched before the catch-all static mount."""
    app.mount(
        "/dashboard",
        StaticFiles(directory=str(STATIC_DIR), html=True),
        name="dashboard",
    )
