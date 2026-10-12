from sqlalchemy import create_engine, event
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from app.config import settings

is_sqlite = settings.database_url.startswith("sqlite")
# The background job worker writes while API requests read, and the
# processing scripts write from their own processes: WAL lets readers proceed
# during a write, and the busy timeout makes writers wait instead of failing.
connect_args = {"check_same_thread": False, "timeout": 30} if is_sqlite else {}
engine = create_engine(settings.database_url, connect_args=connect_args)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

if is_sqlite:

    @event.listens_for(engine, "connect")
    def _sqlite_pragmas(dbapi_connection, _record):
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA synchronous=OFF")
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA busy_timeout=30000")
        cursor.close()


class Base(DeclarativeBase):
    """Base for all ORM models.

    SQLite + plain JSON/text columns for geometry today. The service layer
    (not the models) is where a future Postgres/PostGIS migration would swap
    implementations, so routers/services never assume SQLite-specific behavior.
    """


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db():
    from app import models  # noqa: F401  (ensure models are registered)

    Base.metadata.create_all(bind=engine)
    _add_missing_columns()


def _add_missing_columns():
    """Additive-only migration for the SQLite MVP: any column that exists on a
    model but not in its table is added with ALTER TABLE. Enough to evolve
    the schema without wiping seeded data; a real migration tool (Alembic)
    takes over at the Postgres/PostGIS step."""
    from sqlalchemy import inspect, text

    insp = inspect(engine)
    with engine.begin() as conn:
        for table in Base.metadata.sorted_tables:
            if table.name not in insp.get_table_names():
                continue
            existing = {c["name"] for c in insp.get_columns(table.name)}
            for col in table.columns:
                if col.name in existing:
                    continue
                ddl = f'ALTER TABLE "{table.name}" ADD COLUMN "{col.name}" {col.type.compile(engine.dialect)}'
                conn.execute(text(ddl))
