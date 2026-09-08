CREATE TYPE "public"."asset_kind" AS ENUM('furniture', 'character', 'pet');--> statement-breakpoint
ALTER TABLE "custom_assets" ALTER COLUMN "category" DROP NOT NULL;--> statement-breakpoint
-- #105: added nullable, backfilled, THEN made NOT NULL — every row #101
-- ever wrote is furniture, and that has to be an explicit fact this
-- migration states, not a DEFAULT that would silently mask it for every
-- future insert too.
ALTER TABLE "custom_assets" ADD COLUMN "asset_kind" "asset_kind";--> statement-breakpoint
UPDATE "custom_assets" SET "asset_kind" = 'furniture';--> statement-breakpoint
ALTER TABLE "custom_assets" ALTER COLUMN "asset_kind" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "custom_assets_kind_idx" ON "custom_assets" USING btree ("asset_kind");--> statement-breakpoint
ALTER TABLE "custom_assets" ADD CONSTRAINT "custom_assets_category_by_kind" CHECK (("custom_assets"."asset_kind" = 'furniture' AND "custom_assets"."category" IS NOT NULL) OR ("custom_assets"."asset_kind" <> 'furniture' AND "custom_assets"."category" IS NULL));