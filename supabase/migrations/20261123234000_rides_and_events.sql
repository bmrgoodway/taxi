-- 별무리 카풀(taxi) — 카풀 글, 참여자, 차량 정보, 운행 타임라인(상태·위치·댓글), 연락처
-- 규칙: 누구나 글 읽기(공유 링크), 로그인한 사람이 글 쓰기, 참여자만 차량 정보·댓글·연락처.
-- auth 스키마 권한이 없는 개발자 계정을 위해 auth.uid() 대신 bmr.uid() 를 씁니다.

-- 1) 카풀 글 ---------------------------------------------------------------
create table if not exists taxi.rides (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null default 'need' check (kind in ('need', 'offer')),
  owner       uuid not null default bmr.uid(),
  owner_name  text not null default '',
  from_place  text not null,
  to_place    text not null,
  depart_at   timestamptz not null,
  seats       integer not null default 1 check (seats between 1 and 8),
  memo        text not null default '',
  status      text not null default 'open' check (status in ('open', 'matched', 'departed', 'arrived', 'cancelled')),
  pickup_at   timestamptz,
  live_share  boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists rides_depart_idx on taxi.rides (depart_at desc);
create index if not exists rides_status_idx on taxi.rides (status);

-- 2) 참여자 (글쓴이·운전자·동승자) -----------------------------------------
create table if not exists taxi.ride_members (
  id          bigint generated always as identity primary key,
  ride_id     uuid not null references taxi.rides (id) on delete cascade,
  user_id     uuid not null,
  name        text not null default '',
  role        text not null check (role in ('driver', 'passenger')),
  status      text not null default 'accepted' check (status in ('requested', 'accepted', 'declined', 'left')),
  created_at  timestamptz not null default now(),
  unique (ride_id, user_id)
);
create index if not exists ride_members_ride_idx on taxi.ride_members (ride_id);

-- 3) 차량 정보 (운전자만 쓰고, 참여자만 봄) --------------------------------
create table if not exists taxi.driver_info (
  ride_id      uuid primary key references taxi.rides (id) on delete cascade,
  driver       uuid not null,
  car_model    text not null default '',
  car_color    text not null default '',
  car_plate    text not null default '',
  pickup_memo  text not null default '',
  updated_at   timestamptz not null default now()
);

-- 4) 운행 타임라인: 상태 알림·위치·짧은 댓글 -------------------------------
create table if not exists taxi.ride_events (
  id            bigint generated always as identity primary key,
  ride_id       uuid not null references taxi.rides (id) on delete cascade,
  kind          text not null check (kind in ('comment', 'status', 'location')),
  text          text not null default '',
  lat           double precision,
  lng           double precision,
  created_by    uuid,
  created_name  text not null default '',
  created_at    timestamptz not null default now()
);
create index if not exists ride_events_ride_idx on taxi.ride_events (ride_id, created_at desc);

-- 5) 연락처 (참여자끼리만) --------------------------------------------------
create table if not exists taxi.ride_contacts (
  ride_id  uuid not null references taxi.rides (id) on delete cascade,
  user_id  uuid not null,
  phone    text not null,
  primary key (ride_id, user_id)
);

-- 6) 도우미 함수 (security definer: RLS 와 무관하게 '나'의 참여 여부만 확인) --
create or replace function taxi.is_member(p_ride uuid) returns boolean
language sql stable security definer set search_path = '' as $fn$
  select exists (
    select 1 from taxi.ride_members m
    where m.ride_id = p_ride and m.user_id = bmr.uid() and m.status = 'accepted'
  ) or exists (
    select 1 from taxi.rides r where r.id = p_ride and r.owner = bmr.uid()
  );
$fn$;

create or replace function taxi.is_driver(p_ride uuid) returns boolean
language sql stable security definer set search_path = '' as $fn$
  select exists (
    select 1 from taxi.ride_members m
    where m.ride_id = p_ride and m.user_id = bmr.uid() and m.role = 'driver' and m.status = 'accepted'
  );
$fn$;

-- 7) 수정 시각 자동 갱신 ---------------------------------------------------
create or replace function taxi.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $fn$
begin new.updated_at = now(); return new; end;
$fn$;
drop trigger if exists rides_touch on taxi.rides;
create trigger rides_touch before update on taxi.rides
  for each row execute function taxi.touch_updated_at();

-- 8) RLS ------------------------------------------------------------------
alter table taxi.rides        enable row level security;
alter table taxi.ride_members enable row level security;
alter table taxi.driver_info  enable row level security;
alter table taxi.ride_events  enable row level security;
alter table taxi.ride_contacts enable row level security;

-- 8-1) 카풀 글: 누구나 읽기(공유 링크) · 로그인하면 쓰기 · 글쓴이·운전자가 고치기
drop policy if exists rides_read on taxi.rides;
create policy rides_read on taxi.rides for select to anon, authenticated using (true);

