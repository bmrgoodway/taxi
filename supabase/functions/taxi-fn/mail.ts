// taxi-fn 메일 도우미 — 실제 코드는 같은 폴더의 lib/hub.ts 에 있습니다 (예전 이름 sendMail 그대로 씁니다).
// 보내는 주소는 허브가 정합니다: "공유 택시" <bmrapps@bmrschool.org>
// 한도: 앱마다 24시간 500통 · 한 시간 100통 · 한 통에 받는 사람 50명 (학교 전체 24시간 1,500통 · 8,000명)
// 토큰을 브라우저에 노출하지 마세요. 서버 함수 안에서만 호출합니다.
export { sendHubMail as sendMail, type SendMailInput } from './lib/hub.ts';
