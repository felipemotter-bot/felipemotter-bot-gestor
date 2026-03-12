import type { Metadata, Viewport } from "next";
import { Manrope, Sora } from "next/font/google";
import Script from "next/script";
import "./globals.css";

const bodyFont = Manrope({
  variable: "--font-body",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

const headingFont = Sora({
  variable: "--font-heading",
  subsets: ["latin"],
  weight: ["500", "600", "700"],
});

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
  themeColor: "#1d4ed8",
};

export const metadata: Metadata = {
  title: "Gestor",
  description: "Controle financeiro familiar com Supabase e automações.",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Gestor",
  },
  icons: {
    apple: "/icons/apple-touch-icon.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="pt-BR">
      <body className={`${bodyFont.variable} ${headingFont.variable} antialiased`}>
        {children}
        <Script id="sw-register" strategy="afterInteractive">
          {`if("serviceWorker" in navigator){navigator.serviceWorker.register("/sw.js")}`}
        </Script>
      </body>
    </html>
  );
}
