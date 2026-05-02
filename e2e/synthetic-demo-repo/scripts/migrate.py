# SPDX-License-Identifier: Apache-2.0
# Migration helper. Same SeedError family — should appear under one Skill in
# the §11 error-hierarchy scanner output (since both files import from a
# shared base in the same project).

from seed import SeedError


class MigrationError(SeedError):
    """Raised when a migration step fails."""


class SchemaError(MigrationError):
    pass


def apply_migration(name):
    if not name:
        raise MigrationError("migration name required")
    return _run(name)


def _run(name):
    if name == "fail":
        raise SchemaError(f"migration {name} failed")
    return {"name": name, "applied": True}


def rollback(name):
    if not name:
        raise MigrationError("migration name required")
    return {"name": name, "rolled_back": True}


def main():
    apply_migration("001-initial")
    apply_migration("002-add-users")


if __name__ == "__main__":
    main()
