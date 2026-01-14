import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'DropHere - Simple Swarm Storage',
  description: 'Upload files to the swarm easily.',
  icons: {
    icon: '/favicon.svg',
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
