import { createHash } from "node:crypto";
import { AppError, retryAfterSeconds } from "./http";
import { parseKugouPlaylistId } from "./playlist-source";
import type { Playlist, Song } from "./types";

const PAGE_SIZE = 100;
const MAX_SONGS = 10000;
type Json = Record<string, unknown>;
const object = (value: unknown): Json =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const count = (value: unknown) => {
  const n = typeof value === "number" || (typeof value === "string" && /^\d+$/.test(value))
    ? Number(value) : NaN;
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
};
function coverUrl(value: unknown) {
  const url = text(value).replace(/^http:/, "https:").replaceAll("{size}", "300");
  return url.startsWith("https://") ? url : undefined;
}

async function checkedFetch(url: URL, signal: AbortSignal, headers: Record<string, string> = {}) {
  const response = await fetch(url, {
    redirect: "manual",
    cache: "no-store",
    signal: AbortSignal.any([signal, AbortSignal.timeout(25000)]),
    headers: { "User-Agent": "Mozilla/5.0", Referer: "https://www.kugou.com/", ...headers },
  });
  if (response.status === 429)
    throw new AppError("酷狗音乐暂时限制读取，请稍后重试。", 429,
      retryAfterSeconds(response.headers.get("retry-after")));
  return response;
}

// Read the JSON literal only; never execute JavaScript from the remote page.
function pageInfo(html: string): Json {
  const start = /\bvar\s+specialInfo\s*=\s*(?=\{)/.exec(html);
  if (!start) return {};
  const offset = start.index + start[0].length;
  let depth = 0, quoted = false, escaped = false;
  for (let i = offset; i < html.length; i++) {
    const char = html[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) {
      try { return object(JSON.parse(html.slice(offset, i + 1))); }
      catch { return {}; }
    }
  }
  return {};
}

async function resolveCollection(id: string, signal: AbortSignal) {
  let current = id;
  for (let hop = 0; hop < 5; hop++) {
    const url = new URL(current.startsWith("gcid_")
      ? `https://www.kugou.com/songlist/${current}/`
      : `https://www.kugou.com/yy/special/single/${current}.html`);
    const response = await checkedFetch(url, signal);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      // Rebuild a canonical URL after validation instead of fetching arbitrary redirects.
      const next = location ? parseKugouPlaylistId(new URL(location, url).href) : null;
      if (!next) break;
      current = next;
      continue;
    }
    if (!response.ok)
      throw new AppError("无法读取酷狗歌单，请确认链接有效且歌单已公开。", response.status === 404 ? 422 : 502);
    const info = pageInfo(await response.text());
    const gcid = text(info.global_collection_id);
    if ((info.id !== undefined && !current.startsWith("gcid_") && String(info.id) !== current) ||
        (info.encode_gcid !== undefined && current.startsWith("gcid_") && info.encode_gcid !== current))
      throw new AppError("酷狗返回的歌单与链接不一致，请重新复制公开歌单链接。", 422);
    if (/^collection_\d+(?:_\d+){1,5}$/.test(gcid) && text(info.name)) return { gcid, info };
    break;
  }
  throw new AppError("酷狗未返回公开歌单资料，可能需要验证或链接已失效。请稍后重试，或在酷狗网页打开歌单后复制 /yy/special/single/数字.html 完整链接（也可输入该数字 ID）。", 422);
}

