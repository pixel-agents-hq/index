ALTER TABLE "custom_assets" ADD COLUMN "tags" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
CREATE INDEX "custom_assets_tags_idx" ON "custom_assets" USING gin ("tags");