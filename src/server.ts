import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import { db } from "./db";
import { scanVideo, scanChannel, resolveChannelId } from "./scanner";
import {
  normalizePhone,
  maskPhone,
  buildDealSms,
  sendSms,
  notifyMissedDeals,
  SMS_CONFIGURED,
} from "./notify";

const app = new Hono();
app.use("*", cors());

// ── Static frontend ──────────────────────────────────────────────────────────
app.use("/*", serveStatic({ root: "./public" }));

// ── Helpers ──────────────────────────────────────────────────────────────────
function extractVideoId(url: string): string | null {
  const m = url.match(/(?:v=|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

async function fetchVideoTitle(videoId: string): Promise<string> {
  try {
    const res = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    const html = await res.text();
    const m = html.match(/<title>([^<]+)<\/title>/);
    return m ? m[1].replace(" - YouTube", "").trim() : videoId;
  } catch {
    return videoId;
  }
}

// ── API: Deals ───────────────────────────────────────────────────────────────
app.get("/api/deals", (c) => c.json(db.getDeals()));

app.delete("/api/deals/:id", (c) => {
  db.removeDeal(Number(c.req.param("id")));
  return c.json({ ok: true });
});

// ── API: Scan a video ────────────────────────────────────────────────────────
app.post("/api/scan", async (c) => {
  const { url } = await c.req.json<{ url: string }>();
  const videoId = extractVideoId(url);
  if (!videoId) return c.json({ error: "Could not extract video ID from URL" }, 400);

  const title = await fetchVideoTitle(videoId);
  try {
    const result = await scanVideo(videoId, title, `https://www.youtube.com/watch?v=${videoId}`, "Direct scan");
    return c.json({ ok: true, dealsFound: result.deals.length, skipped: result.skipped });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// ── API: Channels ────────────────────────────────────────────────────────────
app.get("/api/channels", (c) => c.json(db.getChannels()));

app.post("/api/channels", async (c) => {
  const { url } = await c.req.json<{ url: string }>();
  const resolved = await resolveChannelId(url);
  if (!resolved) return c.json({ error: "Could not resolve channel. Make sure it's a valid YouTube channel URL." }, 400);

  const channel = db.addChannel({ id: resolved.id, name: resolved.name, url });

  // Kick off background scan (don't await — return immediately)
  scanChannel(resolved.id).catch(console.error);

  return c.json({ ok: true, channel });
});

app.delete("/api/channels/:id", (c) => {
  db.removeChannel(c.req.param("id"));
  return c.json({ ok: true });
});

app.post("/api/channels/:id/scan", async (c) => {
  try {
    const results = await scanChannel(c.req.param("id"));
    return c.json({ ok: true, results });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// ── API: Scan all channels ───────────────────────────────────────────────────
app.post("/api/scan-all", async (c) => {
  const channels = db.getChannels();
  // fire-and-forget each channel
  for (const ch of channels) scanChannel(ch.id).catch(console.error);
  return c.json({ ok: true, channelsQueued: channels.length });
});

// ── API: SMS subscriber ──────────────────────────────────────────────────────
const DEMO_CHANNELS = [
  { id: "UCXuqSBlHAE6Xw-yeJA0Tunw", name: "Linus Tech Tips", url: "https://www.youtube.com/@LinusTechTips" },
  { id: "UCBJycsmduvYEL83R_U4JriQ", name: "MKBHD", url: "https://www.youtube.com/@mkbhd" },
];

app.get("/api/sms", (c) => {
  const sub = db.getSubscriber();
  return c.json({
    subscribed: Boolean(sub),
    enabled: sub?.enabled ?? false,
    phoneMasked: sub ? maskPhone(sub.phone) : null,
    smsConfigured: SMS_CONFIGURED,
  });
});

app.post("/api/sms/subscribe", async (c) => {
  const { phone } = await c.req.json<{ phone: string }>();
  const normalized = normalizePhone(phone ?? "");
  if (!normalized) {
    return c.json({ error: "Enter a valid phone number (e.g. +1 415 555 2671 or 4155552671)." }, 400);
  }
  const sub = db.setSubscriber(normalized);

  // Send a confirmation text right away.
  const welcome =
    "🎯 You're set on YTScan. We'll text you the promo codes & deals buried in new videos from the channels you watch — so you never have to sit through the sponsor read again.";
  const result = await sendSms(normalized, welcome);
  db.addNotification({
    phone: normalized,
    body: welcome,
    dealCount: 0,
    source: "Welcome",
    mode: result.mode,
    ok: result.ok,
    error: result.error ?? null,
  });

  return c.json({
    ok: true,
    phoneMasked: maskPhone(normalized),
    mode: result.mode,
    smsConfigured: SMS_CONFIGURED,
  });
});

app.post("/api/sms/toggle", async (c) => {
  const { enabled } = await c.req.json<{ enabled: boolean }>();
  const sub = db.setSubscriberEnabled(Boolean(enabled));
  if (!sub) return c.json({ error: "No subscriber set." }, 400);
  return c.json({ ok: true, enabled: sub.enabled });
});

app.delete("/api/sms", (c) => {
  db.removeSubscriber();
  return c.json({ ok: true });
});

app.get("/api/notifications", (c) => c.json(db.getNotifications()));

// Send a test text of whatever deals already exist (or a sample).
app.post("/api/sms/test", async (c) => {
  const sub = db.getSubscriber();
  if (!sub) return c.json({ error: "Add your number first." }, 400);

  const deals = db.getDeals().slice(0, 3);
  let body: string;
  if (deals.length) {
    body = buildDealSms(
      deals.map((d) => ({
        channelName: d.channelName,
        videoTitle: d.videoTitle,
        videoUrl: d.videoUrl,
        label: d.label,
        code: d.code,
        timestampSeconds: d.timestampSeconds,
        timestampLabel: d.timestampLabel,
      })),
    );
  } else {
    body =
      "🎯 Sample YTScan alert: \"Use code LTT for 10% off\" (⏱ 2:14). Real alerts arrive automatically when channels you watch drop new videos.";
  }

  const result = await sendSms(sub.phone, body);
  db.addNotification({
    phone: sub.phone,
    body,
    dealCount: deals.length,
    source: "Test",
    mode: result.mode,
    ok: result.ok,
    error: result.error ?? null,
  });
  return c.json({ ok: result.ok, mode: result.mode, error: result.error });
});

// ── API: Demo (LTT + MKBHD) ──────────
const DEMO_DEALS = [
  {
    videoId: "demo-ltt-1",
    videoTitle: "We Built the ULTIMATE Gaming Setup",
    channelName: "Linus Tech Tips",
    videoUrl: "https://www.youtube.com/watch?v=demo-ltt-1",
    label: "Promo code",
    code: "LTT",
    context: "Head to the link below and use code LTT to get 10% off your first order of our new screwdriver and other merch.",
    timestampSeconds: 45,
    timestampLabel: "0:45",
  },
  {
    videoId: "demo-ltt-2",
    videoTitle: "This Mini PC Changes EVERYTHING",
    channelName: "Linus Tech Tips",
    videoUrl: "https://www.youtube.com/watch?v=demo-ltt-2",
    label: "Discount code",
    code: "WANSHOW",
    context: "Thanks to our sponsor — sign up today and use code WANSHOW to save $25 on your annual plan.",
    timestampSeconds: 372,
    timestampLabel: "6:12",
  },
  {
    videoId: "demo-mkbhd-1",
    videoTitle: "The Best Phones of 2026!",
    channelName: "MKBHD",
    videoUrl: "https://www.youtube.com/watch?v=demo-mkbhd-1",
    label: "Free trial",
    code: null,
    context: "This video is sponsored — the first 100 people to use the link in the description get a free 30-day trial.",
    timestampSeconds: 88,
    timestampLabel: "1:28",
  },
  {
    videoId: "demo-mkbhd-2",
    videoTitle: "Why I Switched My Whole Setup",
    channelName: "MKBHD",
    videoUrl: "https://www.youtube.com/watch?v=demo-mkbhd-2",
    label: "Discount code",
    code: "MKBHD20",
    context: "Use code MKBHD20 at checkout for 20% off — link is in the description below.",
    timestampSeconds: 510,
    timestampLabel: "8:30",
  },
];

app.post("/api/demo/load", async (c) => {
  for (const ch of DEMO_CHANNELS) db.addChannel(ch);

  // Seed realistic sample deals (hosted env can't fetch transcripts — YouTube IP-blocks datacenters)
  const seeded = [];
  for (const d of DEMO_DEALS) {
    if (db.isVideoScanned(d.videoId)) continue;
    const entry = db.addDeal(d);
    db.markVideoScanned(d.videoId);
    seeded.push(entry);
  }

  // Text the subscriber the deals they'd have missed
  if (seeded.length > 0) {
    await notifyMissedDeals(seeded, "Demo (LTT + MKBHD)");
  }

  return c.json({
    ok: true,
    channels: DEMO_CHANNELS.map((c) => c.name),
    dealsSeeded: seeded.length,
    texted: db.getSubscriber()?.enabled ?? false,
  });
});

// ── Boot ─────────────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT ?? 4242);
export default { port: PORT, fetch: app.fetch };
console.log(`YTScan running at http://localhost:${PORT}`);
