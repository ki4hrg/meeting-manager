CREATE TABLE "todoist_comments" (
	"connection_id" uuid NOT NULL,
	"comment_id" text NOT NULL,
	"task_id" text NOT NULL,
	"content" text NOT NULL,
	"posted_at" timestamp with time zone NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "todoist_comments_connection_id_comment_id_pk" PRIMARY KEY("connection_id","comment_id")
);
--> statement-breakpoint
ALTER TABLE "todoist_comments" ADD CONSTRAINT "todoist_comments_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "todoist_comments_task_idx" ON "todoist_comments" USING btree ("connection_id","task_id");