import { seedFrom } from "../runtime/random.ts";

/**
 * Public leaderboard privacy (configurable per competition):
 *   A full_name · B first_name_initial · C nickname · D anonymous_code · E rank_score_only
 * The default for minors is C, falling back to D when no nickname is set.
 * The anonymous code is per competition, so it cannot be used to follow a
 * child across competitions (the platform Student ID is never shown).
 */
export const LEADERBOARD_PRIVACY = ["full_name", "first_name_initial", "nickname", "anonymous_code", "rank_score_only"] as const;
export type LeaderboardPrivacy = (typeof LEADERBOARD_PRIVACY)[number];

const ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";

export function anonymousCode(competitionId: string, studentId: string): string {
  let n = seedFrom(`${competitionId}:${studentId}`);
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += ALPHABET[n % ALPHABET.length];
    n = Math.floor(n / ALPHABET.length) || seedFrom(code + studentId);
  }
  return `P-${code}`;
}

export function displayName(
  mode: LeaderboardPrivacy,
  s: { competitionId: string; studentId: string; givenName: string | null; familyName: string | null; preferredName: string | null; nickname: string | null },
): string | null {
  const first = s.preferredName || s.givenName || "";
  switch (mode) {
    case "full_name":
      return [first, s.familyName].filter(Boolean).join(" ") || anonymousCode(s.competitionId, s.studentId);
    case "first_name_initial":
      return first ? `${first}${s.familyName ? ` ${s.familyName.trim().charAt(0)}.` : ""}` : anonymousCode(s.competitionId, s.studentId);
    case "nickname":
      return s.nickname || anonymousCode(s.competitionId, s.studentId);
    case "anonymous_code":
      return anonymousCode(s.competitionId, s.studentId);
    case "rank_score_only":
      return null;
  }
}
