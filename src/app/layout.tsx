import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "DeltaG TestLab Next.js",
  description: "DeltaG test panelinin Next.js surumu",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="tr">
      <body>{children}</body>
    </html>
  );
}
