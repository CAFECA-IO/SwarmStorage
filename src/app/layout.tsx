import type { Metadata, Viewport } from 'next';
import ViewportTracker from '@/components/viewport_tracker';
import './globals.css';

export const metadata: Metadata = {
  title: 'DropHere - Simple Swarm Storage',
  description: 'Upload files to the swarm easily.',
  icons: {
    icon: '/favicon.svg',
  },
};

// Info: (20261106 - Luphia) Android Chrome 開啟鍵盤時縮小版面 (dvh 隨之改變)；iOS 由 ViewportTracker 處理
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  interactiveWidget: 'resizes-content',
  themeColor: '#020617',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <ViewportTracker />
        {children}
      </body>
    </html>
  );
}
