CREATE TABLE "payout_cycles" (
	"id" serial PRIMARY KEY NOT NULL,
	"as_of" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"cook_price_usd" double precision NOT NULL,
	"total_usd" double precision DEFAULT 0 NOT NULL,
	"cost_budget_usd" double precision DEFAULT 0 NOT NULL,
	"bridge_cook_raw" bigint,
	"bridge_signature" text,
	"solana_cook_before" bigint,
	"sol_before" bigint,
	"costs_usd" double precision,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payout_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"allocated_in" integer NOT NULL,
	"paid_in" integer,
	"wallet" text NOT NULL,
	"mint" text NOT NULL,
	"ticker" text NOT NULL,
	"role" text NOT NULL,
	"balance_raw" bigint NOT NULL,
	"amount_usd" double precision NOT NULL,
	"status" text DEFAULT 'allocated' NOT NULL,
	"asset_raw" bigint,
	"signature" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payout_swaps" (
	"id" serial PRIMARY KEY NOT NULL,
	"cycle_id" integer NOT NULL,
	"ticker" text NOT NULL,
	"cook_raw" bigint NOT NULL,
	"asset_raw" bigint,
	"signature" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "payout_cycles_status_idx" ON "payout_cycles" USING btree ("status");--> statement-breakpoint
CREATE INDEX "payout_lines_wallet_idx" ON "payout_lines" USING btree ("wallet");--> statement-breakpoint
CREATE INDEX "payout_lines_mint_idx" ON "payout_lines" USING btree ("mint");--> statement-breakpoint
CREATE INDEX "payout_lines_paid_in_idx" ON "payout_lines" USING btree ("paid_in");--> statement-breakpoint
CREATE INDEX "payout_lines_status_idx" ON "payout_lines" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "payout_swaps_cycle_ticker_idx" ON "payout_swaps" USING btree ("cycle_id","ticker");