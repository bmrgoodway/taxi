// taxi-fn — 공유 택시 의 서버 함수 (시작 예시)
// 이 파일을 고쳐 main 에 올리면(push), 이 앱의 '서버 함수 자동 배포'가 켜져 있을 때 검사 뒤 자동으로 배포됩니다.
// 꺼져 있으면 허브 → 내 서비스 → 앱 정보 → 개발자 셀프서비스에서 켜 달라고 요청하세요 (관리자가 1클릭 승인).
// 비밀값(TAXI_…)은 같은 셀프서비스에서 직접 넣고, 로그도 그곳에서 봅니다.
//
// 이 예시가 보여 주는 것
//  1) 부른 사람 확인: 로그인한 사용자의 토큰이 있으면 Supabase Auth 로 확인 (없으면 손님)
//  2) 앱 전용 비밀값: TAXI_* 이름의 함수 비밀값만 씁니다 (예: TAXI_EXAMPLE_KEY)
//  3) 이 앱 스키마(taxi) 조회: 함수 전용 DB 역할(taxi_fn, 개발자 역할 taxi_dev 의 권한을 물려받음)로 접속
//     → 다른 앱 스키마·허브 표에는 권한이 없고, 개발자가 자기 비밀번호를 바꿔도 함수는 그대로 동작합니다
//
// 주소: https://wjvqavianqceeyyxonfg.supabase.co/functions/v1/taxi-fn/<경로>
//   GET  /health            DB 연결 확인
//   GET  /hello             부른 사람(user)과 비밀값 설정 여부
//   GET  /documents?collection=notice   documents 표에서 최근 20개
//   POST /documents         (로그인 필요) { "collection": "notice", "data": { … } } 저장
import postgres from 'npm:postgres@3.4.5';
import { checkHubAuth, healthJson, type HubUser } from './lib/hub.ts';

const FN = 'taxi-fn';
const SCHEMA = 'taxi';
const PREFIX = 'TAXI_'; // 이 앱이 쓸 수 있는 비밀값 이름 앞부분
const ORIGINS = ['https://bmrgoodway.github.io', 'http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:4173', 'http://127.0.0.1:4173'];

const secret = (name: string) => Deno.env.get(PREFIX + name) ?? '';
const DB_URL = secret('DB_URL');
// 서버리스라 연결을 적게: 최대 2개, 20초 쉬면 닫음. 트랜잭션 풀러(6543)라 prepare 끔
const db = DB_URL ? postgres(DB_URL, { prepare: false, max: 2, idle_timeout: 20, connect_timeout: 10, onnotice: () => {} }) : null;

function cors(req: Request): Record<string, string> {
  const o = req.headers.get('Origin') ?? '';
  return {
    'Access-Control-Allow-Origin': ORIGINS.includes(o) ? o : ORIGINS[0],
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Max-Age': '600', Vary: 'Origin',
  };
}
const json = (req: Request, status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors(req), 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });

type User = HubUser | null;
/** Authorization: Bearer <허브 로그인 토큰> 이면 확인한다 (lib/hub.ts 의 checkHubAuth). 없거나 잘못된 토큰이면 손님(null). */
const getUser = (req: Request): Promise<User> => checkHubAuth(req);
const route = (req: Request) => {
  const p = new URL(req.url).pathname; const i = p.indexOf('/' + FN);
  return (i < 0 ? '/' : p.slice(i + FN.length + 1)).replace(/\/+$/, '') || '/';
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req) });
  const o = req.headers.get('Origin');
  if (o && !ORIGINS.includes(o)) return json(req, 403, { error: '허용되지 않은 출처입니다.' });
  const path = route(req);
  try {
    if (path === '/health') {
      // 표준 모양(lib/hub.ts 의 healthJson): 허브 운영 현황이 이 응답을 읽어 앱 상태를 보여 줍니다
      if (!db) return json(req, 503, healthJson(false));
      try { await db`select 1`; } catch { return json(req, 503, healthJson(false)); }
      return json(req, 200, healthJson(true));
    }
    const user = await getUser(req);
    if (path === '/hello') {
      return json(req, 200, { app: SCHEMA, user, example_secret_set: Boolean(secret('EXAMPLE_KEY')), time: new Date().toISOString() });
    }
    if (!db) return json(req, 503, { error: '서버 설정이 아직 끝나지 않았습니다 (DB 연결 정보 없음).' });
    if (path === '/documents' && req.method === 'GET') {
      const c = new URL(req.url).searchParams.get('collection') ?? '';
      if (!c || c.length > 100) return json(req, 400, { error: 'collection 을 적어 주세요.' });
      // 함수는 표 주인 역할로 접속하므로 RLS 를 거치지 않는다 → 보여 줄 범위는 여기 코드에서 직접 정한다
      const rows = await db`select id, collection, data, owner, created_at from ${db(SCHEMA)}.documents
        where collection = ${c} order by created_at desc limit 20`;
      return json(req, 200, { documents: rows });
    }
    if (path === '/documents' && req.method === 'POST') {
      if (!user) return json(req, 401, { error: '로그인이 필요합니다.' });
      const t = await req.text();
      if (t.length > 16384) return json(req, 413, { error: '요청이 너무 큽니다.' });
      let b: { collection?: unknown; data?: unknown };
      try { b = JSON.parse(t); } catch { return json(req, 400, { error: 'JSON 형식이 아닙니다.' }); }
      if (typeof b.collection !== 'string' || !b.collection || b.collection.length > 100) return json(req, 400, { error: 'collection 형식이 올바르지 않습니다.' });
      if (typeof b.data !== 'object' || b.data === null || Array.isArray(b.data)) return json(req, 400, { error: 'data 는 JSON 객체여야 합니다.' });
      const [row] = await db`insert into ${db(SCHEMA)}.documents (collection, data, owner)
        values (${b.collection}, ${db.json(b.data as Record<string, never>)}, ${user.id}) returning id, collection, data, owner, created_at`;
      return json(req, 201, row);
    }
    return json(req, 404, { error: '없는 경로입니다.' });
  } catch (e) {
    console.error(FN, (e as { code?: string })?.code ?? '', (e as Error)?.message ?? e);
    return json(req, 500, { error: '서버 오류가 났습니다.', code: (e as { code?: string })?.code });
  }
});
