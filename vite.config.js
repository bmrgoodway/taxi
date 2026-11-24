import { defineConfig, loadEnv } from 'vite';
import { copyFileSync } from 'node:fs';
import { resolve } from 'node:path';

// 이 앱 주소: https://bmrgoodway.github.io/taxi/  (GitHub Pages)
const BASE = '/taxi/';

// GitHub Pages 는 응답 헤더를 못 바꾸므로 보안 정책(CSP)을 meta 태그로 넣는다 (빌드할 때만).
// 다른 외부 주소(이미지, API 등)를 쓰려면 아래 목록에 그 주소를 더하세요.
const cspFor = (SB) => [
  "default-src 'self'",
  // 카카오맵 JavaScript SDK(dapi.kakao.com) 와 SDK 가 불러오는 조각(t1.daumcdn.net 등)
  "script-src 'self' https://dapi.kakao.com https://*.daumcdn.net https://*.kakao.com https://*.kakaocdn.net",
  // 카카오맵 SDK 가 지도 조각·오버레이 위치를 style 속성으로 잡기 때문에 'unsafe-inline' 이 필요합니다.
  // (스크립트는 아래처럼 출처를 좁게 제한하고, 화면에 넣는 값은 모두 esc() 로 걸러 씁니다)
  "style-src 'self' 'unsafe-inline' https://*.daumcdn.net",
  // 지도 타일·마커: 카카오(daumcdn·kakao) / 대체 지도(openstreetmap) / 앱 이미지
  `img-src 'self' data: blob: ${SB} https://*.tile.openstreetmap.org https://*.daumcdn.net https://*.daum.net https://*.kakao.com https://*.kakaocdn.net`,
  "font-src 'self' data: https://*.daumcdn.net",
  // 장소 검색·주소 변환은 카카오(dapi.kakao.com), 대체 주소 찾기는 nominatim
  `connect-src 'self' ${SB} ${SB.replace('https://', 'wss://')} https://nominatim.openstreetmap.org https://dapi.kakao.com https://*.daumcdn.net https://*.daum.net https://*.kakao.com https://*.kakaocdn.net`,
  "base-uri 'self'", "form-action 'self'", "object-src 'none'", "frame-src 'none'",
].join('; ');
const csp = (CSP) => ({
  name: 'csp-meta', apply: 'build',
  transformIndexHtml: (html) => html.replace('<meta charset="utf-8">', `<meta charset="utf-8">\n<meta http-equiv="Content-Security-Policy" content="${CSP}">\n<meta name="referrer" content="strict-origin-when-cross-origin">`),
});
// 한 페이지 앱(SPA): 없는 경로로 들어오면 GitHub Pages 가 404.html 을 주므로 index.html 을 복사해 둔다
const spa404 = () => ({ name: 'spa-404', apply: 'build', closeBundle() { copyFileSync(resolve('dist/index.html'), resolve('dist/404.html')); } });

export default defineConfig(({ mode, command }) => {
  const env = { ...loadEnv(mode, process.cwd(), 'VITE_'), ...process.env };
  const SB = String(env.VITE_SUPABASE_URL || 'https://wjvqavianqceeyyxonfg.supabase.co').replace(/\/$/, '');
  if (command === 'build' && !/^https:\/\/[a-z0-9]+\.supabase\.co$/.test(SB)) throw new Error('VITE_SUPABASE_URL 형식이 다릅니다');
  return {
    base: BASE,
    plugins: [csp(cspFor(SB)), spa404()],
    build: { target: 'es2022', sourcemap: false },
    server: { port: 5173 }, preview: { port: 4173 },
  };
});
