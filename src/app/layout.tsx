import type { Metadata, Viewport } from "next";
import { Noto_Sans_JP, Noto_Sans_SC } from "next/font/google";
import "./globals.css";

// Noto Sans JP for Latin and Japanese, Noto Sans SC for Chinese through :lang(zh-Hans).
// Two weights only (ux-spec 6 item 3). The CJK glyph ranges load on demand by unicode-range.
const notoJp = Noto_Sans_JP({
  variable: "--font-noto-jp",
  subsets: ["latin"],
  weight: ["400", "700"],
  display: "swap",
});

const notoSc = Noto_Sans_SC({
  variable: "--font-noto-sc",
  subsets: ["latin"],
  weight: ["400", "700"],
  display: "swap",
  preload: false,
});

export const metadata: Metadata = {
  title: "Catch Up",
  description:
    "Missed something? Press once. Catch Up keeps the last 2 minutes of sound in memory, and nothing leaves your device until you press.",
  applicationName: "Catch Up",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#FAFAF7" },
    { media: "(prefers-color-scheme: dark)", color: "#121316" },
  ],
  colorScheme: "light dark",
  viewportFit: "cover",
};

// Applies the saved text size before the first paint, so 125% and 150% never flash at 100%.
// Mirrors applyTextSize in src/lib/client/settings.ts.
const TEXT_SIZE_SCRIPT =
  'try{var s=JSON.parse(localStorage.getItem("catchup.settings.v1")||"null");var t=s&&s.textSize;if(t===125||t===150)document.documentElement.dataset.textSize=String(t)}catch(e){}';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${notoJp.variable} ${notoSc.variable}`} suppressHydrationWarning>
      <body>
        <script dangerouslySetInnerHTML={{ __html: TEXT_SIZE_SCRIPT }} />
        {children}
      </body>
    </html>
  );
}
