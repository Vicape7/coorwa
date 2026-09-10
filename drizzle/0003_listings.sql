CREATE TABLE "listings" (
	"id" serial PRIMARY KEY NOT NULL,
	"mint" text NOT NULL,
	"ticker" text NOT NULL,
	"payer" text NOT NULL,
	"signature" text NOT NULL,
	"paid_raw" bigint NOT NULL,
	"paid_usd" double precision NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "listings_mint_ticker_idx" ON "listings" USING btree ("mint","ticker");--> statement-breakpoint
CREATE INDEX "listings_mint_idx" ON "listings" USING btree ("mint");--> statement-breakpoint
CREATE INDEX "listings_signature_idx" ON "listings" USING btree ("signature");