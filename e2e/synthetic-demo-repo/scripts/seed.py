# SPDX-License-Identifier: Apache-2.0
# Seed script for the synthetic demo. Defines a Python-side error hierarchy
# (so the seed-skill error-hierarchy scanner detects an Exception family) and
# a small seed pipeline. Hand-built; not run during e2e — only parsed.

class SeedError(Exception):
    """Base error for seed/migrate scripts."""


class SeedValidationError(SeedError):
    pass


class SeedConnectionError(SeedError):
    pass


def load_fixtures(path):
    """Read fixture rows from disk."""
    if not path:
        raise SeedValidationError("path must be non-empty")
    return [{"email": f"user{i}@example.com"} for i in range(3)]


def seed_users(rows):
    if not rows:
        raise SeedValidationError("rows must be non-empty")
    return [_make_user(r) for r in rows]


def _make_user(row):
    return {
        "id": row.get("email", "").split("@")[0],
        "email": row["email"],
    }


def main():
    rows = load_fixtures("fixtures/users.json")
    users = seed_users(rows)
    return len(users)


if __name__ == "__main__":
    main()
