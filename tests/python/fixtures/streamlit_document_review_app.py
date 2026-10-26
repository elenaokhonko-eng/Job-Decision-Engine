import streamlit as st

from streamlit_application_review import render_document_pair_review_checkbox


def save_review() -> None:
    st.session_state["review_saved"] = True


render_document_pair_review_checkbox(
    review_key="document_pair_reviewed",
    already_reviewed=False,
    on_review=save_review,
)
st.write(st.session_state.get("review_saved", False))
