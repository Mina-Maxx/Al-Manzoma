from __future__ import annotations

import os
import uuid
from pathlib import Path

from alembic import command
from alembic.config import Config as AlembicConfig
from sqlalchemy import insert, text

from app.models import Company, CompanyStatus

ROOT = Path(__file__).resolve().parents[1]


def _alembic_config(engine) -> AlembicConfig:
    config = AlembicConfig(str(ROOT / "alembic.ini"))
    config.set_main_option("script_location", str(ROOT / "alembic"))
    os.environ["ALEMBIC_DATABASE_URL"] = engine.url.render_as_string(
        hide_password=False
    )
    return config


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
        "change_log",
        "companies",
        "company_sync_state",
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
        document_columns = {
            row[0]
            for row in conn.execute(
                text(
                    "SELECT column_name FROM information_schema.columns "
                    "WHERE table_schema = 'public' AND table_name = 'documents'"
                )
            )
        }
        version_constraints = {
            row[0]: row[1]
            for row in conn.execute(
                text(
                    "SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint "
                    "WHERE conrelid IN ('folders'::regclass, 'documents'::regclass) "
                    "AND contype = 'c'"
                )
            )
        }

    assert {
        "id",
        "company_id",
        "quarry_id",
        "parent_id",
        "name",
        "version",
        "deleted_at",
        "created_at",
        "updated_at",
    }.issubset(folder_columns)
    assert {"version", "deleted_at"}.issubset(document_columns)
    assert "version >= 1" in version_constraints["ck_folders_version_positive"]
    assert "version >= 1" in version_constraints["ck_documents_version_positive"]

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
    assert "deleted_at IS NULL" in folder_indexes["uq_folders_root_name"]
    assert "deleted_at IS NULL" in folder_indexes["uq_folders_child_name"]
    assert "lower" in folder_indexes["uq_folders_root_name"]
    assert "lower" in folder_indexes["uq_folders_child_name"]

    with engine.connect() as conn:
        sync_columns = {
            (row[0], row[1]): {
                "type": row[2],
                "nullable": row[3],
                "default": row[4],
            }
            for row in conn.execute(
                text(
                    "SELECT table_name, column_name, data_type, is_nullable, "
                    "column_default FROM information_schema.columns "
                    "WHERE table_schema = 'public' "
                    "AND table_name IN ('company_sync_state', 'change_log')"
                )
            )
        }
        sync_constraints = {
            row[0]: {
                "type": row[1],
                "delete_action": row[2],
                "definition": row[3],
            }
            for row in conn.execute(
                text(
                    "SELECT conname, contype, confdeltype, "
                    "pg_get_constraintdef(oid) FROM pg_constraint "
                    "WHERE conrelid IN "
                    "('company_sync_state'::regclass, 'change_log'::regclass)"
                )
            )
        }
        sync_indexes = {
            row[0]
            for row in conn.execute(
                text(
                    "SELECT indexname FROM pg_indexes WHERE schemaname = 'public' "
                    "AND tablename IN ('company_sync_state', 'change_log')"
                )
            )
        }

    assert {
        column
        for table, column in sync_columns
        if table == "company_sync_state"
    } == {
        "company_id",
        "feed_epoch",
        "last_seq",
        "min_valid_seq",
        "updated_at",
    }
    assert {
        column
        for table, column in sync_columns
        if table == "change_log"
    } == {
        "company_id",
        "seq",
        "quarry_id",
        "entity_type",
        "entity_id",
        "change_type",
        "entity_version",
        "payload",
        "created_at",
    }

    state = {
        column: sync_columns[("company_sync_state", column)]
        for column in (
            "company_id",
            "feed_epoch",
            "last_seq",
            "min_valid_seq",
            "updated_at",
        )
    }
    assert state["company_id"]["type"] == "uuid"
    assert state["company_id"]["nullable"] == "NO"
    assert state["feed_epoch"]["type"] == "uuid"
    assert "gen_random_uuid" in state["feed_epoch"]["default"]
    assert state["last_seq"]["type"] == "bigint"
    assert "0" in state["last_seq"]["default"]
    assert state["min_valid_seq"]["type"] == "bigint"
    assert "0" in state["min_valid_seq"]["default"]
    assert "now()" in state["updated_at"]["default"]

    changes = {
        column: sync_columns[("change_log", column)]
        for column in (
            "company_id",
            "seq",
            "quarry_id",
            "entity_type",
            "entity_id",
            "change_type",
            "entity_version",
            "payload",
            "created_at",
        )
    }
    assert changes["seq"]["type"] == "bigint"
    assert changes["entity_version"]["type"] == "integer"
    assert changes["payload"]["type"] == "jsonb"
    assert "{}" in changes["payload"]["default"]
    assert changes["created_at"]["type"] == "timestamp with time zone"
    assert changes["created_at"]["nullable"] == "NO"

    assert sync_constraints["company_sync_state_pkey"]["type"] == "p"
    assert sync_constraints["change_log_pkey"]["type"] == "p"
    assert "company_id" in sync_constraints["change_log_pkey"]["definition"]
    assert "seq" in sync_constraints["change_log_pkey"]["definition"]

    assert (
        sync_constraints["fk_company_sync_state_company_id"]["delete_action"] == "c"
    )
    assert sync_constraints["fk_change_log_company_id"]["delete_action"] == "r"
    assert sync_constraints["fk_change_log_quarry_id"]["delete_action"] == "r"

    assert (
        "last_seq >= 0"
        in sync_constraints["ck_company_sync_state_last_seq_nonnegative"][
            "definition"
        ]
    )
    assert (
        "min_valid_seq >= 0"
        in sync_constraints["ck_company_sync_state_min_valid_seq_nonnegative"][
            "definition"
        ]
    )
    assert (
        "min_valid_seq <= last_seq"
        in sync_constraints["ck_company_sync_state_min_valid_seq_lte_last_seq"][
            "definition"
        ]
    )
    for value in ("folder", "document"):
        assert (
            value in sync_constraints["ck_change_log_entity_type"]["definition"]
        )
    for value in ("created", "updated", "deleted"):
        assert (
            value in sync_constraints["ck_change_log_change_type"]["definition"]
        )
    assert (
        "entity_version > 0"
        in sync_constraints["ck_change_log_entity_version_positive"]["definition"]
    )
    assert "seq > 0" in sync_constraints["ck_change_log_seq_positive"]["definition"]

    assert "ix_change_log_company_created_at" in sync_indexes
    assert "ix_change_log_quarry_id" in sync_indexes


