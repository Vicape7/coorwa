CREATE TABLE "launches" (
	"mint" text PRIMARY KEY NOT NULL,
	"pool" text NOT NULL,
	"creator" text NOT NULL,
	"ticker" text NOT NULL,
	"symbol" text,
	"name" text,
	"signature" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "launches_signature_idx" ON "launches" USING btree ("signature");--> statement-breakpoint
CREATE INDEX "launches_creator_idx" ON "launches" USING btree ("creator");--> statement-breakpoint
CREATE INDEX "launches_ticker_idx" ON "launches" USING btree ("ticker");