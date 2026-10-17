from decimal import Decimal

import pytest
from streamlit_formatters import as_number, format_percent, format_score, format_signal


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
