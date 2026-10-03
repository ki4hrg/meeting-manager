CREATE TABLE "group_emails" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meeting_groups" (
	"meeting_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	CONSTRAINT "meeting_groups_meeting_id_group_id_pk" PRIMARY KEY("meeting_id","group_id")
);
--> statement-breakpoint
CREATE TABLE "series_groups" (
	"series_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	CONSTRAINT "series_groups_series_id_group_id_pk" PRIMARY KEY("series_id","group_id")
);
--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "attendance_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "group_emails" ADD CONSTRAINT "group_emails_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_groups" ADD CONSTRAINT "meeting_groups_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_groups" ADD CONSTRAINT "meeting_groups_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "series_groups" ADD CONSTRAINT "series_groups_series_id_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."series"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "series_groups" ADD CONSTRAINT "series_groups_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "group_emails_email_key" ON "group_emails" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "group_emails_group_idx" ON "group_emails" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "meeting_groups_group_idx" ON "meeting_groups" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "series_groups_group_idx" ON "series_groups" USING btree ("group_id");--> statement-breakpoint
INSERT INTO "meeting_groups" ("meeting_id", "group_id") SELECT "id", "group_id" FROM "meetings" WHERE "group_id" IS NOT NULL;--> statement-breakpoint
INSERT INTO "series_groups" ("series_id", "group_id") SELECT "id", "group_id" FROM "series" WHERE "group_id" IS NOT NULL;--> statement-breakpoint
UPDATE "meetings" SET "attendance_at" = now() WHERE "starts_at" IS NOT NULL AND coalesce("ends_at", "starts_at" + interval '60 minutes') < now();
