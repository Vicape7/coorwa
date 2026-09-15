/**
 * Coorwa holder sampler.
 *
 * Holder rewards are shared by what each wallet held across an epoch, not at one moment, so the app
 * needs holder samples taken between epochs. This Worker does nothing but ask for one on a cron:
 * the app decides whether to take it, reads the chain and stores the result. Keeping the logic in
 * the app means one place knows the rules, and this stays small enough to read at a glance.
 */
interface Env {
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
  const res = await fetch(env.SAMPLE_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${env.HOLDER_SAMPLE_SECRET}` },
  });
  const body = await res.text();
  // Logged for `wrangler tail` and the dashboard. The body names no secret.
  console.log(JSON.stringify({ status: res.status, body: body.slice(0, 500) }));
  if (!res.ok) throw new Error(`sample request failed with ${res.status}`);
}

export default {
  async scheduled(_event: ScheduledEvent, env: Env, ctx: Context): Promise<void> {
    ctx.waitUntil(requestSample(env));
  },
};
