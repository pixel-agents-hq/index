CREATE TYPE "public"."webhook_delivery_status" AS ENUM('pending', 'retrying', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "share_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sharer_user_id" uuid NOT NULL,
	"data" jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"status" "webhook_delivery_status" DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"last_status_code" integer,
	"last_error" text,
	"locked_until" timestamp with time zone,
	"lock_token" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_deliveries_attempts_nonnegative" CHECK ("webhook_deliveries"."attempt_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "webhook_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"endpoint_url" text NOT NULL,
	"encrypted_secret" text NOT NULL,
	"secret_hint" text NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_by_discord_id" text NOT NULL,
	"created_by_username" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_failure_at" timestamp with time zone,
	"last_failure" text,
	"secret_rotated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_subscriptions_name_not_blank" CHECK (length(btrim("webhook_subscriptions"."name")) > 0),
	CONSTRAINT "webhook_subscriptions_secret_hint_length" CHECK (length("webhook_subscriptions"."secret_hint") = 4),
	CONSTRAINT "webhook_subscriptions_failures_nonnegative" CHECK ("webhook_subscriptions"."consecutive_failures" >= 0)
);
--> statement-breakpoint
ALTER TABLE "share_events" ADD CONSTRAINT "share_events_sharer_user_id_users_id_fk" FOREIGN KEY ("sharer_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_event_id_share_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."share_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_subscription_id_webhook_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."webhook_subscriptions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_subscriptions" ADD CONSTRAINT "webhook_subscriptions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "share_events_sharer_occurred_idx" ON "share_events" USING btree ("sharer_user_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_deliveries_event_subscription_key" ON "webhook_deliveries" USING btree ("event_id","subscription_id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_due_idx" ON "webhook_deliveries" USING btree ("next_attempt_at") WHERE status IN ('pending', 'retrying');--> statement-breakpoint
CREATE INDEX "webhook_deliveries_subscription_idx" ON "webhook_deliveries" USING btree ("subscription_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_subscriptions_name_key" ON "webhook_subscriptions" USING btree ("name");--> statement-breakpoint
CREATE INDEX "webhook_subscriptions_creator_idx" ON "webhook_subscriptions" USING btree ("created_by_user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "webhook_subscriptions_active_idx" ON "webhook_subscriptions" USING btree ("created_at") WHERE active = true;