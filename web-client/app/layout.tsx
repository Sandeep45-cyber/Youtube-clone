import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Youtube Clone',
  description: 'Video upload and playback demo',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
