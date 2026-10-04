ALTER TABLE "bindings" ADD COLUMN "series_id" uuid;--> statement-breakpoint
ALTER TABLE "bindings" ADD COLUMN "group_id" uuid;--> statement-breakpoint
ALTER TABLE "bindings" ADD CONSTRAINT "bindings_series_id_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."series"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bindings" ADD CONSTRAINT "bindings_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bindings" ADD CONSTRAINT "bindings_one_scope" CHECK (num_nonnulls("bindings"."project_id", "bindings"."series_id", "bindings"."group_id") <= 1);