def test_migration_backfills_state_for_existing_companies(engine, _database):
    config = _alembic_config(engine)
    command.downgrade(config, "e5f6a7b8c9d0")

    with engine.connect() as conn:
        assert (
            conn.execute(
                text("SELECT to_regclass('public.company_sync_state')")
            ).scalar_one()
            is None
        )
        assert (
            conn.execute(text("SELECT to_regclass('public.change_log')")).scalar_one()
            is None
        )

    company_ids = [uuid.uuid4(), uuid.uuid4()]
    with engine.begin() as conn:
        conn.execute(
            insert(Company),
            [
                {
                    "id": company_id,
                    "name": f"Migration Company {index}",
                    "status": CompanyStatus.active,
                    "quota_bytes": 1_000,
                    "max_users": 10,
                }
                for index, company_id in enumerate(company_ids)
            ],
        )

    command.upgrade(config, "head")

    with engine.connect() as conn:
        rows = conn.execute(
            text(
                "SELECT company_id, feed_epoch, last_seq, min_valid_seq "
                "FROM company_sync_state ORDER BY company_id"
            )
        ).all()
        change_count = conn.execute(
            text("SELECT count(*) FROM change_log")
        ).scalar_one()

    assert {row[0] for row in rows} == set(company_ids)
    assert all(row[2] == 0 and row[3] == 0 for row in rows)
    assert len({row[1] for row in rows}) == len(company_ids)
    assert change_count == 0


