export default function manifest() {
  return {
    name: '나율이의 영어책방',
    short_name: '영어책방',
    description: '책 한 권으로, 하루 10분 영어 말하기',
    start_url: '/',
    display: 'standalone',
    background_color: '#faf5ea',
    theme_color: '#e8a33d',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
