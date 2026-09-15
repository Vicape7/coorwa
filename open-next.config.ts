import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// No incremental cache: every page and route that reads live data is dynamic already, so there is
// nothing worth keeping in R2 yet.
export default defineCloudflareConfig({});
