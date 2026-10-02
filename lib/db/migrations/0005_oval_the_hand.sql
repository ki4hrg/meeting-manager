ALTER TABLE "notes" ALTER COLUMN "meeting_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agenda_lines" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "agenda_lines" ADD COLUMN "leader_person_id" uuid;--> statement-breakpoint
ALTER TABLE "notes" ADD COLUMN "filing" jsonb;--> statement-breakpoint
ALTER TABLE "notes" ADD COLUMN "dismissed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agenda_lines" ADD CONSTRAINT "agenda_lines_leader_person_id_people_id_fk" FOREIGN KEY ("leader_person_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notes_unfiled_idx" ON "notes" USING btree ("created_at") WHERE "notes"."meeting_id" is null;