def test_versioning_migration_backfills_and_round_trips(engine, _database):
    config = _alembic_config(engine)
    command.downgrade(config, "a7c1e9d4b2f0")

    company_id = uuid.uuid4()
    quarry_id = uuid.uuid4()
    folder_id = uuid.uuid4()
    document_id = uuid.uuid4()
    with engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO companies "
                "(id, name, status, quota_bytes, max_users) VALUES "
                "(:id, :name, CAST(:status AS company_status), 1000, 10)"
            ),
            {
                "id": company_id,
                "name": "Version Migration Co",
                "status": "active",
            },
        )
        conn.execute(
            text(
                "INSERT INTO quarries (id, company_id, name, status) VALUES "
                "(:id, :company_id, :name, CAST(:status AS quarry_status))"
            ),
            {
                "id": quarry_id,
                "company_id": company_id,
                "name": "North Pit",
                "status": "active",
            },
        )
        conn.execute(
            text(
                "INSERT INTO folders "
                "(id, company_id, quarry_id, parent_id, name) VALUES "
                "(:id, :company_id, :quarry_id, NULL, :name)"
            ),
            {
                "id": folder_id,
                "company_id": company_id,
                "quarry_id": quarry_id,
                "name": "Plans",
            },
        )
        conn.execute(
            text(
                "INSERT INTO documents "
                "(id, company_id, quarry_id, folder_id, display_name, "
                "original_filename, mime_type, size_bytes, sha256, storage_ref, "
                "status) VALUES "
                "(:id, :company_id, :quarry_id, :folder_id, :display_name, "
                ":original_filename, :mime_type, 100, :sha256, :storage_ref, "
                "CAST(:status AS document_status))"
            ),
            {
                "id": document_id,
                "company_id": company_id,
                "quarry_id": quarry_id,
                "folder_id": folder_id,
                "display_name": "report.pdf",
                "original_filename": "report.pdf",
                "mime_type": "application/pdf",
                "sha256": "a" * 64,
                "storage_ref": "ref-1",
                "status": "available",
            },
        )

    command.upgrade(config, "head")

    with engine.connect() as conn:
        folder_row = conn.execute(
            text(
                "SELECT version, deleted_at FROM folders WHERE id = :id"
            ),
            {"id": folder_id},
        ).one()
        document_row = conn.execute(
            text(
                "SELECT version, deleted_at FROM documents WHERE id = :id"
            ),
            {"id": document_id},
        ).one()
        state_row = conn.execute(
            text(
                "SELECT feed_epoch, last_seq, min_valid_seq "
                "FROM company_sync_state WHERE company_id = :id"
            ),
            {"id": company_id},
        ).one()

    assert folder_row == (1, None)
    assert document_row == (1, None)
    assert state_row[1:] == (0, 0)
    feed_epoch = state_row[0]

    with engine.begin() as conn:
        conn.execute(
            text(
                "UPDATE company_sync_state SET last_seq = 7 "
                "WHERE company_id = :id"
            ),
            {"id": company_id},
        )

    command.downgrade(config, "a7c1e9d4b2f0")
    with engine.connect() as conn:
        columns = {
            row[0]
            for row in conn.execute(
                text(
                    "SELECT column_name FROM information_schema.columns "
                    "WHERE table_schema = 'public' AND table_name IN "
                    "('folders', 'documents') AND column_name IN "
                    "('version', 'deleted_at')"
                )
            )
        }
    assert columns == set()

    command.upgrade(config, "head")
    with engine.connect() as conn:
        folder_row = conn.execute(
            text(
                "SELECT version, deleted_at FROM folders WHERE id = :id"
            ),
            {"id": folder_id},
        ).one()
        document_row = conn.execute(
            text(
                "SELECT version, deleted_at FROM documents WHERE id = :id"
            ),
            {"id": document_id},
        ).one()
        state_row = conn.execute(
            text(
                "SELECT feed_epoch, last_seq, min_valid_seq "
                "FROM company_sync_state WHERE company_id = :id"
            ),
            {"id": company_id},
        ).one()

    assert folder_row == (1, None)
    assert document_row == (1, None)
    assert state_row[0] == feed_epoch
    assert state_row[1:] == (7, 0)


def test_downgrade_discards_tombstones_before_restoring_name_uniqueness(
    engine, _database
):
    config = _alembic_config(engine)
    command.downgrade(config, "a7c1e9d4b2f0")

    company_id = uuid.uuid4()
    quarry_id = uuid.uuid4()
    with engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO companies "
                "(id, name, status, quota_bytes, max_users) VALUES "
                "(:id, :name, CAST(:status AS company_status), 1000, 10)"
            ),
            {
                "id": company_id,
                "name": "Tombstone Downgrade Co",
                "status": "active",
            },
        )
        conn.execute(
            text(
                "INSERT INTO quarries (id, company_id, name, status) VALUES "
                "(:id, :company_id, :name, CAST(:status AS quarry_status))"
            ),
            {
                "id": quarry_id,
                "company_id": company_id,
                "name": "South Pit",
                "status": "active",
            },
        )

    command.upgrade(config, "head")

    deleted_id = uuid.uuid4()
    active_id = uuid.uuid4()
    with engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO folders "
                "(id, company_id, quarry_id, parent_id, name) VALUES "
                "(:id, :company_id, :quarry_id, NULL, 'Plans')"
            ),
            {
                "id": deleted_id,
                "company_id": company_id,
                "quarry_id": quarry_id,
            },
        )
        conn.execute(
            text(
                "UPDATE folders SET deleted_at = now(), version = 2 "
                "WHERE id = :id"
            ),
            {"id": deleted_id},
        )
        conn.execute(
            text(
                "INSERT INTO folders "
                "(id, company_id, quarry_id, parent_id, name) VALUES "
                "(:id, :company_id, :quarry_id, NULL, 'Plans')"
            ),
            {
                "id": active_id,
                "company_id": company_id,
                "quarry_id": quarry_id,
            },
        )

    command.downgrade(config, "a7c1e9d4b2f0")
    with engine.connect() as conn:
        remaining = conn.execute(
            text("SELECT id FROM folders ORDER BY id")
        ).scalars().all()

    assert remaining == [active_id]

    command.upgrade(config, "head")
