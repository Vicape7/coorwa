CREATE TABLE "tax_sweeps" (
	"id" serial PRIMARY KEY NOT NULL,
	"mint" text NOT NULL,
	"status" text NOT NULL,
	"signature" text,
	"token_raw" bigint,
	"cook_raw" bigint,
	"cook_price_usd" double precision,
	"value_usd" double precision,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "tax_sweeps_signature_idx" ON "tax_sweeps" USING btree ("signature");--> statement-breakpoint
CREATE UNIQUE INDEX "tax_sweeps_one_pending_idx" ON "tax_sweeps" USING btree ("mint") WHERE "tax_sweeps"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "tax_sweeps_mint_idx" ON "tax_sweeps" USING btree ("mint","created_at");