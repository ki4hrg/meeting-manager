CREATE TABLE "agenda_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"meeting_id" uuid NOT NULL,
	"is_section" boolean DEFAULT false NOT NULL,
	"section_id" uuid,
	"position" integer DEFAULT 0 NOT NULL,
	"text" text,
	"item_id" uuid,
	"private_note" text,
	"minutes" integer,
	"pinned_start" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agenda_lines_section_shape" CHECK (not "agenda_lines"."is_section" or ("agenda_lines"."section_id" is null and "agenda_lines"."item_id" is null)),
	CONSTRAINT "agenda_lines_has_content" CHECK ("agenda_lines"."text" is not null or "agenda_lines"."item_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"external_id" text NOT NULL,
	"name" text NOT NULL,
	"context_id" uuid NOT NULL,
	"project_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"account" text NOT NULL,
	"credentials" text NOT NULL,
	"scopes" text DEFAULT '' NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meeting_dismissals" (
	"meeting_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meeting_dismissals_meeting_id_item_id_pk" PRIMARY KEY("meeting_id","item_id")
);
--> statement-breakpoint
CREATE TABLE "meeting_people" (
	"meeting_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	CONSTRAINT "meeting_people_meeting_id_person_id_pk" PRIMARY KEY("meeting_id","person_id")
);
--> statement-breakpoint
CREATE TABLE "meeting_projects" (
	"meeting_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	CONSTRAINT "meeting_projects_meeting_id_project_id_pk" PRIMARY KEY("meeting_id","project_id")
);
--> statement-breakpoint
CREATE TABLE "meetings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"context_id" uuid NOT NULL,
	"series_id" uuid,
	"group_id" uuid,
	"parent_meeting_id" uuid,
	"title" text NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"calendar_id" text,
	"calendar_event_id" text,
	"blocks" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "series" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"context_id" uuid NOT NULL,
	"name" text NOT NULL,
	"group_id" uuid,
	"calendar_series_id" text,
	"skeleton" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"blocks" jsonb DEFAULT '{"followUps":false,"sinceLast":false,"lookahead":false}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "series_people" (
	"series_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	CONSTRAINT "series_people_series_id_person_id_pk" PRIMARY KEY("series_id","person_id")
);
--> statement-breakpoint
CREATE TABLE "series_projects" (
	"series_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	CONSTRAINT "series_projects_series_id_project_id_pk" PRIMARY KEY("series_id","project_id")
);
--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "origin_meeting_id" uuid;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "target_meeting_id" uuid;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "target_series_id" uuid;--> statement-breakpoint
ALTER TABLE "agenda_lines" ADD CONSTRAINT "agenda_lines_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agenda_lines" ADD CONSTRAINT "agenda_lines_section_id_agenda_lines_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."agenda_lines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agenda_lines" ADD CONSTRAINT "agenda_lines_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bindings" ADD CONSTRAINT "bindings_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bindings" ADD CONSTRAINT "bindings_context_id_contexts_id_fk" FOREIGN KEY ("context_id") REFERENCES "public"."contexts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bindings" ADD CONSTRAINT "bindings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_dismissals" ADD CONSTRAINT "meeting_dismissals_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_dismissals" ADD CONSTRAINT "meeting_dismissals_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_people" ADD CONSTRAINT "meeting_people_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_people" ADD CONSTRAINT "meeting_people_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_projects" ADD CONSTRAINT "meeting_projects_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_projects" ADD CONSTRAINT "meeting_projects_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_context_id_contexts_id_fk" FOREIGN KEY ("context_id") REFERENCES "public"."contexts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_series_id_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."series"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_parent_meeting_id_meetings_id_fk" FOREIGN KEY ("parent_meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "series" ADD CONSTRAINT "series_context_id_contexts_id_fk" FOREIGN KEY ("context_id") REFERENCES "public"."contexts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "series" ADD CONSTRAINT "series_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "series_people" ADD CONSTRAINT "series_people_series_id_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."series"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "series_people" ADD CONSTRAINT "series_people_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "series_projects" ADD CONSTRAINT "series_projects_series_id_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."series"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "series_projects" ADD CONSTRAINT "series_projects_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agenda_lines_item_key" ON "agenda_lines" USING btree ("meeting_id","item_id") WHERE "agenda_lines"."item_id" is not null;--> statement-breakpoint
CREATE INDEX "agenda_lines_meeting_idx" ON "agenda_lines" USING btree ("meeting_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "bindings_external_key" ON "bindings" USING btree ("connection_id","kind","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "connections_account_key" ON "connections" USING btree ("provider",lower("account"));--> statement-breakpoint
CREATE INDEX "meeting_people_person_idx" ON "meeting_people" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "meeting_projects_project_idx" ON "meeting_projects" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "meetings_calendar_event_key" ON "meetings" USING btree ("calendar_event_id") WHERE "meetings"."calendar_event_id" is not null;--> statement-breakpoint
CREATE INDEX "meetings_context_start_idx" ON "meetings" USING btree ("context_id","starts_at");--> statement-breakpoint
CREATE INDEX "meetings_series_idx" ON "meetings" USING btree ("series_id","starts_at");--> statement-breakpoint
CREATE INDEX "meetings_parent_idx" ON "meetings" USING btree ("parent_meeting_id");--> statement-breakpoint
CREATE UNIQUE INDEX "series_name_key" ON "series" USING btree ("context_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "series_calendar_key" ON "series" USING btree ("calendar_series_id") WHERE "series"."calendar_series_id" is not null;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_origin_meeting_id_meetings_id_fk" FOREIGN KEY ("origin_meeting_id") REFERENCES "public"."meetings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_target_meeting_id_meetings_id_fk" FOREIGN KEY ("target_meeting_id") REFERENCES "public"."meetings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_target_series_id_series_id_fk" FOREIGN KEY ("target_series_id") REFERENCES "public"."series"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "items_target_meeting_idx" ON "items" USING btree ("target_meeting_id");--> statement-breakpoint
CREATE INDEX "items_target_series_idx" ON "items" USING btree ("target_series_id");--> statement-breakpoint
CREATE INDEX "items_origin_meeting_idx" ON "items" USING btree ("origin_meeting_id");--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_one_target" CHECK (num_nonnulls("items"."target_meeting_id", "items"."target_series_id") <= 1);