async function fetchPage(gcid: string, offset: number, signal: AbortSignal) {
  const params: Record<string, string> = {
    dfid: "-", mid: "0", uuid: "-", appid: "1005", clientver: "20489",
    clienttime: String(Math.floor(Date.now() / 1000)),
    area_code: "1", begin_idx: String(offset), plat: "1", type: "1", mode: "1",
    personal_switch: "1", extend_fields: "abtags,hot_cmt,popularization",
    pagesize: String(PAGE_SIZE), global_collection_id: gcid,
  };
  const salt = "OIlwieks28dk2k092lksi2UIkp";
  const sorted = Object.keys(params).sort().map((key) => `${key}=${params[key]}`).join("");
  params.signature = createHash("md5").update(salt + sorted + salt).digest("hex");
  const url = new URL("https://gateway.kugou.com/pubsongs/v2/get_other_list_file_nofilt");
  url.search = new URLSearchParams(params).toString();
  const response = await checkedFetch(url, signal, {
    "User-Agent": "Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi",
    dfid: "-", mid: "0", clienttime: params.clienttime,
    "kg-rc": "1", "kg-thash": "5d816a0", "kg-rec": "1", "kg-rf": "B9EDA08A64250DEFFBCADDEE00F8F25F",
  });
  if (!response.ok) throw new AppError("酷狗音乐暂时无法响应，请稍后重试。", 502);
  let json: Json;
  try { json = object(await response.json()); }
  catch { throw new AppError("酷狗返回的歌曲列表格式不正确，请稍后重试。", 502); }
  if (json.status !== 1 || json.error_code !== 0)
    throw new AppError("无法读取酷狗歌单，请确认链接有效且歌单已公开。私密歌单暂不支持。", 422);
  const data = object(json.data), detail = object(data.list_info);
  const validCount = typeof data.count === "number" || typeof data.count === "string"
    ? /^\d+$/.test(String(data.count)) && Number.isSafeInteger(Number(data.count)) : false;
  if (!Array.isArray(data.songs) || !validCount ||
      (data.begin_idx !== undefined && String(data.begin_idx) !== String(offset)))
    throw new AppError("酷狗返回的歌曲列表不完整，请稍后重试。", 502);
  if (count(detail.is_pri) || (detail.global_collection_id !== undefined && detail.global_collection_id !== gcid))
    throw new AppError("无法读取这个酷狗公开歌单。", 422);
  return { tracks: data.songs, total: count(data.count), detail };
}

function toSong(value: unknown): Song | null {
  const raw = object(value), album = object(raw.albuminfo);
  const hash = text(raw.hash);
  const id = /^[a-f\d]{32}$/i.test(hash) ? hash.toLowerCase() : count(raw.audio_id);
  const fullName = text(raw.name) || text(raw.filename);
  const separator = fullName.indexOf(" - ");
  const name = text(raw.songname) || text(raw.audio_name) ||
    (separator >= 0 ? fullName.slice(separator + 3).trim() : fullName);
  if (!id || !name) return null;
  const artists = Array.isArray(raw.singerinfo)
    ? raw.singerinfo.map((v) => text(object(v).name)).filter(Boolean) : [];
  if (!artists.length) {
    const singer = text(raw.singername) || (separator >= 0 ? fullName.slice(0, separator).trim() : "");
    if (singer) artists.push(singer);
  }
  return {
    id: `kugou:${id}`, name, artists,
    album: text(album.name) || text(raw.album_name),
    // Public list API: timelen/timelength are milliseconds; duration is seconds.
    durationMs: count(raw.timelen) || count(raw.timelength) || count(raw.duration) * 1000,
    cover: coverUrl(raw.cover) || coverUrl(object(raw.trans_param).union_cover),
  };
}

export async function getKugouPlaylist(input: string): Promise<Playlist> {
  const id = parseKugouPlaylistId(input);
  if (!id) throw new AppError("请输入酷狗音乐公开歌单链接或数字 ID。");
  const signal = AbortSignal.timeout(240000);
  const { gcid, info } = await resolveCollection(id, signal);
  const songs = new Map<string, Song>(), pages = new Set<string>();
  let detail: Json = {}, total = 0, offset = 0;
  for (let page = 0; page < MAX_SONGS; page++) {
    const result = await fetchPage(gcid, offset, signal);
    if (!page) detail = result.detail;
    total = Math.max(total, result.total);
    if (total > MAX_SONGS || offset + result.tracks.length > MAX_SONGS)
      throw new AppError("单次最多读取 10,000 首，请拆分歌单后重试。", 422);
    if (!result.tracks.length) break;
    const fingerprint = JSON.stringify(result.tracks.map((v) => object(v).hash || object(v).audio_id || null));
    if (pages.has(fingerprint)) throw new AppError("酷狗歌单分页重复，请稍后重新读取，避免遗漏歌曲。", 502);
    pages.add(fingerprint);
    for (const raw of result.tracks) {
      const song = toSong(raw);
      if (song && !songs.has(song.id)) songs.set(song.id, song);
    }
    offset += result.tracks.length;
    if (offset >= total) break;
  }
  total = Math.max(total, offset);
  return {
    provider: "kugou", id,
    name: text(detail.name) || text(info.name),
    creator: text(detail.list_create_username) || text(info.nickname) || "酷狗音乐用户",
    cover: coverUrl(detail.pic) || coverUrl(info.image),
    total, songs: [...songs.values()], missing: total - songs.size,
  };
}
