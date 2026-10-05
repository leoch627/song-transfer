import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SongShift 移调 · 让喜欢的音乐，自由流动",
  description:
    "将网易云音乐或 QQ 音乐歌单迁移到 Spotify。逐首匹配、确认版本，让熟悉的旋律在新的地方继续。",
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
