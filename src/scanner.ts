import { db } from "./db";

// ── Types ────────────────────────────────────────────────────────────────────

interface Snippet {
  text: string;
  start: number;
  duration: number;
}

interface DetectedDeal {
  label: string;
  code: string | null;
  context: string;
  timestampSeconds: number;
  timestampLabel: string;
}

// ── Transcript via Python subprocess (works on local IPs, blocked on cloud) ──

async function fetchTranscript(videoId: string): Promise<Snippet[]> {
  const script = `
import sys, json
from youtube_transcript_api import YouTubeTranscriptApi
api = YouTubeTranscriptApi()
try:
    snippets = list(api.fetch(sys.argv[1]))
    print(json.dumps([{"text": s.text, "start": s.start, "duration": s.duration} for s in snippets]))
except Exception as e:
    print(json.dumps({"error": str(e)}))
`.trim();

  const proc = Bun.spawn(["python3", "-c", script, videoId], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const raw = await new Response(proc.stdout).text();
  await proc.exited;

  let parsed: any;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    throw new Error("Transcript parse failed");
  }

  if (parsed?.error) throw new Error(parsed.error);
  return parsed as Snippet[];
}

// ── Promo detection ──────────────────────────────────────────────────────────

const PROMO_RULES: { pattern: RegExp; label: string }[] = [
  { pattern: /use\s+(?:code|coupon)\s+["']?([A-Z0-9_\-]{3,20})["']?/i, label: "Promo code" },
  { pattern: /(?:discount|promo)\s+code[:\s]+["']?([A-Z0-9_\-]{3,20})["']?/i, label: "Discount code" },
  { pattern: /(?:get|save)\s+(?:\d+%|\$\d+)\s+(?:off|with)\s+(?:code\s+)?["']?([A-Z0-9_\-]{3,20})["']?/i, label: "Discount code" },
  { pattern: /([A-Z0-9_\-]{3,20})\s+(?:for|to\s+get)\s+(?:\d+%|\$\d+)\s+off/i, label: "Discount code" },
  { pattern: /free\s+trial\b/i, label: "Free trial" },
  { pattern: /\d+\s*(?:month|day|week)s?\s+free\b/i, label: "Free trial" },
  { pattern: /first\s+\d+\s+(?:people|users|customers).*?free\b/i, label: "Limited offer" },
  { pattern: /giveaway\b/i, label: "Giveaway" },
  { pattern: /(?:link\s+in\s+(?:the\s+)?(?:description|bio)|check\s+(?:the\s+)?description).*?(?:discount|deal|code|offer|free)/i, label: "Deal in description" },
  { pattern: /limited\s+time\s+offer\b/i, label: "Limited offer" },
  { pattern: /exclusive\s+(?:deal|discount|offer)\b/i, label: "Exclusive deal" },
  { pattern: /affiliate\s+(?:link|discount)\b/i, label: "Affiliate deal" },
];

function detectDeals(snippets: Snippet[]): DetectedDeal[] {
  const found: DetectedDeal[] = [];
  const WINDOW = 4; // merge nearby snippets for context

  for (let i = 0; i < snippets.length; i++) {
    const window = snippets.slice(Math.max(0, i - 1), i + WINDOW);
    const text = window.map((s) => s.text).join(" ");

    for (const rule of PROMO_RULES) {
      const match = text.match(rule.pattern);
      if (!match) continue;

      const code = match[1] ?? null;

      // deduplicate — skip if we already found the same code/label at roughly the same time
      const already = found.some(
        (f) => f.label === rule.label && f.code === code && Math.abs(f.timestampSeconds - snippets[i].start) < 30,
      );
      if (already) continue;

      found.push({
        label: rule.label,
        code: code?.toUpperCase() ?? null,
        context: text.slice(0, 220),
        timestampSeconds: Math.floor(snippets[i].start),
        timestampLabel: formatTimestamp(snippets[i].start),
      });
      break; // one hit per snippet window
    }
  }

  return found;
}

// ── RSS channel fetcher ──────────────────────────────────────────────────────

interface RssVideo {
  id: string;
  title: string;
  url: string;
}

async function fetchRssVideos(channelId: string, max = 5): Promise<RssVideo[]> {
  const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  const res = await fetch(rssUrl);
  if (!res.ok) throw new Error(`RSS fetch failed (${res.status})`);
  const xml = await res.text();

  const videos: RssVideo[] = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let m: RegExpExecArray | null;
  while ((m = entryRegex.exec(xml)) !== null && videos.length < max) {
    const entry = m[1];
    const idMatch = entry.match(/<yt:videoId>([^<]+)<\/yt:videoId>/);
    const titleMatch = entry.match(/<title>([^<]+)<\/title>/);
    if (idMatch && titleMatch) {
      videos.push({
        id: idMatch[1],
        title: titleMatch[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"),
        url: `https://www.youtube.com/watch?v=${idMatch[1]}`,
      });
    }
  }
  return videos;
}

export async function resolveChannelId(url: string): Promise<{ id: string; name: string } | null> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
      },
    });
    const html = await res.text();
    const idMatch = html.match(/"channelId"\s*:\s*"(UC[^"]{22})"/);
    const nameMatch = html.match(/"channelName"\s*:\s*"([^"]+)"/) || html.match(/"author"\s*:\s*"([^"]+)"/);
    if (!idMatch) return null;
    return { id: idMatch[1], name: nameMatch?.[1] ?? url };
  } catch {
    return null;
  }
}

// ── Public scan functions ────────────────────────────────────────────────────

export async function scanVideo(videoId: string, videoTitle: string, videoUrl: string, channelName: string) {
  if (db.isVideoScanned(videoId)) return { skipped: true, deals: [] };

  let snippets: Snippet[];
  try {
    snippets = await fetchTranscript(videoId);
  } catch (err: any) {
    db.markVideoScanned(videoId);
    throw new Error(err.message ?? "Could not fetch transcript");
  }

  const deals = detectDeals(snippets);
  for (const d of deals) {
    db.addDeal({ videoId, videoTitle, channelName, videoUrl, ...d });
  }
  db.markVideoScanned(videoId);
  return { skipped: false, deals };
}

export async function scanChannel(channelId: string) {
  const channel = db.getChannels().find((c) => c.id === channelId);
  if (!channel) throw new Error("Channel not found");

  const videos = await fetchRssVideos(channelId, 5);
  const results = [];
  for (const v of videos) {
    try {
      const r = await scanVideo(v.id, v.title, v.url, channel.name);
      results.push({ videoId: v.id, title: v.title, ...r });
    } catch (e: any) {
      results.push({ videoId: v.id, title: v.title, error: e.message });
    }
  }
  return results;
}
