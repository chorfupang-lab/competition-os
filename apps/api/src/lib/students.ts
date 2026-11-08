import { sql } from "kysely";
import type { Tx } from "@cos/db";
import { newId, newStudentCode } from "./crypto.ts";

export interface StudentInput {
  givenName: string;
  familyName?: string | null | undefined;
  preferredName?: string | null | undefined;
  nickname?: string | null | undefined;
  dateOfBirth?: string | null | undefined;
  primaryLocale?: string | null | undefined;
}

/**
 * Create a platform-level student identity. The id is generated here and the
 * row inserted without RETURNING, because the creator may not be able to SELECT
 * the row until it is linked to them (parent link or school roster).
 */
export async function createStudent(tx: Tx, createdBy: string, input: StudentInput): Promise<{ id: string; studentCode: string }> {
  const id = newId();
  // Plain INSERT in a savepoint, retried on a Student ID collision.
  // (INSERT ... ON CONFLICT cannot be used: PostgreSQL then applies the SELECT
  // policy, and the creator cannot see the row until it is linked.)
  for (let attempt = 0; attempt < 5; attempt++) {
    const studentCode = newStudentCode();
    await sql`savepoint create_student`.execute(tx);
    try {
      await tx
        .insertInto("students")
        .values({
          id,
          student_code: studentCode,
          user_id: null,
          given_name: input.givenName,
          family_name: input.familyName ?? null,
          preferred_name: input.preferredName ?? null,
          nickname: input.nickname ?? null,
          date_of_birth: input.dateOfBirth ?? null,
          primary_locale: input.primaryLocale ?? null,
          created_by_user_id: createdBy,
          anonymized_at: null,
        })
        .execute();
      await sql`release savepoint create_student`.execute(tx);
      return { id, studentCode };
    } catch (err) {
      await sql`rollback to savepoint create_student`.execute(tx);
      const e = err as { code?: string; constraint?: string };
      if (e.code !== "23505" || e.constraint !== "students_student_code_key") throw err;
    }
  }
  throw new Error("could not allocate a unique student code");
}

export const studentColumns = [
  "students.id",
  "students.student_code",
  "students.given_name",
  "students.family_name",
  "students.preferred_name",
  "students.nickname",
  "students.date_of_birth",
  "students.primary_locale",
  "students.user_id",
] as const;

export function presentStudent(s: {
  id: string;
  student_code: string;
  given_name: string | null;
  family_name: string | null;
  preferred_name: string | null;
  nickname: string | null;
  date_of_birth: string | null;
  primary_locale: string | null;
  user_id: string | null;
}) {
  return {
    id: s.id,
    studentCode: s.student_code,
    givenName: s.given_name,
    familyName: s.family_name,
    preferredName: s.preferred_name,
    nickname: s.nickname,
    dateOfBirth: s.date_of_birth,
    primaryLocale: s.primary_locale,
    hasLogin: s.user_id !== null,
  };
}
