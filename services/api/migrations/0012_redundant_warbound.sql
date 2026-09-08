ALTER TYPE "public"."audit_action" ADD VALUE 'asset.create';--> statement-breakpoint
ALTER TYPE "public"."audit_target_type" ADD VALUE 'asset';--> statement-breakpoint
CREATE TABLE "custom_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" text NOT NULL,
	"requested_asset_id" text NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"sprites" jsonb NOT NULL,
	"raw_zip" "bytea" NOT NULL,
	"author_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "custom_assets_asset_id_format" CHECK ("custom_assets"."asset_id" ~ '^[A-Z][A-Z0-9_]*$')
);
--> statement-breakpoint
ALTER TABLE "custom_assets" ADD CONSTRAINT "custom_assets_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "custom_assets_asset_id_key" ON "custom_assets" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "custom_assets_author_idx" ON "custom_assets" USING btree ("author_user_id");--> statement-breakpoint
CREATE INDEX "custom_assets_public_created_idx" ON "custom_assets" USING btree ("created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "custom_assets_category_idx" ON "custom_assets" USING btree ("category");