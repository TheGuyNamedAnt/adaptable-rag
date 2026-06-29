import type { Metadata, Viewport } from "next";
import { Suspense } from "react";
import { RagAdminShell } from "@/components/RagAdminShell";
import { getShellOverview } from "@/lib/rag-admin-api";
import "./globals.css";

export const metadata: Metadata = {
  title: "Adaptable RAG Admin",
  description: "Operate and inspect an Adaptable RAG deployment"
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#FFFFFF"
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const shellOverview = await getShellOverview();

  return (
    <html lang="en">
      <body className="min-h-screen bg-background text-text-primary">
        <Suspense fallback={children}>
          <RagAdminShell initialOverview={shellOverview}>{children}</RagAdminShell>
        </Suspense>
      </body>
    </html>
  );
}
