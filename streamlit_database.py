"""Connection helpers for the Streamlit read-only PostgreSQL fallback."""

from urllib.parse import urlsplit


_LOCAL_DATABASE_HOSTS = {"localhost", "127.0.0.1", "::1"}


def read_only_database_ssl_options(
    database_url: str, *, allow_local_postgres: bool = False
) -> dict[str, str]:
    """Return verified TLS options, allowing explicit loopback-only test access.

    Args:
        database_url: PostgreSQL connection URL.
        allow_local_postgres: Explicitly permit plaintext only for loopback test databases.

    Returns:
        Keyword arguments for a psycopg2 connection.

    Example:
        >>> read_only_database_ssl_options(
        ...     "postgresql://test:password@localhost/testdb",
        ...     allow_local_postgres=True,
        ... )
        {'sslmode': 'disable'}
    """
    hostname = urlsplit(database_url).hostname
    if allow_local_postgres and hostname in _LOCAL_DATABASE_HOSTS:
        return {"sslmode": "disable"}

    return {"sslmode": "verify-full"}
