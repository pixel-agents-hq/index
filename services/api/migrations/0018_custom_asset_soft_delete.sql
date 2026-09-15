ALTER TYPE "public"."audit_action" ADD VALUE 'asset.delete' BEFORE 'apikey.create';--> statement-breakpoint
ALTER TABLE "custom_assets" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "custom_assets_deleted_idx" ON "custom_assets" USING btree ("deleted_at");--> statement-breakpoint
ALTER TABLE "custom_assets" ADD CONSTRAINT "custom_assets_builtin_never_deleted" CHECK ("custom_assets"."source" = 'custom' OR "custom_assets"."deleted_at" IS NULL);