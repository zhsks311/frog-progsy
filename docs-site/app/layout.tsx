import type { ReactNode } from "react";
import "./global.css";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="light" suppressHydrationWarning>
      <body className="flex min-h-screen flex-col">
        {children}
      </body>
    </html>
  );
}
