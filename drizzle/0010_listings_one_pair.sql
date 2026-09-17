DROP INDEX "listings_mint_idx";--> statement-breakpoint
DROP INDEX "listings_signature_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "listings_mint_idx" ON "listings" USING btree ("mint");--> statement-breakpoint
CREATE UNIQUE INDEX "listings_signature_idx" ON "listings" USING btree ("signature");