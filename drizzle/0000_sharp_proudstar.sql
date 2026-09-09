CREATE TABLE "fills" (
	"id" serial PRIMARY KEY NOT NULL,
	"signature" text NOT NULL,
	"wallet" text NOT NULL,
	"source" text NOT NULL,
	"mint" text NOT NULL,
	"symbol" text,
	"side" text NOT NULL,
	"value_usd" double precision NOT NULL,
	"fee_usd" double precision NOT NULL,
	"creator" text,
	"chain" text DEFAULT 'cookie' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payouts" (
	"id" serial PRIMARY KEY NOT NULL,
	"wallet" text NOT NULL,
	"role" text NOT NULL,
	"amount_usd" double precision NOT NULL,
	"amount_cook" double precision NOT NULL,
	"signature" text,
	"epoch" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "fills_signature_idx" ON "fills" USING btree ("signature");--> statement-breakpoint
CREATE INDEX "fills_wallet_idx" ON "fills" USING btree ("wallet");--> statement-breakpoint
CREATE INDEX "fills_creator_idx" ON "fills" USING btree ("creator");--> statement-breakpoint
CREATE INDEX "fills_created_idx" ON "fills" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "payouts_wallet_idx" ON "payouts" USING btree ("wallet");