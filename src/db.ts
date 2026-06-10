import { existsSync, readFileSync, writeFileSync } from "fs";

const DB_PATH = "./ytscan.json";

interface Channel {
  id: string;
  name: string;
  url: string;
  thumbnail?: string | null;
  addedAt: string;
}

interface Deal {
  id: number;
  videoId: string;
  videoTitle: string;
  channelName: string;
  videoUrl: string;
  label: string;
  code: string | null;
  context: string;
  dealUrl: string | null;
  expiresAt?: string | null;
  expiryText?: string | null;
  detectedAt: string;
}

interface Subscriber {
  phone: string;
  enabled: boolean;
  subscribedAt: string;
}

interface Notification {
  id: number;
  phone: string;
  body: string;
  dealCount: number;
  source: string;
  mode: "twilio" | "demo";
  ok: boolean;
  error: string | null;
  sentAt: string;
}

interface DbData {
  channels: Channel[];
  deals: Deal[];
  scannedVideos: string[];
  nextDealId: number;
  subscriber: Subscriber | null;
  notifications: Notification[];
  nextNotificationId: number;
}

function load(): DbData {
  const fallback: DbData = {
    channels: [],
    deals: [],
    scannedVideos: [],
    nextDealId: 1,
    subscriber: null,
    notifications: [],
    nextNotificationId: 1,
  };
  if (!existsSync(DB_PATH)) return fallback;
  try {
    return { ...fallback, ...JSON.parse(readFileSync(DB_PATH, "utf8")) };
  } catch {
    return fallback;
  }
}

function save(data: DbData) {
  writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

export const db = {
  getChannels: (): Channel[] => load().channels,

  addChannel: (channel: Omit<Channel, "addedAt">): Channel => {
    const data = load();
    const existing = data.channels.find((c) => c.id === channel.id);
    if (existing) return existing;
    const entry: Channel = { ...channel, addedAt: new Date().toISOString() };
    data.channels.push(entry);
    save(data);
    return entry;
  },

  removeChannel: (id: string) => {
    const data = load();
    data.channels = data.channels.filter((c) => c.id !== id);
    save(data);
  },

  getDeals: (): Deal[] => load().deals,

  dealExists: (videoId: string, code: string | null, label: string): boolean =>
    load().deals.some((d) => d.videoId === videoId && d.code === code && d.label === label),

  addDeal: (deal: Omit<Deal, "id" | "detectedAt">): Deal => {
    const data = load();
    const entry: Deal = { ...deal, id: data.nextDealId++, detectedAt: new Date().toISOString() };
    data.deals.unshift(entry);
    save(data);
    return entry;
  },

  removeDeal: (id: number) => {
    const data = load();
    data.deals = data.deals.filter((d) => d.id !== id);
    save(data);
  },

  isVideoScanned: (videoId: string): boolean => load().scannedVideos.includes(videoId),

  markVideoScanned: (videoId: string) => {
    const data = load();
    if (!data.scannedVideos.includes(videoId)) {
      data.scannedVideos.push(videoId);
      save(data);
    }
  },

  // ── Subscriber (single user for MVP) ──────────────────────────────────────
  getSubscriber: (): Subscriber | null => load().subscriber,

  setSubscriber: (phone: string): Subscriber => {
    const data = load();
    data.subscriber = { phone, enabled: true, subscribedAt: new Date().toISOString() };
    save(data);
    return data.subscriber;
  },

  setSubscriberEnabled: (enabled: boolean): Subscriber | null => {
    const data = load();
    if (data.subscriber) {
      data.subscriber.enabled = enabled;
      save(data);
    }
    return data.subscriber;
  },

  removeSubscriber: () => {
    const data = load();
    data.subscriber = null;
    save(data);
  },

  // ── Notifications log ─────────────────────────────────────────────────────
  getNotifications: (): Notification[] => load().notifications,

  addNotification: (n: Omit<Notification, "id" | "sentAt">): Notification => {
    const data = load();
    const entry: Notification = { ...n, id: data.nextNotificationId++, sentAt: new Date().toISOString() };
    data.notifications.unshift(entry);
    if (data.notifications.length > 50) data.notifications = data.notifications.slice(0, 50);
    save(data);
    return entry;
  },
};
