ALTER TABLE "payout_cycles" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payout_lines" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;