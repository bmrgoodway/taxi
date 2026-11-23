// taxi-fn 의 허브 도우미 — 메일(hub-mail) · AI(hub-ai) · 학교 그룹/명부(hub-directory) · 표준 /health
// BMR APPS 가 넣어 둔 시작 도우미입니다. 그대로 써도 되고, 필요하면 고쳐도 됩니다.
// 토큰(<PREFIX>MAIL_TOKEN · <PREFIX>AI_TOKEN)은 함수 비밀값에만 있고 브라우저로 나가지 않습니다.
//   발급·재발급: 허브 → 내 서비스 → 공유 택시 → 개발자 셀프서비스 → ✉️ 앱 메일 / 🤖 앱 AI
//
// 쓰는 법
//   import { sendHubMail, askHubAi, checkHubGroups, healthJson } from './lib/hub.ts';
//
//   return new Response(JSON.stringify(healthJson(true)), { headers: { 'Content-Type': 'application/json' } });
//   await sendHubMail({ to: 'teacher@bmrschool.org', subject: '안내', text: '본문' });
//   const { text } = await askHubAi({ prompt: '오늘 급식 소감을 한 줄로' });
//   const { member_of, asked } = await checkHubGroups('student@bmrschool.org', ['10학년', '정보동아리']);

const PREFIX = 'TAXI_';
const SLUG = 'taxi';
const SB_URL = (Deno.env.get('SUPABASE_URL') ?? '').replace(/\/+$/, '');
const ANON = Deno.env.get('SUPABASE_ANON_KEY') ?? '';

const secret = (name: string): string => Deno.env.get(PREFIX + name) ?? '';
const bearerOf = (req: Request): string => /^Bearer\s+(.+)$/i.exec(req.headers.get('Authorization') ?? '')?.[1]?.trim() ?? '';

/** 표준 /health 응답 — 허브 운영 현황(관리자 📊)이 이 모양을 읽어 앱 상태를 보여 줍니다 */
export type HealthJson = {
  ok: boolean;
  db: boolean;
  app: string;
  /** 메일 토큰이 있으면 true (hub-mail 로 보낼 수 있음) */
  mail_ready: boolean;
  /** AI 토큰이 있으면 true (hub-ai 로 부를 수 있음) */
  ai_hub: boolean;
  time: string;
};
export function healthJson(dbOk: boolean, extra: Partial<HealthJson> = {}): HealthJson {
  return {
    ok: dbOk, db: dbOk, app: SLUG,
    mail_ready: Boolean(secret('MAIL_TOKEN')),
    ai_hub: Boolean(secret('AI_TOKEN') || secret('MAIL_TOKEN')),
    time: new Date().toISOString(),
    ...extra,
  };
}

export type HubUser = { id: string; email: string | null };
/**
 * Authorization: Bearer <허브 로그인 토큰> 을 확인한다. 토큰이 없거나 잘못됐으면 null (손님).
 * 서버에 물어보므로 위조된 토큰은 통과하지 않는다. '로그인했다'만으로 권한을 주지 말고
 * 앱 멤버 표나 RLS(bmr.uid())로 누가 무엇을 볼지 정하세요.
 */
