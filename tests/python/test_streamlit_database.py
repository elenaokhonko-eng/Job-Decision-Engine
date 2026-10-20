import pytest

from streamlit_database import read_only_database_ssl_options


@pytest.mark.parametrize("hostname", ["localhost", "127.0.0.1", "[::1]"])
def test_local_plaintext_requires_explicit_opt_in(hostname):
    url = f"postgresql://test:password@{hostname}:5432/testdb"

    strict_options = read_only_database_ssl_options(url)
    assert strict_options == {"sslmode": "verify-full"}

    local_test_options = read_only_database_ssl_options(url, allow_local_postgres=True)
    assert local_test_options == {"sslmode": "disable"}


def test_local_database_opt_in_does_not_disable_tls_for_remote_hosts():
    options = read_only_database_ssl_options(
        "postgresql://test:password@db.example.com:5432/testdb",
        allow_local_postgres=True,
    )

    assert options == {"sslmode": "verify-full"}
