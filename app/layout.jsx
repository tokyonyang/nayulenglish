import './globals.css';

export const metadata = {
  title: 'hohobook',
  description: '아이와 영어 그림책을 읽고 대화하는 개인 학습 도구',
  applicationName: 'hohobook',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'hohobook',
  },
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#e8a33d',
};

export default function RootLayout({ children }) {
  return (
    <html lang="ko">
      <head>
    <meta
    name="google-site-verification"
    content="bwgkIr4KSBT6HHrOKdXvVcJOlI4tj2T3jmNS-CQR-40"
  />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Gowun+Dodum&family=Fraunces:opsz,wght@9..144,400;9..144,600;9..144,700&display=swap"
          rel="stylesheet"
        />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
      </head>
      <body>
        <main>{children}</main>
        <script
          dangerouslySetInnerHTML={{
            __html: `if ('serviceWorker' in navigator) { window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}); }); }`,
          }}
        />
      </body>
    </html>
  );
}
