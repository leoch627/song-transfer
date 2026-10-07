import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SongShift：把歌单迁移到 Spotify",
  description:
    "把网易云音乐、QQ 音乐或酷狗的公开歌单迁移到 Spotify。逐首匹配，确认版本后写入你的账号。",
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
