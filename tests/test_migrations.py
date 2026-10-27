from __future__ import annotations

from sqlalchemy import text


def test_schema_created_by_migrations(engine, _database):
    with engine.connect() as conn:
        tables = {
            row[0]
            for row in conn.execute(
                text(
                    "SELECT table_name FROM information_schema.tables "
                    "WHERE table_schema = 'public'"
                )
            )
        }
        version = conn.execute(text("SELECT version_num FROM alembic_version")).scalar_one()

    expected = {
        "alembic_version",
        "audit_events",
        "companies",
        "documents",
        "idempotency_keys",
        "memberships",
        "quarries",
        "quarry_permissions",
        "users",
    }
    assert expected.issubset(tables)
    assert version
