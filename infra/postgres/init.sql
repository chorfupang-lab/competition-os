-- Runs once when the dev database volume is first created.
-- cos_app is the restricted role the API uses: not the table owner, no
-- BYPASSRLS, so PostgreSQL row-level security always applies to it.
-- In production, create it the same way with a secret password from the
-- secrets manager.
create role cos_app login password 'cos_app_dev' nosuperuser nocreatedb nocreaterole nobypassrls;
