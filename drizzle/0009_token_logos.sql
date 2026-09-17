CREATE TABLE "token_logos" (
	"mint" text PRIMARY KEY NOT NULL,
	"logo" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
