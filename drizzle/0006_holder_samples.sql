CREATE TABLE "holder_samples" (
	"id" serial PRIMARY KEY NOT NULL,
	"taken_at" timestamp with time zone NOT NULL,
	"mint" text NOT NULL,
	"wallet" text NOT NULL,
	"balance_raw" bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "holder_samples_taken_mint_wallet_idx" ON "holder_samples" USING btree ("taken_at","mint","wallet");--> statement-breakpoint
CREATE INDEX "holder_samples_mint_taken_idx" ON "holder_samples" USING btree ("mint","taken_at");--> statement-breakpoint
CREATE INDEX "holder_samples_wallet_idx" ON "holder_samples" USING btree ("wallet");