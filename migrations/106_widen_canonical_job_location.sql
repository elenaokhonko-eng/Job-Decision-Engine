-- canonical_jobs.location was created as VARCHAR(255), but a posting may list many offices: a
-- Workday posting naming eight Asian offices has a 340-character location. Normalization then
-- failed with "value too long for type character varying(255)" on every retry, the task
-- dead-lettered, and the job never entered the pipeline. raw_job_observations.location_raw is
-- already TEXT, and truncating would hide offices from the mobility gate, which reads this column.
--
-- Views that select this column block ALTER COLUMN TYPE, so every dependent view (and views built
-- on them) is captured with its current definition and comment, dropped, and recreated unchanged
-- after the column is widened. Widening is additive: no stored value changes. To reverse, narrow
-- the column back to VARCHAR(255) the same way, only after confirming no value exceeds 255 characters.

DO $$
DECLARE
  table_oid REGCLASS := to_regclass(format('%I.canonical_jobs', current_schema()));
  view_names TEXT[] := ARRAY[]::TEXT[];
  view_definitions TEXT[] := ARRAY[]::TEXT[];
  view_comments TEXT[] := ARRAY[]::TEXT[];
  view_row RECORD;
  index INTEGER;
BEGIN
  IF table_oid IS NULL THEN
    RAISE EXCEPTION 'Expected canonical_jobs table is missing in schema %', current_schema();
  END IF;

  FOR view_row IN
    WITH RECURSIVE dependent_views(view_oid, depth) AS (
      SELECT rewrite.ev_class, 1
      FROM pg_depend dependency
      JOIN pg_rewrite rewrite ON rewrite.oid = dependency.objid
      JOIN pg_attribute attribute
        ON attribute.attrelid = dependency.refobjid
       AND attribute.attnum = dependency.refobjsubid
      WHERE dependency.refobjid = table_oid
        AND attribute.attname = 'location'
        AND rewrite.ev_class <> table_oid
      UNION ALL
      SELECT rewrite.ev_class, dependent_views.depth + 1
      FROM dependent_views
      JOIN pg_depend dependency ON dependency.refobjid = dependent_views.view_oid
      JOIN pg_rewrite rewrite ON rewrite.oid = dependency.objid
      WHERE rewrite.ev_class <> dependent_views.view_oid
    )
    SELECT view_class.relname AS view_name,
           pg_get_viewdef(view_class.oid, TRUE) AS view_definition,
           obj_description(view_class.oid, 'pg_class') AS view_comment,
           MAX(dependent_views.depth) AS depth
    FROM dependent_views
    JOIN pg_class view_class ON view_class.oid = dependent_views.view_oid
    WHERE view_class.relkind = 'v'
      AND view_class.relnamespace = to_regnamespace(current_schema())
    GROUP BY view_class.oid, view_class.relname
    ORDER BY MAX(dependent_views.depth) ASC, view_class.relname ASC
  LOOP
    view_names := view_names || view_row.view_name;
    view_definitions := view_definitions || view_row.view_definition;
    view_comments := view_comments || view_row.view_comment;
  END LOOP;

  -- Drop the deepest views first, then recreate in dependency order.
  FOR index IN REVERSE COALESCE(array_length(view_names, 1), 0)..1 LOOP
    EXECUTE format('DROP VIEW %I.%I', current_schema(), view_names[index]);
  END LOOP;

  EXECUTE format('ALTER TABLE %I.canonical_jobs ALTER COLUMN location TYPE TEXT', current_schema());

  FOR index IN 1..COALESCE(array_length(view_names, 1), 0) LOOP
    EXECUTE format('CREATE VIEW %I.%I AS %s', current_schema(), view_names[index], view_definitions[index]);
    IF view_comments[index] IS NOT NULL THEN
      EXECUTE format('COMMENT ON VIEW %I.%I IS %L', current_schema(), view_names[index], view_comments[index]);
    END IF;
  END LOOP;
END $$;
