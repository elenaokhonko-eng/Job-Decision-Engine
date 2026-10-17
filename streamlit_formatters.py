"""Format database-backed numeric values in Streamlit without losing valid scores.

Usage:
    from streamlit_formatters import format_percent, format_score

    format_score(Decimal("82.45"))
"""

from decimal import Decimal
from numbers import Real

MISSING_VALUE = "N/A"


def as_number(value: object) -> Decimal | None:
    """Convert a supported finite number to Decimal.

    Args:
        value: A Python integer, float, Decimal, or None.

    Returns:
        The finite numeric value as Decimal, or None for missing or invalid input.

    Example:
        >>> as_number(82.5)
        Decimal('82.5')
    """
    if value is None or isinstance(value, bool):
        return None

    if isinstance(value, Decimal):
        number = value
    elif isinstance(value, Real):
        number = Decimal(str(value))
    else:
        return None

    return number if number.is_finite() else None


def format_score(value: object, *, decimals: int = 1) -> str:
    """Format a score on a 100-point scale.

    Args:
        value: The score to format.
        decimals: Number of digits after the decimal point.

    Returns:
        A formatted score or ``N/A`` when the value is missing or invalid.

    Example:
        >>> format_score(Decimal("82.456"))
        '82.5/100'
    """
    number = as_number(value)
    if number is None:
        return MISSING_VALUE
    return f"{number:.{decimals}f}/100"


def format_signal(value: object, *, decimals: int = 1) -> str:
    """Format an optional culture signal, preserving UNKNOWN when evidence is absent.

    Args:
        value: The 0–100 culture signal.
        decimals: Number of digits after the decimal point.

    Returns:
        A percentage or ``UNKNOWN`` when no valid signal is available.

    Example:
        >>> format_signal(None)
        'UNKNOWN'
    """
    if as_number(value) is None:
        return "UNKNOWN"
    return format_percent(value, decimals=decimals)


def format_percent(value: object, *, fraction: bool = False, decimals: int = 1) -> str:
    """Format a percentage, optionally converting a unit interval to percent.

    Args:
        value: A percentage value, or a fraction when ``fraction`` is true.
        fraction: Whether to multiply the value by 100 before formatting.
        decimals: Number of digits after the decimal point.

    Returns:
        A formatted percentage or ``N/A`` when the value is missing or invalid.

    Example:
        >>> format_percent(Decimal("0.875"), fraction=True)
        '87.5%'
    """
    number = as_number(value)
    if number is None:
        return MISSING_VALUE
    if fraction:
        number *= 100
    return f"{number:.{decimals}f}%"
