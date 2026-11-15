ALTER TYPE "public"."audit_action" ADD VALUE 'soundtrack.create';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'soundtrack.delete';--> statement-breakpoint
ALTER TYPE "public"."audit_target_type" ADD VALUE 'soundtrack';--> statement-breakpoint
CREATE TABLE "soundtracks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"mood" text NOT NULL,
	"title" text,
	"author_user_id" uuid NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "soundtracks_code_format" CHECK ("soundtracks"."code" ~ '^[A-Z]+-[0-9]-[0-9A-F]{8}$')
);
--> statement-breakpoint
ALTER TABLE "soundtracks" ADD CONSTRAINT "soundtracks_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "soundtracks_author_code_key" ON "soundtracks" USING btree ("author_user_id","code") WHERE "soundtracks"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "soundtracks_public_created_idx" ON "soundtracks" USING btree ("created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "soundtracks_author_idx" ON "soundtracks" USING btree ("author_user_id");