drop policy if exists rides_insert on taxi.rides;
create policy rides_insert on taxi.rides for insert to authenticated
  with check (owner = (select bmr.uid()));

drop policy if exists rides_update on taxi.rides;
create policy rides_update on taxi.rides for update to authenticated
  using (owner = (select bmr.uid()) or (select taxi.is_driver(id)))
  with check (true);

drop policy if exists rides_delete on taxi.rides;
create policy rides_delete on taxi.rides for delete to authenticated
  using (owner = (select bmr.uid()));

-- 8-2) 참여자: 확정된 사람은 누구나 봄 · 신청 내역은 당사자와 글쓴이만
drop policy if exists members_read on taxi.ride_members;
create policy members_read on taxi.ride_members for select to anon, authenticated
  using (status = 'accepted' or user_id = (select bmr.uid()) or (select taxi.is_member(ride_id)));

drop policy if exists members_insert on taxi.ride_members;
create policy members_insert on taxi.ride_members for insert to authenticated
  with check (
    user_id = (select bmr.uid())
    and exists (select 1 from taxi.rides r where r.id = ride_id and r.status = 'open')
  );

drop policy if exists members_update on taxi.ride_members;
create policy members_update on taxi.ride_members for update to authenticated
  using (user_id = (select bmr.uid()) or (select taxi.is_member(ride_id)))
  with check (true);

drop policy if exists members_delete on taxi.ride_members;
create policy members_delete on taxi.ride_members for delete to authenticated
  using (
    user_id = (select bmr.uid())
    or exists (select 1 from taxi.rides r where r.id = ride_id and r.owner = (select bmr.uid()))
  );

-- 8-3) 차량 정보: 참여자만 읽기, 운전자만 쓰기
drop policy if exists driver_read on taxi.driver_info;
create policy driver_read on taxi.driver_info for select to authenticated
  using ((select taxi.is_member(ride_id)));

drop policy if exists driver_insert on taxi.driver_info;
create policy driver_insert on taxi.driver_info for insert to authenticated
  with check (driver = (select bmr.uid()) and (select taxi.is_member(ride_id)));

drop policy if exists driver_update on taxi.driver_info;
create policy driver_update on taxi.driver_info for update to authenticated
  using (driver = (select bmr.uid())) with check (driver = (select bmr.uid()));

drop policy if exists driver_delete on taxi.driver_info;
create policy driver_delete on taxi.driver_info for delete to authenticated
  using (driver = (select bmr.uid()));

-- 8-4) 타임라인: 상태·위치는 공개, 댓글은 참여자만. 위치는 운전자만 올림
drop policy if exists events_read on taxi.ride_events;
create policy events_read on taxi.ride_events for select to anon, authenticated
  using (kind <> 'comment' or (select taxi.is_member(ride_id)));

drop policy if exists events_insert on taxi.ride_events;
create policy events_insert on taxi.ride_events for insert to authenticated
  with check (
    created_by = (select bmr.uid())
    and (select taxi.is_member(ride_id))
    and (kind <> 'location' or (select taxi.is_driver(ride_id)))
  );

drop policy if exists events_delete on taxi.ride_events;
create policy events_delete on taxi.ride_events for delete to authenticated
  using (
    created_by = (select bmr.uid())
    or exists (select 1 from taxi.rides r where r.id = ride_id and r.owner = (select bmr.uid()))
  );

-- 8-5) 연락처: 참여자만 읽기, 내 것만 쓰기
drop policy if exists contacts_read on taxi.ride_contacts;
create policy contacts_read on taxi.ride_contacts for select to authenticated
  using ((select taxi.is_member(ride_id)));

drop policy if exists contacts_insert on taxi.ride_contacts;
create policy contacts_insert on taxi.ride_contacts for insert to authenticated
  with check (user_id = (select bmr.uid()));

drop policy if exists contacts_update on taxi.ride_contacts;
create policy contacts_update on taxi.ride_contacts for update to authenticated
  using (user_id = (select bmr.uid())) with check (user_id = (select bmr.uid()));

-- 9) 표 권한 (기본은 읽기만이라 쓰기는 직접 줍니다) ------------------------
grant select on taxi.rides, taxi.ride_members, taxi.ride_events to anon;
grant select, insert, update, delete on taxi.rides, taxi.ride_members, taxi.ride_events to authenticated;
grant select, insert, update, delete on taxi.driver_info, taxi.ride_contacts to authenticated;
grant usage on all sequences in schema taxi to authenticated;

-- 10) 실시간(선택): 프로젝트에 supabase_realtime 발행이 있으면 이 표들을 더합니다
do $do$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table taxi.rides, taxi.ride_members, taxi.ride_events;
    exception when duplicate_object then null;
    end;
  end if;
end;
$do$;
