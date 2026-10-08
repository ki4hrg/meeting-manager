ALTER TABLE "users" ADD COLUMN "oidc_issuer" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "oidc_subject" text;--> statement-breakpoint
CREATE UNIQUE INDEX "users_oidc_key" ON "users" USING btree ("oidc_issuer","oidc_subject") WHERE "users"."oidc_subject" is not null and "users"."deleted_at" is null;