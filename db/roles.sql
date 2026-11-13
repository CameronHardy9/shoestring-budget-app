-- Shoestring database roles and grants. Idempotent; safe to re-run at any time.
-- Owner: data-engineer. Consumers: db migrate CLI (local/test), sre runbooks
-- (bootstrap-production.md step 8, restore.md steps 5 and 7).
--
-- Roles (data-model.md "Roles"):
--   migrator  owns the schema and runs migrations (CREATE on the database for the
--             trusted citext extension, USAGE + CREATE on schema public)
--   app       SELECT/INSERT/UPDATE/DELETE on app tables only; INSERT/SELECT on
--             security_events; SELECT on schema_migrations; no DDL, no TRUNCATE
--   backup    SELECT only (nightly pg_dump)
--
-- No passwords here. Production: set them with psql's \password (hashed
-- client-side). Local/test: the db migrate CLI sets them from the role URLs.
--
-- Who runs it:
--   * As the DATABASE OWNER (postgres locally, neondb_owner on Neon): creates
--     the roles and the database/schema grants. Required on a new database.
--   * As MIGRATOR (the migrate CLI does this after every migration run, and
--     restore.md step 7 after pg_restore): re-applies the table grants, because
--     tables are owned by migrator and pg_restore --no-privileges drops them.
-- Steps the current role may not perform are skipped with a NOTICE; the final
-- block then verifies the complete end state and fails loudly if anything is
-- missing, with a message naming the role that must run this file.
-- Uses no psql meta-commands, so it runs through psql and through node-postgres.

-- 1. Roles ------------------------------------------------------------------
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'migrator') THEN
    CREATE ROLE migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app') THEN
    CREATE ROLE app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'backup') THEN
    CREATE ROLE backup LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END
$roles$;

-- 1b. Role defaults: server-side timeouts for the app role (they work through
-- Neon's PgBouncer pooler, unlike client startup parameters). Needs ADMIN on
-- the role (its creator or a superuser); skipped otherwise.
DO $settings$
BEGIN
  ALTER ROLE app SET statement_timeout = '10s';
  ALTER ROLE app SET idle_in_transaction_session_timeout = '30s';
  ALTER ROLE app SET lock_timeout = '5s';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'roles.sql: % may not change role settings; timeouts skipped', current_user;
END
$settings$;

-- 2. Database and schema privileges (database owner only) --------------------
DO $dbgrants$
BEGIN
  IF pg_has_role(current_user, (SELECT datdba FROM pg_database WHERE datname = current_database()), 'USAGE') THEN
    -- F-44: PUBLIC keeps CONNECT and TEMPORARY on new databases by default;
    -- take both away and grant CONNECT explicitly. No role needs temp tables.
    EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database());
    EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM migrator, app, backup', current_database());
    EXECUTE format('GRANT CONNECT, CREATE ON DATABASE %I TO migrator', current_database());
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO app, backup', current_database());
    GRANT USAGE, CREATE ON SCHEMA public TO migrator;
    GRANT USAGE ON SCHEMA public TO app, backup;
    REVOKE CREATE ON SCHEMA public FROM PUBLIC;
  ELSE
    RAISE NOTICE 'roles.sql: % is not the database owner; database/schema grants skipped (verified below)', current_user;
  END IF;
END
$dbgrants$;

-- 3. Table and function privileges (table owner, i.e. migrator, or superuser) --
DO $tablegrants$
DECLARE
  r record;
  skipped integer := 0;
BEGIN
  FOR r IN
    SELECT c.relname, c.relowner
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v')
     ORDER BY c.relname
  LOOP
    IF NOT pg_has_role(current_user, r.relowner, 'USAGE') THEN
      skipped := skipped + 1;
      CONTINUE;
    END IF;
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, app, backup', r.relname);
    IF r.relname = 'security_events' THEN
      -- F-26: the audit log is append-only for the app.
      EXECUTE format('GRANT SELECT, INSERT ON TABLE public.%I TO app', r.relname);
    ELSIF r.relname = 'schema_migrations' THEN
      -- readyz checks that migrations are applied.
      EXECUTE format('GRANT SELECT ON TABLE public.%I TO app', r.relname);
    ELSE
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO app', r.relname);
    END IF;
    EXECUTE format('GRANT SELECT ON TABLE public.%I TO backup', r.relname);
  END LOOP;

  -- Sequences: none today (UUID keys); keep the rule for future ones.
  FOR r IN
    SELECT c.relname, c.relowner
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'S'
  LOOP
    IF pg_has_role(current_user, r.relowner, 'USAGE') THEN
      EXECUTE format('GRANT USAGE ON SEQUENCE public.%I TO app', r.relname);
      EXECUTE format('GRANT SELECT ON SEQUENCE public.%I TO backup', r.relname);
    END IF;
  END LOOP;

  IF to_regprocedure('public.purge_security_events()') IS NOT NULL THEN
    IF pg_has_role(current_user, (SELECT proowner FROM pg_proc WHERE oid = 'public.purge_security_events()'::regprocedure), 'USAGE') THEN
      REVOKE ALL ON FUNCTION public.purge_security_events() FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION public.purge_security_events() TO app;
    END IF;
  END IF;

  IF skipped > 0 THEN
    RAISE NOTICE 'roles.sql: % does not own % table(s); their grants were skipped (verified below)', current_user, skipped;
  END IF;
