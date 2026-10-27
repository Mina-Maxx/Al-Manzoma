from __future__ import annotations

import threading

from sqlalchemy import func, select

from app.models import Membership, MembershipRole, User, UserStatus
from app.services import company_admin
from app.services.errors import LastCompanyAdmin, MaxUsersReached
from tests.factories import make_company, make_membership, make_user


def _run_workers(targets):
    results: list[str] = []
    lock = threading.Lock()

    def wrap(fn):
        def inner():
            try:
                outcome = fn()
            except Exception as exc:  # surfaced via results, not swallowed silently
                outcome = f"error:{type(exc).__name__}"
            with lock:
                results.append(outcome)

        return inner

    threads = [threading.Thread(target=wrap(t)) for t in targets]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=60)
    return results


def test_concurrent_invites_never_exceed_max_users(db, session_factory, identity):
    company = make_company(db, name="Race", max_users=3)
    admin = make_user(db, auth_user_id="admin", email="admin@example.com")
    make_membership(db, admin, company, role=MembershipRole.company_admin)

    barrier = threading.Barrier(6)

    def worker(index):
        session = session_factory()
        try:
            barrier.wait(timeout=30)
            company_admin.invite_employee(
                session, identity, company.id, email=f"u{index}@example.com"
            )
            return "ok"
        except MaxUsersReached:
            return "limit"
        finally:
            session.close()

    results = _run_workers([lambda i=i: worker(i) for i in range(6)])

    assert [r for r in results if r.startswith("error")] == []
    assert results.count("ok") == 2
    assert results.count("limit") == 4

    db.expire_all()
    members = db.execute(
        select(func.count())
        .select_from(Membership)
        .where(Membership.company_id == company.id)
    ).scalar_one()
    assert members == 3


def test_concurrent_disables_never_remove_last_admin(db, session_factory, identity):
    company = make_company(db, name="Race", max_users=10)
    first = make_user(db, auth_user_id="a1", email="a1@example.com")
    second = make_user(db, auth_user_id="a2", email="a2@example.com")
    make_membership(db, first, company, role=MembershipRole.company_admin)
    make_membership(db, second, company, role=MembershipRole.company_admin)

    barrier = threading.Barrier(2)

    def worker(user_id):
        session = session_factory()
        try:
            barrier.wait(timeout=30)
            company_admin.set_user_status(
                session, identity, company.id, user_id, UserStatus.inactive
            )
            return "ok"
        except LastCompanyAdmin:
            return "last"
        finally:
            session.close()

    results = _run_workers(
        [lambda: worker(first.id), lambda: worker(second.id)]
    )

    assert [r for r in results if r.startswith("error")] == []
    assert results.count("ok") == 1
    assert results.count("last") == 1

    db.expire_all()
    active_admins = db.execute(
        select(func.count())
        .select_from(Membership)
        .join(User, User.id == Membership.user_id)
        .where(
            Membership.company_id == company.id,
            Membership.role == MembershipRole.company_admin,
            User.status == UserStatus.active,
        )
    ).scalar_one()
    assert active_admins == 1
