/**
 * Creates a fresh test database, the restricted cos_app login, and applies
 * all migrations. Needs a PostgreSQL superuser connection:
 *   TEST_DATABASE_ADMIN_URL (default: the docker-compose superuser)
 */
import pg from "pg";
import type { TestProject } from "vitest/node";
import { migrate } from "@cos/db";

declare module "vitest" {
  export interface ProvidedContext {
    ownerUrl: string;
    appUrl: string;
  }
}

export default async function setup(project: TestProject) {
  const adminUrl = process.env.TEST_DATABASE_ADMIN_URL ?? "postgres://cos_owner:cos_owner_dev@localhost:5432/postgres";
  const dbName = `cos_test_${process.pid}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`drop database if exists ${dbName} with (force)`);
  await admin.query(`create database ${dbName}`);
  await admin.query(`do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'cos_app') then create role cos_app; end if;
    end $$`);
  await admin.query(`alter role cos_app login password 'cos_app_test'`);
  await admin.end();

  const url = new URL(adminUrl);
  url.pathname = `/${dbName}`;
  const ownerUrl = url.toString();
  url.username = "cos_app";
  url.password = "cos_app_test";
  const appUrl = url.toString();

  await migrate(ownerUrl, () => {});
  project.provide("ownerUrl", ownerUrl);
  project.provide("appUrl", appUrl);

  return async () => {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    await c.query(`drop database if exists ${dbName} with (force)`);
    await c.end();
  };
}
