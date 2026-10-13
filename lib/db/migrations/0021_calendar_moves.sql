ALTER TABLE "meetings" ADD COLUMN "calendar_starts_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "calendar_ends_at" timestamp with time zone;--> statement-breakpoint
UPDATE "meetings" SET "calendar_starts_at" = "starts_at", "calendar_ends_at" = "ends_at" WHERE "calendar_event_id" IS NOT NULL;
