import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import { db } from "./db";
import { scanVideo, scanChannel, resolveChannelId } from "./scanner";

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

// ── Boot ─────────────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT ?? 4242);
export default { port: PORT, fetch: app.fetch };
console.log(`DealDrop running at http://localhost:${PORT}`);
