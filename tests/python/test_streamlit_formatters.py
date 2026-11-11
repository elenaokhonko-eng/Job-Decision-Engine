from decimal import Decimal

import pytest
from streamlit_formatters import (
    as_number,
    format_career_track,
    format_percent,
    format_score,
    format_signal,
    safe_http_url,
)


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (82, Decimal(82)),
        (82.5, Decimal("82.5")),
        (Decimal("82.50"), Decimal("82.50")),
        (None, None),
        (True, None),
        (float("nan"), None),
        (Decimal("Infinity"), None),
        ("82", None),
    ],
)
def test_as_number_accepts_finite_numeric_values(value, expected):
    assert as_number(value) == expected


def test_format_score_formats_decimal_values():
    assert format_score(Decimal("82.456")) == "82.5/100"


def test_format_score_preserves_zero_and_marks_missing_values():
    assert format_score(0) == "0.0/100"
    assert format_score(None) == "N/A"


def test_format_percent_supports_fractional_and_percentage_values():
    assert format_percent(Decimal("0.875"), fraction=True) == "87.5%"
    assert format_percent(Decimal("87.56")) == "87.6%"


def test_format_percent_marks_missing_and_non_finite_values():
    assert format_percent(None) == "N/A"
    assert format_percent(float("inf")) == "N/A"


def test_format_signal_keeps_missing_culture_data_unknown():
    assert format_signal(None) == "UNKNOWN"
    assert format_signal(Decimal("81.5")) == "81.5%"


@pytest.mark.parametrize(
    ("track", "level", "tags", "expected"),
    [
        (
            "HANDS_ON_AI_DATA",
            "MID",
            ["TRANSITION"],
            "Hands-on AI / data · mid · transition",
        ),
        ("AI_BRIDGE", "SENIOR", ["BRIDGE"], "AI bridge · senior · bridge"),
        ("DATA_MANAGEMENT", "MID", ["STEP_DOWN"], "Data management · mid · step down"),
        (
            "GENERIC_SOFTWARE",
            "MID",
            ["OFF_TRACK", "<script>"],
            "Generic software · mid · off track",
        ),
        (None, "MID", [], None),
        ("<b>x</b>", "MID", [], None),
    ],
)
def test_format_career_track_renders_only_known_codes(track, level, tags, expected):
    assert format_career_track(track, level, tags) == expected


@pytest.mark.parametrize(
    "url",
    [
        "https://example.test/jobs/123",
        "http://careers.example.test/apply?id=7&src=li#top",
        "HTTPS://Example.test/path",
        "  https://example.test/padded  ",
    ],
)
def test_safe_http_url_accepts_well_formed_http_links(url):
    assert safe_http_url(url) == url.strip()


@pytest.mark.parametrize(
    "url",
    [
        None,
        "",
        42,
        "javascript:alert(1)",
        "JavaScript:alert(1)",
        "data:text/html;base64,PHNjcmlwdD4=",
        "file:///etc/passwd",
        "ftp://example.test/file",
        "//example.test/no-scheme",
        "example.test/no-scheme",
        "https://",
        "https:///path-only",
        "https://example.test/a b",
        "https://example.test/\tx",
        "https://example.test/\nx",
        "https://example.test/\x00",
        "https://example.test/\x7f",
        "https://example.test/x)](javascript:alert(1))",
        "https://example.test/<script>",
        "https://user:pass@example.test/",
        "https://example.test:99999/",
        "https://" + "a" * 2050 + ".test/",
    ],
)
def test_safe_http_url_rejects_unsafe_or_malformed_links(url):
    assert safe_http_url(url) is None
