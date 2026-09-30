export default function manifest() {
  return {
    name: 'hohobook',
    short_name: 'hohobook',
    description: '아이와 영어 그림책을 읽고 대화하는 개인 학습 도구',
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
