ALTER TABLE "items" ADD COLUMN "later_until_item_id" uuid;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_later_until_item_id_items_id_fk" FOREIGN KEY ("later_until_item_id") REFERENCES "public"."items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "items_later_until_item_idx" ON "items" USING btree ("later_until_item_id");--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_later_until_other" CHECK ("items"."later_until_item_id" <> "items"."id");