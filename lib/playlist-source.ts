import type { PlaylistProvider } from "./types";

export const providerNames: Record<PlaylistProvider, string> = {
  netease: "网易云音乐",
  qq: "QQ 音乐",
};

export function playlistShareUrl(input: string): URL | null {
  const embedded = input.trim().match(/https?:\/\/[^\s「」<>"“”]+/i)?.[0];
  if (!embedded) return null;
  try {
    const url = new URL(embedded);
    if (url.username || url.password || url.port) return null;
    return url;
  } catch {
    return null;
  }
}

function validQqId(id: string | null | undefined): string | null {
  return id && /^[1-9]\d{0,15}$/.test(id) && Number.isSafeInteger(Number(id))
    ? id
    : null;
}

export function parseQqPlaylistId(input: string): string | null {
  const numeric = validQqId(input.trim());
  if (numeric) return numeric;
  const url = playlistShareUrl(input);
  if (
    !url ||
    !["y.qq.com", "i.y.qq.com", "m.y.qq.com", "c.y.qq.com"].includes(
      url.hostname,
    )
  )
    return null;
  const route = url.pathname + url.hash.split("?")[0];
  const pathId = route.match(
    /\/(?:playlist|playsquare)\/(\d+)(?:\.html)?\/?$/,
  )?.[1];
  if (pathId) return validQqId(pathId);
  if (
    !/(?:\/(?:playlist|playsquare)(?:\.html)?\/?$|\/taoge(?:\/index)?\.html$|\/taoge\/index\/?$)/.test(
      route,
    )
  )
    return null;
  const hashParams = new URLSearchParams(url.hash.split("?")[1]);
  return validQqId(
    url.searchParams.get("id") ||
      url.searchParams.get("disstid") ||
      url.searchParams.get("dissid") ||
      hashParams.get("id") ||
      hashParams.get("disstid"),
  );
}

export function qqShortShareUrl(input: string): URL | null {
  const url = playlistShareUrl(input);
  if (
    url?.hostname !== "c6.y.qq.com" ||
    url.pathname !== "/base/fcgi-bin/u" ||
    !url.searchParams.get("__")
  )
    return null;
  url.protocol = "https:";
  return url;
}

// Bare IDs use the chosen provider; full links can select their own provider.
export function detectPlaylistProvider(input: string): PlaylistProvider | null {
  const url = playlistShareUrl(input);
  if (!url) return null;
  if (parseQqPlaylistId(input) || qqShortShareUrl(input)) return "qq";
  if (["music.163.com", "y.music.163.com"].includes(url.hostname))
    return "netease";
  return null;
}