END
$tablegrants$;

-- 4. Verify the end state -----------------------------------------------------
DO $verify$
DECLARE
  bad text;
  hint constant text := 'Run db/roles.sql as the database owner (postgres locally, neondb_owner on Neon) on a new database, and as migrator after migrations or pg_restore.';
BEGIN
  SELECT string_agg(rolname, ', ') INTO bad
    FROM pg_roles
   WHERE rolname IN ('app', 'migrator', 'backup')
     AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'roles.sql: roles with forbidden attributes: %', bad;
  END IF;

  IF NOT has_database_privilege('migrator', current_database(), 'CONNECT, CREATE')
     OR NOT has_database_privilege('app', current_database(), 'CONNECT')
     OR NOT has_database_privilege('backup', current_database(), 'CONNECT') THEN
    RAISE EXCEPTION 'roles.sql: database privileges are incomplete. %', hint;
  END IF;
  IF NOT has_schema_privilege('migrator', 'public', 'USAGE, CREATE')
     OR NOT has_schema_privilege('app', 'public', 'USAGE')
     OR NOT has_schema_privilege('backup', 'public', 'USAGE') THEN
    RAISE EXCEPTION 'roles.sql: schema privileges are incomplete. %', hint;
  END IF;
  IF has_database_privilege('app', current_database(), 'TEMPORARY')
     OR has_database_privilege('backup', current_database(), 'TEMPORARY') THEN
    RAISE EXCEPTION 'roles.sql: app or backup can create temporary objects (PUBLIC still has TEMPORARY). %', hint;
  END IF;
  IF has_schema_privilege('app', 'public', 'CREATE') OR has_schema_privilege('backup', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'roles.sql: app or backup can create objects in schema public';
  END IF;

  -- Every table: owned by migrator, the exact privileges above, nothing more.
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO bad
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v')
     AND NOT (
       pg_get_userbyid(c.relowner) = 'migrator'
       AND has_table_privilege('app', c.oid, 'SELECT')
       AND has_table_privilege('app', c.oid, 'INSERT') = (c.relname <> 'schema_migrations')
       AND has_table_privilege('app', c.oid, 'UPDATE') = (c.relname NOT IN ('schema_migrations', 'security_events'))
       AND has_table_privilege('app', c.oid, 'DELETE') = (c.relname NOT IN ('schema_migrations', 'security_events'))
       AND NOT has_table_privilege('app', c.oid, 'TRUNCATE')
       AND NOT has_table_privilege('app', c.oid, 'REFERENCES')
       AND NOT has_table_privilege('app', c.oid, 'TRIGGER')
       AND NOT has_table_privilege('app', c.oid, 'MAINTAIN')
       AND has_table_privilege('backup', c.oid, 'SELECT')
       AND NOT has_table_privilege('backup', c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN')
     );
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'roles.sql: tables with wrong owner or privileges: %. %', bad, hint;
  END IF;

  IF to_regprocedure('public.purge_security_events()') IS NOT NULL THEN
    IF (SELECT pg_get_userbyid(proowner) <> 'migrator' OR NOT prosecdef
          FROM pg_proc WHERE oid = 'public.purge_security_events()'::regprocedure)
       OR NOT has_function_privilege('app', 'public.purge_security_events()', 'EXECUTE')
       OR has_function_privilege('backup', 'public.purge_security_events()', 'EXECUTE') THEN
      RAISE EXCEPTION 'roles.sql: purge_security_events() must be SECURITY DEFINER, owned by migrator, executable by app only. %', hint;
    END IF;
  END IF;
END
$verify$;
