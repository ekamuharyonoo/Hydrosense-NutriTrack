import { Plus_Jakarta_Sans } from 'next/font/google';
import './globals.css';
import { PwaRegister } from '@/components/Pwa';

const jakarta = Plus_Jakarta_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  display: 'swap',
  variable: '--font-jakarta',
});

export const metadata = {
  title: 'HydroSense Lite',
  description: 'Dashboard pemantauan nutrisi hidroponik kebun melon',
  applicationName: 'HydroSense Lite',
  icons: { icon: '/icons/favicon-32.png', apple: '/icons/apple-touch-icon.png' },
  appleWebApp: { capable: true, title: 'HS Lite', statusBarStyle: 'black-translucent' },
  formatDetection: { telephone: false },
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#043324',
};

export default function RootLayout({ children }) {
  return (
    <html lang="id" className={jakarta.variable}>
      <body>{children}<PwaRegister /></body>
    </html>
  );
}