export async function checkHubAuth(req: Request): Promise<HubUser | null> {
  const token = bearerOf(req);
  if (!token || token.startsWith('sb_') || token.split('.').length !== 3) return null;
  try {
    const r = await fetch(`${SB_URL}/auth/v1/user`, {
      headers: { apikey: ANON, Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) { await r.body?.cancel(); return null; }
    const u = await r.json() as { id?: string; email?: string | null };
    return u?.id ? { id: u.id, email: u.email ?? null } : null;
  } catch { return null; }
}

type HubCallBody = Record<string, unknown>;
/** 허브 함수를 부른다. 앱 토큰(기본: <PREFIX>MAIL_TOKEN)으로 이 앱 신분만 증명한다 */
async function hubCall(fn: string, body: unknown, opts: { token?: string; timeoutMs?: number; tokenName?: string } = {}): Promise<{ status: number; body: HubCallBody }> {
  if (!SB_URL) throw new Error('SUPABASE_URL 이 없습니다.');
  const token = opts.token ?? secret('MAIL_TOKEN');
  if (!token) throw new Error(`허브 토큰(${PREFIX}${opts.tokenName ?? 'MAIL_TOKEN'})이 없습니다. 허브 → 개발자 셀프서비스에서 발급하세요.`);
  const r = await fetch(`${SB_URL}/functions/v1/${fn}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
  });
  const j = await r.json().catch(() => ({})) as HubCallBody;
  if (!r.ok) throw new Error(String(j?.error ?? `${fn} 호출 실패 (${r.status})`));
  return { status: r.status, body: j };
}

// ---------- 메일 (hub-mail) ----------
export type SendMailInput = {
  to: string | string[];
  subject: string;
  html?: string;
  text?: string;
  reply_to?: string | string[];
  /** 보내는 사람 표시 이름 (기본: 앱 이름). 주소는 허브가 정합니다 — bmrapps@bmrschool.org */
  from_name?: string;
};
/**
 * 앱 메일을 보낸다. 보내는 주소는 허브가 정하고(<slug> 신분으로 bmrapps@bmrschool.org), Resend·Gmail 키는 앱이 갖지 않는다.
 * 한도: 앱마다 24시간 500통·한 시간 100통·한 통에 받는 사람 50명, 학교 전체 24시간 1,500통·8,000명.
 */
export async function sendHubMail(input: SendMailInput): Promise<{ ok: true; id: string; from: string; to_count: number }> {
  const { body } = await hubCall('hub-mail', input, { tokenName: 'MAIL_TOKEN', timeoutMs: 30_000 });
  return { ok: true, id: String(body.id ?? ''), from: String(body.from ?? ''), to_count: Number(body.to_count ?? 0) };
}

// ---------- AI (hub-ai) ----------
export type AskAiMessage = { role: 'user' | 'assistant'; content: string };
export type AskAiInput = {
  /** 짧은 질문 하나. messages 를 쓰면 생략 가능 */
  prompt?: string;
  /** 대화를 이어갈 때 */
  messages?: AskAiMessage[];
  system?: string;
  /** '업체:모델' 또는 모델 이름 (예: gemini:gemini-2.5-flash). 비우면 허브 기본 모델 */
  model?: string;
  max_tokens?: number;
  temperature?: number;
  /** 'application/json' 이면 JSON 으로 답하게 한다 */
  response_mime_type?: string;
};
/**
 * 학교 공용 AI 게이트웨이(hub-ai)에 묻는다. 업체 키는 허브에만 있고, 앱은 이 앱 신분(<PREFIX>AI_TOKEN)만 증명한다.
 * 모델·한도는 허브 관리자 화면(🤖 앱 AI)에서 정합니다. 프롬프트·응답 본문은 기록되지 않는다.
 */
export async function askHubAi(input: AskAiInput): Promise<{
  text: string; model: string; provider: string;
  tokens: { input: number; output: number; total: number };
}> {
  const { body } = await hubCall('hub-ai', input, { tokenName: 'AI_TOKEN', timeoutMs: 95_000 });
  const usage = (body.usage && typeof body.usage === 'object' ? body.usage : {}) as Record<string, unknown>;
  return {
    text: String(body.text ?? ''),
    model: String(body.model ?? ''),
    provider: String(body.provider ?? ''),
    tokens: {
      input: Number(usage.input_tokens ?? 0),
      output: Number(usage.output_tokens ?? 0),
      total: Number(usage.total_tokens ?? 0),
    },
  };
}

// ---------- 학교 그룹·명부 (hub-directory) ----------
export type GroupAsk = { group: string; slug: string | null; member: boolean; role: 'leader' | 'member' | null };
export type GroupCheck = {
  ok: true;
  user_email: string;
  /** 소속 그룹 주소 이름들 (예: ['grade-10', 'info-club']) */
  member_of: string[];
  /** 그중 그룹장인 것 */
  leader_of: string[];
  roles: Record<string, 'leader' | 'member'>;
  /** 물어본 그룹별 결과 (groups 를 넘겼을 때) */
  asked: GroupAsk[];
  groups: { slug: string; name: string; kind: string; role: 'leader' | 'member' }[];
};
/**
 * '이 사람이 교직원·고등부·10학년·정보동아리인가'를 허브에 물어본다 (앱마다 명부를 다시 만들지 않게).
 * 명부는 관리자가 허브 → 👥 그룹·명부 에서 관리한다. 메일/AI 토큰 중 있는 것을 앱 신분으로 쓴다.
 */
export async function checkHubGroups(userEmail: string | null | undefined, groups: string[] = []): Promise<GroupCheck> {
  const token = secret('MAIL_TOKEN') || secret('AI_TOKEN');
  const { body } = await hubCall('hub-directory', { action: 'check', user_email: userEmail ?? '', groups }, { token });
  return {
    ok: true,
    user_email: String(body.user_email ?? ''),
    member_of: (Array.isArray(body.member_of) ? body.member_of : []).map(String),
    leader_of: (Array.isArray(body.leader_of) ? body.leader_of : []).map(String),
    roles: (body.roles && typeof body.roles === 'object' ? body.roles : {}) as Record<string, 'leader' | 'member'>,
    asked: (Array.isArray(body.asked) ? body.asked : []).map((x) => {
      const o = (x ?? {}) as Record<string, unknown>;
      return {
        group: String(o.group ?? ''), slug: o.slug == null ? null : String(o.slug),
        member: o.member === true, role: o.role === 'leader' ? 'leader' as const : o.role === 'member' ? 'member' as const : null,
      };
    }),
    groups: (Array.isArray(body.groups) ? body.groups : []).map((x) => {
      const o = (x ?? {}) as Record<string, unknown>;
      return { slug: String(o.slug ?? ''), name: String(o.name ?? ''), kind: String(o.kind ?? ''), role: o.role === 'leader' ? 'leader' as const : 'member' as const };
    }),
  };
}

export type GroupMembers = {
  group: { id: number; slug: string; name: string; kind: string; members: number };
  members: { email: string; role: 'leader' | 'member' }[];
  truncated: boolean;
};
/** 그룹 구성원(메일) 목록 — 앱 서버 함수에서만. 사람 목록은 이름 없이 메일만 돌려준다 (최대 1,000명) */
export async function hubGroupMembers(group: string): Promise<GroupMembers> {
  const token = secret('MAIL_TOKEN') || secret('AI_TOKEN');
  const { body } = await hubCall('hub-directory', { action: 'members', group }, { token });
  const g = (body.group && typeof body.group === 'object' ? body.group : {}) as Record<string, unknown>;
  return {
    group: { id: Number(g.id ?? 0), slug: String(g.slug ?? ''), name: String(g.name ?? ''), kind: String(g.kind ?? ''), members: Number(g.members ?? 0) },
    members: (Array.isArray(body.members) ? body.members : []).map((x) => {
      const o = (x ?? {}) as Record<string, unknown>;
      return { email: String(o.email ?? ''), role: o.role === 'leader' ? 'leader' as const : 'member' as const };
    }),
    truncated: body.truncated === true,
  };
}

/** 그룹 공용 파일 버킷 이름 — 브라우저에서 supabase.storage.from('bmr-files') 로 쓰는 것과 같은 곳 */
export const FILES_BUCKET = 'bmr-files';
