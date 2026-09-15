CREATE TABLE "holder_rewards" (
	"id" serial PRIMARY KEY NOT NULL,
	"epoch" bigint NOT NULL,
	"mint" text NOT NULL,
	"wallet" text NOT NULL,
	"balance_raw" bigint NOT NULL,
	"amount_usd" double precision NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "holder_rewards_epoch_mint_wallet_idx" ON "holder_rewards" USING btree ("epoch","mint","wallet");--> statement-breakpoint
CREATE INDEX "holder_rewards_wallet_idx" ON "holder_rewards" USING btree ("wallet");--> statement-breakpoint
CREATE INDEX "holder_rewards_mint_idx" ON "holder_rewards" USING btree ("mint");