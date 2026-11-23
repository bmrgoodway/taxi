-- 별무리 카풀 — 출발지·도착지 좌표 저장 (GPS·지도 핀으로 고른 위치)
-- 글을 올릴 때 '📍 내 위치(GPS)'나 '🗺️ 지도에서 고르기'로 정한 좌표를 함께 남깁니다.
-- 좌표가 없는 예전 글은 앱이 거점 이름(별무리학교·대전역 등)으로 대략 위치를 찾아 지도에 보여 줍니다.
-- 좌표는 공개 정보입니다(글 내용과 같은 수준). 개인 위치를 따로 모으지는 않습니다.

alter table taxi.rides
  add column if not exists origin_lat double precision,
  add column if not exists origin_lng double precision,
  add column if not exists dest_lat   double precision,
  add column if not exists dest_lng   double precision;

-- 위경도 범위를 벗어난 값(지도 핀 실수·잘못된 입력)은 저장하지 않습니다.
alter table taxi.rides drop constraint if exists rides_coords_range;
alter table taxi.rides add constraint rides_coords_range check (
  (origin_lat is null or (origin_lat between -90 and 90)) and
  (origin_lng is null or (origin_lng between -180 and 180)) and
  (dest_lat   is null or (dest_lat   between -90 and 90)) and
  (dest_lng   is null or (dest_lng   between -180 and 180))
);

comment on column taxi.rides.origin_lat is '출발지 위도 (GPS·지도 핀, 없으면 null)';
comment on column taxi.rides.origin_lng is '출발지 경도 (GPS·지도 핀, 없으면 null)';
comment on column taxi.rides.dest_lat   is '도착지 위도 (GPS·지도 핀, 없으면 null)';
comment on column taxi.rides.dest_lng   is '도착지 경도 (GPS·지도 핀, 없으면 null)';

-- 이미 만들어 둔 표에도 표 권한은 그대로입니다(새 칸은 select/insert/update 권한에 포함).
