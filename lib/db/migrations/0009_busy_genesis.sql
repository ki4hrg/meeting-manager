ALTER TABLE "items" DROP CONSTRAINT "items_one_target";--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "target_project_id" uuid;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_target_project_id_projects_id_fk" FOREIGN KEY ("target_project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "items_target_project_idx" ON "items" USING btree ("target_project_id");--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_one_target" CHECK (num_nonnulls("items"."target_meeting_id", "items"."target_series_id", "items"."target_project_id") <= 1);