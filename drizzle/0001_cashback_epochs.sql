DROP TABLE "payouts" CASCADE;
--> statement-breakpoint
CREATE TABLE "claims" (
	"id" serial PRIMARY KEY NOT NULL,
	"epoch" bigint NOT NULL,
	"wallet" text NOT NULL,
	"amount_raw" bigint NOT NULL,
	"amount_usd" double precision NOT NULL,
	"trader_usd" double precision DEFAULT 0 NOT NULL,
	"creator_usd" double precision DEFAULT 0 NOT NULL,
	"signature" text,
	"claimed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "epochs" (
	"index" bigint PRIMARY KEY NOT NULL,
	"root" text NOT NULL,
	"total_raw" bigint NOT NULL,
	"total_usd" double precision NOT NULL,
	"claimants" integer NOT NULL,
	"cook_price_usd" double precision NOT NULL,
	"as_of" timestamp with time zone NOT NULL,
	"deadline" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"signature" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "claims_epoch_wallet_idx" ON "claims" USING btree ("epoch","wallet");--> statement-breakpoint
CREATE INDEX "claims_wallet_idx" ON "claims" USING btree ("wallet");--> statement-breakpoint
CREATE INDEX "epochs_status_idx" ON "epochs" USING btree ("status");
