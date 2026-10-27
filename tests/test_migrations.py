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
        "folders",
        "idempotency_keys",
        "memberships",
        "platform_admins",
        "quarries",
        "quarry_permissions",
        "users",
    }
    assert expected.issubset(tables)
    assert version

    with engine.connect() as conn:
        folder_columns = {
            row[0]
            for row in conn.execute(
                text(
                    "SELECT column_name FROM information_schema.columns "
                    "WHERE table_schema = 'public' AND table_name = 'folders'"
                )
            )
        }
        folder_indexes = {
            row[0]: row[1]
            for row in conn.execute(
                text(
                    "SELECT indexname, indexdef FROM pg_indexes "
                    "WHERE schemaname = 'public' AND tablename = 'folders'"
                )
            )
        }
        folder_fks = dict(
            conn.execute(
                text(
                    "SELECT conname, confdeltype FROM pg_constraint "
                    "WHERE conrelid = 'folders'::regclass AND contype = 'f'"
                )
            ).all()
        )
        document_indexes = {
            row[0]
            for row in conn.execute(
                text(
                    "SELECT indexname FROM pg_indexes "
                    "WHERE schemaname = 'public' AND tablename = 'documents'"
                )
            )
        }
        document_fk = conn.execute(
            text(
                "SELECT confdeltype FROM pg_constraint "
                "WHERE conrelid = 'documents'::regclass "
                "AND conname = 'fk_documents_folder_id'"
            )
        ).scalar_one()
        folder_is_nullable = conn.execute(
            text(
                "SELECT is_nullable FROM information_schema.columns "
                "WHERE table_schema = 'public' AND table_name = 'documents' "
                "AND column_name = 'folder_id'"
            )
        ).scalar_one()

    assert {
        "id",
        "company_id",
        "quarry_id",
        "parent_id",
        "name",
        "created_at",
        "updated_at",
    }.issubset(folder_columns)

    # Empty-folder deletion is enforced by the service; the schema nevertheless
    # keeps tenant ownership and the self-referencing tree consistent.
    assert folder_fks["folders_company_id_fkey"] == "c"
    assert folder_fks["folders_quarry_id_fkey"] == "c"
    assert folder_fks["folders_parent_id_fkey"] == "c"

    # Existing documents must survive as root/unfiled: the column is nullable,
    # and a folder delete must not delete its documents.
    assert folder_is_nullable == "YES"
    assert document_fk == "n"
    assert "ix_documents_folder_id" in document_indexes

    assert "uq_folders_root_name" in folder_indexes
    assert "uq_folders_child_name" in folder_indexes
    assert "parent_id IS NULL" in folder_indexes["uq_folders_root_name"]
    assert "parent_id IS NOT NULL" in folder_indexes["uq_folders_child_name"]
    assert "lower" in folder_indexes["uq_folders_root_name"]
    assert "lower" in folder_indexes["uq_folders_child_name"]
