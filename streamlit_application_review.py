from collections.abc import Callable

import streamlit as st


def render_document_pair_review_checkbox(
    *,
    review_key: str,
    already_reviewed: bool,
    on_review: Callable[[], None],
) -> bool:
    """Render the draft-document review checkbox and persist a new review.

    Args:
        review_key: Unique session-state key for this CV/cover-letter pair.
        already_reviewed: Whether the pair has a persisted review event.
        on_review: Callback that persists the review event.

    Returns:
        Whether the review checkbox is selected.

    Example:
        >>> render_document_pair_review_checkbox(
        ...     review_key="pair-reviewed-cv-letter",
        ...     already_reviewed=False,
        ...     on_review=save_review,
        ... )
        False
    """
    if already_reviewed:
        st.session_state[review_key] = True
    else:
        st.session_state.setdefault(review_key, False)

    reviewed = st.checkbox(
        "I reviewed both documents and their downloads. The application remains a draft.",
        key=review_key,
        disabled=already_reviewed,
    )
    if reviewed and not already_reviewed:
        on_review()
    return reviewed
