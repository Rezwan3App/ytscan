import { existsSync, readFileSync, writeFileSync } from "fs";

const DB_PATH = "./dealdrop.json";

interface Channel {
  id: string;
  name: string;
  url: string;
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
  timestampSeconds: number;
  timestampLabel: string;
  detectedAt: string;
}

interface DbData {
  channels: Channel[];
  deals: Deal[];
  scannedVideos: string[];
  nextDealId: number;
}

function load(): DbData {
  if (!existsSync(DB_PATH)) {
    return { channels: [], deals: [], scannedVideos: [], nextDealId: 1 };
  }
  try {
    return JSON.parse(readFileSync(DB_PATH, "utf8"));
  } catch {
    return { channels: [], deals: [], scannedVideos: [], nextDealId: 1 };
  }
}

function save(data: DbData) {
  writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

export const db = {
  getChannels: (): Channel[] => load().channels,

  addChannel: (channel: Omit<Channel, "addedAt">): Channel => {
    const data = load();
    if (data.channels.find((c) => c.id === channel.id)) return data.channels.find((c) => c.id === channel.id)!;
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
};
