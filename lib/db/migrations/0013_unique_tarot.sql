ALTER TABLE "meetings" DROP CONSTRAINT "meetings_group_id_groups_id_fk";
--> statement-breakpoint
ALTER TABLE "series" DROP CONSTRAINT "series_group_id_groups_id_fk";
--> statement-breakpoint
ALTER TABLE "meetings" DROP COLUMN "group_id";--> statement-breakpoint
ALTER TABLE "series" DROP COLUMN "group_id";