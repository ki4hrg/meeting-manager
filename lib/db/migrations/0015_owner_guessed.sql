ALTER TABLE "proposals" RENAME COLUMN "low_confidence" TO "owner_guessed";--> statement-breakpoint
-- Accepting a proposal confirms its owner: no accepted row is still a guess.
UPDATE "proposals" SET "owner_guessed" = false WHERE "status" = 'accepted';--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_guess_unconfirmed" CHECK (not ("proposals"."owner_guessed" and "proposals"."status" = 'accepted'));
