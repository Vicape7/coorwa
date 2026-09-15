ALTER TABLE "fills" ADD COLUMN "ticker" text;--> statement-breakpoint
CREATE INDEX "fills_pair_idx" ON "fills" USING btree ("mint","ticker");