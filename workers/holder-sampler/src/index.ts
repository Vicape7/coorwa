/**
 * Coorwa holder sampler.
 *
 * Holder rewards are shared by what each wallet held across the day, not at one moment, so the app
 * needs holder samples taken between payout runs. This Worker does nothing but ask for one on a cron:
 * the app decides whether to take it, reads the chain and stores the result. Keeping the logic in
 * the app means one place knows the rules, and this stays small enough to read at a glance.
 */
interface Env {
  /** The Coorwa app Worker, bound by name. */
  APP: { fetch(input: string, init?: RequestInit): Promise<Response> };
  SAMPLE_URL: string;
  HOLDER_SAMPLE_SECRET: string;
}

interface ScheduledEvent {
  cron: string;
  scheduledTime: number;
}

interface Context {
  waitUntil(promise: Promise<unknown>): void;
}

async function requestSample(env: Env): Promise<void> {
  // Through the service binding, not the public internet: Cloudflare refuses a plain fetch from one
  // Worker to another on the same account's workers.dev (error 1042), and the call never left.
  const res = await env.APP.fetch(env.SAMPLE_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${env.HOLDER_SAMPLE_SECRET}` },
  });
  const body = await res.text();
  // Logged for `wrangler tail` and the dashboard. The body names no secret.
  console.log(JSON.stringify({ status: res.status, body: body.slice(0, 500) }));
  if (!res.ok) throw new Error(`sample request failed with ${res.status}`);
}

const sampler = {
  async scheduled(_event: ScheduledEvent, env: Env, ctx: Context): Promise<void> {
    ctx.waitUntil(requestSample(env));
  },
};

export default sampler;
