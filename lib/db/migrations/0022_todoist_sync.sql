CREATE TABLE "item_todoist_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"item_id" uuid,
	"task_id" text,
	"state" text NOT NULL,
	"unlinked_reason" text,
	"command_uuid" uuid,
	"temp_id" text,
	"base_text" text,
	"base_due_on" date,
	"base_closed" boolean DEFAULT false NOT NULL,
	"closed_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "todoist_tasks" (
	"connection_id" uuid NOT NULL,
	"task_id" text NOT NULL,
	"project_id" text,
	"content" text NOT NULL,
	"deadline" date,
	"checked" boolean DEFAULT false NOT NULL,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"is_recurring" boolean DEFAULT false NOT NULL,
	"completed_at" timestamp with time zone,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "todoist_tasks_connection_id_task_id_pk" PRIMARY KEY("connection_id","task_id")
);
--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "cursor" text;--> statement-breakpoint
ALTER TABLE "item_todoist_links" ADD CONSTRAINT "item_todoist_links_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_todoist_links" ADD CONSTRAINT "item_todoist_links_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "todoist_tasks" ADD CONSTRAINT "todoist_tasks_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "item_todoist_links_task_key" ON "item_todoist_links" USING btree ("connection_id","task_id") WHERE "item_todoist_links"."task_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "item_todoist_links_item_key" ON "item_todoist_links" USING btree ("item_id") WHERE "item_todoist_links"."item_id" is not null and "item_todoist_links"."state" <> 'unlinked';--> statement-breakpoint
CREATE INDEX "item_todoist_links_state_idx" ON "item_todoist_links" USING btree ("state");