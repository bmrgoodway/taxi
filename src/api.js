// 공유 택시(taxi) 데이터 계층 — Supabase(taxi 스키마) 읽기·쓰기
// 모든 권한은 DB 의 RLS 가 지킵니다. 여기서는 '무엇을 묻는지'만 정합니다.
import { supabase } from './supabase.js';

export const RIDE_FIELDS = 'id, kind, owner, owner_name, from_place, to_place, depart_at, seats, memo, status, pickup_at, live_share, created_at, updated_at';

const unwrap = ({ data, error }) => {
  if (error) throw new Error(error.message || '데이터를 읽지 못했어요.');
  return data;
};

/** 앞으로의 카풀 글 목록 (지난 3시간 것까지) */
export async function listRides({ mine = false, userId = null } = {}) {
  let q = supabase.from('rides')
    .select(RIDE_FIELDS)
    .neq('status', 'cancelled')
    .gte('depart_at', new Date(Date.now() - 3 * 3600 * 1000).toISOString())
    .order('depart_at', { ascending: true })
    .limit(80);
  if (mine && userId) q = q.eq('owner', userId);
  return unwrap(await q) ?? [];
}

/** 카풀 글 하나 + 참여자·차량·타임라인·연락처 */
export async function getRide(id, { signedIn = false } = {}) {
  const ride = unwrap(await supabase.from('rides').select(RIDE_FIELDS).eq('id', id).maybeSingle());
  if (!ride) return null;

  const membersP = supabase.from('ride_members')
    .select('id, user_id, name, role, status, created_at')
    .eq('ride_id', id).order('created_at', { ascending: true });
  const eventsP = supabase.from('ride_events')
    .select('id, kind, text, lat, lng, created_by, created_name, created_at')
    .eq('ride_id', id).order('created_at', { ascending: true }).limit(300);

  const [members, events] = await Promise.all([membersP, eventsP]);
  const out = {
    ride,
    members: unwrap(members) ?? [],
    events: unwrap(events) ?? [],
    driver: null,
    contacts: [],
  };
  // 로그인한 사람만 읽을 수 있는 것들 (손님에게는 권한이 없어 조회 자체를 건너뜁니다)
  if (signedIn) {
    const [driver, contacts] = await Promise.all([
      supabase.from('driver_info')
        .select('ride_id, driver, car_model, car_color, car_plate, pickup_memo, updated_at')
        .eq('ride_id', id).maybeSingle(),
      supabase.from('ride_contacts').select('user_id, phone').eq('ride_id', id),
    ]);
    out.driver = driver.error ? null : driver.data;
    out.contacts = contacts.error ? [] : contacts.data ?? [];
  }
  return out;
}

/** 새 카풀 글 — 글쓴이는 참여자로도 자동 등록됩니다 */
export async function createRide(payload, user) {
  const ride = unwrap(await supabase.from('rides').insert({
    kind: payload.kind,
    owner_name: payload.name,
    from_place: payload.from,
    to_place: payload.to,
    depart_at: payload.departAt,
    seats: payload.seats,
    memo: payload.memo,
  }).select(RIDE_FIELDS).single());

  const { error } = await supabase.from('ride_members').insert({
    ride_id: ride.id,
    user_id: user.id,
    name: payload.name,
    role: payload.kind === 'offer' ? 'driver' : 'passenger',
    status: 'accepted',
  });
  if (error) throw new Error(error.message);

  if (payload.phone) await saveContact(ride.id, user.id, payload.phone);
  return ride;
}

/** 운전자가 '태워드릴게요'로 수락 — 픽업 시간·차량 정보까지 함께 확정 */
export async function acceptAsDriver(rideId, info, user) {
  const { error: mErr } = await supabase.from('ride_members').upsert({
    ride_id: rideId,
    user_id: user.id,
    name: info.name,
    role: 'driver',
    status: 'accepted',
  }, { onConflict: 'ride_id,user_id' });
  if (mErr) throw new Error(mErr.message);

  const { error: dErr } = await supabase.from('driver_info').upsert({
    ride_id: rideId,
    driver: user.id,
    car_model: info.carModel,
    car_color: info.carColor,
    car_plate: info.carPlate,
    pickup_memo: info.pickupMemo,
  }, { onConflict: 'ride_id' });
  if (dErr) throw new Error(dErr.message);

  const { error: rErr } = await supabase.from('rides')
    .update({ status: 'matched', pickup_at: info.pickupAt })
    .eq('id', rideId);
  if (rErr) throw new Error(rErr.message);

  await postEvent(rideId, {
    kind: 'status',
    text: `${info.name}님이 태워드리기로 했어요 · ${info.pickupLabel} 출발 예정`,
  }, user);
}

/** 동승 신청 (자리 나눠 타기) */
export async function requestSeat(rideId, user, name) {
  const { error } = await supabase.from('ride_members').insert({
    ride_id: rideId, user_id: user.id, name, role: 'passenger', status: 'requested',
  });
  if (error) throw new Error(error.message);
  await postEvent(rideId, { kind: 'comment', text: `${name}님이 함께 타기를 신청했어요.` }, user, name);
}

/** 글쓴이가 동승 신청을 수락/거절 */
export async function decideMember(memberId, accept) {
  const { error } = await supabase.from('ride_members')
    .update({ status: accept ? 'accepted' : 'declined' })
    .eq('id', memberId);
  if (error) throw new Error(error.message);
}

/** 운행 상태 바꾸기 (matched / departed / arrived / cancelled) */
export async function setRideStatus(rideId, status, user, name, text) {
  const patch = { status };
  if (status === 'arrived' || status === 'cancelled') patch.live_share = false;
  const { error } = await supabase.from('rides').update(patch).eq('id', rideId);
  if (error) throw new Error(error.message);
  if (text) await postEvent(rideId, { kind: 'status', text }, user, name);
}

/** 타임라인에 한 줄 남기기 (상태 알림·위치·댓글) */
export async function postEvent(rideId, ev, user, name) {
  const { error } = await supabase.from('ride_events').insert({
    ride_id: rideId,
    kind: ev.kind,
    text: ev.text ?? '',
    lat: ev.lat ?? null,
    lng: ev.lng ?? null,
    created_by: user?.id ?? null,
    created_name: name ?? '',
  });
  if (error) throw new Error(error.message);
}

export async function setLiveShare(rideId, on) {
  const { error } = await supabase.from('rides').update({ live_share: on }).eq('id', rideId);
  if (error) throw new Error(error.message);
}

export async function saveContact(rideId, userId, phone) {
  const { error } = await supabase.from('ride_contacts')
    .upsert({ ride_id: rideId, user_id: userId, phone }, { onConflict: 'ride_id,user_id' });
  if (error) throw new Error(error.message);
}

export async function deleteContact(rideId, userId) {
  await supabase.from('ride_contacts').delete().eq('ride_id', rideId).eq('user_id', userId);
}
