ALTER TABLE "meeting_people" ADD COLUMN "group_id" uuid;--> statement-breakpoint
ALTER TABLE "meeting_people" ADD CONSTRAINT "meeting_people_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Who was at a meeting already settled: a member of one of its groups came with that group.
UPDATE "meeting_people" AS mp SET "group_id" = (
	SELECT mg."group_id" FROM "meeting_groups" mg
	JOIN "group_members" gm ON gm."group_id" = mg."group_id" AND gm."person_id" = mp."person_id"
	WHERE mg."meeting_id" = mp."meeting_id"
	ORDER BY mg."group_id" LIMIT 1
)
FROM "meetings" m
WHERE m."id" = mp."meeting_id" AND m."attendance_at" IS NOT NULL;--> statement-breakpoint
-- 0012 settled every meeting already over without copying its groups' members onto it. Copy those who
-- were members by the time it ended and were not marked out.
INSERT INTO "meeting_people" ("meeting_id", "person_id", "group_id")
SELECT DISTINCT ON (m."id", gm."person_id") m."id", gm."person_id", mg."group_id"
FROM "meetings" m
JOIN "meeting_groups" mg ON mg."meeting_id" = m."id"
JOIN "group_members" gm ON gm."group_id" = mg."group_id"
JOIN "people" p ON p."id" = gm."person_id"
WHERE m."attendance_at" IS NOT NULL
	AND NOT p."is_self" AND p."deleted_at" IS NULL
	AND gm."created_at" <= coalesce(m."ends_at", m."starts_at" + interval '60 minutes', m."attendance_at")
	AND NOT EXISTS (
		SELECT 1 FROM "meeting_absences" a WHERE a."meeting_id" = m."id" AND a."person_id" = gm."person_id"
	)
ORDER BY m."id", gm."person_id", mg."group_id"
ON CONFLICT DO NOTHING;
