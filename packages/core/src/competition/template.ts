import { CompetitionConfigSchema, type CompetitionConfig } from "./config.ts";

const DAY = 86_400_000;

/**
 * Starting configuration: Kindergarten / Primary / Secondary / Open groups,
 * a Qualifying round (top 20% advance) and a Final. Dates are placeholders
 * the admin replaces.
 */
export function standardTemplate(now: Date = new Date(), newId: () => string = () => crypto.randomUUID()): CompetitionConfig {
  const at = (days: number) => new Date(Math.floor((now.getTime() + days * DAY) / DAY) * DAY).toISOString();
  const groups = [
    { id: newId(), key: "kindergarten", name: { en: "Kindergarten", "zh-Hant": "幼稚園組", "zh-Hans": "幼儿园组", th: "อนุบาล" }, eligibility: { type: "grade_level" as const, min: -2, max: 0 } },
    { id: newId(), key: "primary", name: { en: "Primary", "zh-Hant": "小學組", "zh-Hans": "小学组", th: "ประถมศึกษา" }, eligibility: { type: "grade_level" as const, min: 1, max: 6 } },
    { id: newId(), key: "secondary", name: { en: "Secondary", "zh-Hant": "中學組", "zh-Hans": "中学组", th: "มัธยมศึกษา" }, eligibility: { type: "grade_level" as const, min: 7, max: 12 } },
    { id: newId(), key: "open", name: { en: "Open", "zh-Hant": "公開組", "zh-Hans": "公开组", th: "ประเภททั่วไป" }, eligibility: { type: "open" as const } },
  ];
  const qualifyingId = newId();
  return CompetitionConfigSchema.parse({
    groups,
    rounds: [
      {
        id: qualifyingId,
        key: "qualifying",
        name: { en: "Qualifying Round", "zh-Hant": "初賽", "zh-Hans": "初赛", th: "รอบคัดเลือก" },
        kind: "qualifying",
        opensAt: at(30),
        closesAt: at(37),
        groups: groups.map((g) => ({
          groupId: g.id,
          questionCount: 20,
          qualification: { criteria: [{ type: "top_percent", percent: 20 }] },
        })),
      },
      {
        id: newId(),
        key: "final",
        name: { en: "Final", "zh-Hant": "決賽", "zh-Hans": "决赛", th: "รอบชิงชนะเลิศ" },
        kind: "final",
        opensAt: at(45),
        closesAt: at(46),
        entry: { type: "qualified_from", roundId: qualifyingId },
        groups: groups.map((g) => ({ groupId: g.id, questionCount: 30, durationSeconds: 2700 })),
      },
    ],
  });
}
