CREATE TYPE "public"."proposal_status" AS ENUM('pending', 'accepted', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('queued', 'running', 'done', 'failed');--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"context_id" uuid NOT NULL,
	"project_id" uuid,
	"meeting_id" uuid,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"detail" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"meeting_id" uuid NOT NULL,
	"source" text NOT NULL,
	"external_id" text,
	"title" text,
	"body" text DEFAULT '' NOT NULL,
	"summary" text,
	"transcript" text,
	"content_hash" text NOT NULL,
	"external_updated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "processing_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"note_id" uuid NOT NULL,
	"content_hash" text NOT NULL,
	"status" "run_status" DEFAULT 'queued' NOT NULL,
	"model" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"output" jsonb,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"meeting_id" uuid NOT NULL,
	"note_id" uuid,
	"run_id" uuid,
	"status" "proposal_status" DEFAULT 'pending' NOT NULL,
	"fingerprint" text NOT NULL,
	"payload" jsonb NOT NULL,
	"verbatim" boolean DEFAULT false NOT NULL,
	"low_confidence" boolean DEFAULT false NOT NULL,
	"agenda_line_id" uuid,
	"position" integer DEFAULT 0 NOT NULL,
	"result" jsonb,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_context_id_contexts_id_fk" FOREIGN KEY ("context_id") REFERENCES "public"."contexts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_runs" ADD CONSTRAINT "processing_runs_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_run_id_processing_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."processing_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_agenda_line_id_agenda_lines_id_fk" FOREIGN KEY ("agenda_line_id") REFERENCES "public"."agenda_lines"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "documents_project_idx" ON "documents" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "documents_context_idx" ON "documents" USING btree ("context_id");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_events_delivery_key" ON "integration_events" USING btree ("provider","external_id");--> statement-breakpoint
CREATE INDEX "integration_events_received_idx" ON "integration_events" USING btree ("received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "notes_external_key" ON "notes" USING btree ("source","external_id") WHERE "notes"."external_id" is not null;--> statement-breakpoint
CREATE INDEX "notes_meeting_idx" ON "notes" USING btree ("meeting_id");--> statement-breakpoint
CREATE UNIQUE INDEX "processing_runs_key" ON "processing_runs" USING btree ("note_id","content_hash");--> statement-breakpoint
CREATE INDEX "processing_runs_status_idx" ON "processing_runs" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "proposals_fingerprint_key" ON "proposals" USING btree ("meeting_id","fingerprint");--> statement-breakpoint
CREATE INDEX "proposals_meeting_idx" ON "proposals" USING btree ("meeting_id","status");