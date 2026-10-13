-- Migration 052: Preserve unknown queue priority as NULL in the shortlist read model.
--
-- Migration 019 is corrected for fresh installs. This additive upgrade also
-- repairs databases that already applied the earlier view definition without
-- rewriting queue history or fabricating a score.

DO $$
DECLARE
  view_definition TEXT;
  updated_definition TEXT;
  view_regclass REGCLASS;
BEGIN
  view_regclass := to_regclass(format('%I.%I', current_schema(), 'v_canonical_shortlist'));
  IF view_regclass IS NULL THEN
    RAISE EXCEPTION 'Expected v_canonical_shortlist view is missing in schema %', current_schema();
  END IF;

  SELECT pg_get_viewdef(view_regclass, TRUE)
    INTO view_definition;

  updated_definition := regexp_replace(
    view_definition,
    'COALESCE[[:space:]]*[(][[:space:]]*(vq[.])?priority_score[[:space:]]*,[[:space:]]*0([.]0)?(:numeric)?[[:space:]]*[)]',
    'vq.priority_score',
    'gi'
  );

  IF updated_definition <> view_definition THEN
    EXECUTE format(
      'CREATE OR REPLACE VIEW %I.v_canonical_shortlist AS %s',
      current_schema(),
      updated_definition
    );
  ELSIF view_definition !~* '(^|[^[:alnum:]_])priority_score([^[:alnum:]_]|$)' THEN
    RAISE EXCEPTION 'v_canonical_shortlist does not expose the expected queue priority expression';
  END IF;
END $$;
