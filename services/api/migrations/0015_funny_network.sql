CREATE TYPE "public"."asset_source" AS ENUM('builtin', 'custom');--> statement-breakpoint
-- Added nullable, backfilled, THEN made NOT NULL — same reasoning as
-- 0014_asset_kind.sql: every row this repo has ever written before this
-- migration was an upload through POST /api/v1/assets, and that has to be
-- an explicit fact this migration states, not a DEFAULT that would silently
-- mask it for every future insert too.
ALTER TABLE "custom_assets" ADD COLUMN "source" "asset_source";--> statement-breakpoint
ALTER TABLE "custom_assets" ADD COLUMN "source_commit" text;--> statement-breakpoint
UPDATE "custom_assets" SET "source" = 'custom';--> statement-breakpoint
ALTER TABLE "custom_assets" ALTER COLUMN "source" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "custom_assets_source_idx" ON "custom_assets" USING btree ("source");--> statement-breakpoint
ALTER TABLE "custom_assets" ADD CONSTRAINT "custom_assets_source_commit_by_source" CHECK (("custom_assets"."source" = 'builtin' AND "custom_assets"."source_commit" IS NOT NULL) OR ("custom_assets"."source" = 'custom' AND "custom_assets"."source_commit" IS NULL));
