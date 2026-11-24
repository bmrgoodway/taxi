// 카카오맵(JavaScript SDK) 불러오기 + 장소 검색·주소 변환 도우미
// - 키는 웹 클라이언트용 공개 JavaScript 키입니다(카카오 디벨로퍼스 > 앱 키 > JavaScript 키).
//   빌드에서 VITE_KAKAO_MAP_APP_KEY 로 바꿀 수 있고, 없으면 이 앱의 키를 씁니다.
// - 카카오맵이 막히면(도메인 미등록·키 오류 등) null 을 돌려주고, 화면은 Leaflet 으로 안전하게 대체합니다.

const DEFAULT_KEY = 'dc5ff48d4c42c7a79f83012144350a5a';
export const KAKAO_KEY = import.meta.env.VITE_KAKAO_MAP_APP_KEY || DEFAULT_KEY;

let boot = null;

/** kakao.maps 준비가 끝난 window.kakao 를 돌려줍니다. 실패하면 Error */
export function loadKakao() {
  if (boot) return boot;
  boot = new Promise((resolve, reject) => {
    if (window.kakao?.maps?.load) return resolve(window.kakao);
    const s = document.createElement('script'); // bmr-allow: 카카오맵 SDK(공개 JavaScript 키) 동적 로드
    s.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${encodeURIComponent(KAKAO_KEY)}&libraries=services&autoload=false`;
    s.async = true;
    let done = false;
    const fail = (why) => {
      if (done) return;
      done = true;
      reject(new Error(why));
    };
    const timer = setTimeout(() => fail('카카오맵 응답이 없어요'), 9000);
    s.onload = () => {
      if (!window.kakao?.maps?.load) return fail('카카오맵을 읽지 못했어요');
      try {
        window.kakao.maps.load(() => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(window.kakao);
        });
      } catch (e) {
        fail(e?.message || '카카오맵을 시작하지 못했어요');
      }
    };
    s.onerror = () => fail('카카오맵을 불러오지 못했어요 (도메인·키 설정 확인 필요)');
    document.head.appendChild(s);
  });
  // 실패한 시도는 기억하지 않습니다 (도메인 설정을 고친 뒤 새로고침하면 다시 시도)
  boot.catch(() => { boot = null; });
  return boot;
}

/** 카카오맵을 못 쓰면 null — 화면은 Leaflet 으로 대체합니다 */
export async function kakaoOrNull() {
  try { return await loadKakao(); } catch { return null; }
}

const S = (kakao) => kakao?.maps?.services?.Status || {};

/** 장소 이름으로 검색 — [{ name, address, distance, lat, lng }]
 *  center 를 주면 거리(m)가 함께 오고, 가까운 순으로 정렬됩니다. */
export function searchPlaces(kakao, keyword, center = null) {
  return new Promise((resolve, reject) => {
    const places = new kakao.maps.services.Places();
    const opt = { size: 8 };
    // x·y 를 주면 결과마다 거리(distance)가 함께 옵니다. 정렬은 정확도 순(기본) 그대로 두어
    // '대전역' 같은 검색어가 엉뚱한 곳으로 밀리지 않게 합니다.
    if (center && Number.isFinite(center.lat) && Number.isFinite(center.lng)) {
      opt.x = String(center.lng); opt.y = String(center.lat);
    }
    places.keywordSearch(keyword, (data, status) => {
      const st = S(kakao);
      if (status === st.OK) {
        resolve((data || []).map((d) => ({
          name: d.place_name,
          address: d.road_address_name || d.address_name || '',
          distance: d.distance ? Number(d.distance) : null,
          lat: Number(d.y),
          lng: Number(d.x),
        })).filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng)));
      } else if (status === st.ZERO_RESULT) resolve([]);
      else reject(new Error('장소를 검색하지 못했어요'));
    }, opt);
  });
}

/** 주소(도로명·지번)로 검색 — [{ name, address, lat, lng }] */
export function searchAddress(kakao, query) {
  return new Promise((resolve, reject) => {
    const geocoder = new kakao.maps.services.Geocoder();
    geocoder.addressSearch(query, (data, status) => {
      const st = S(kakao);
      if (status === st.OK) {
        resolve((data || []).map((d) => {
          const addr = d.road_address?.address_name || d.address?.address_name || query;
          return { name: addr, address: d.address?.address_name || addr, lat: Number(d.y), lng: Number(d.x) };
        }).filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng)));
      } else if (status === st.ZERO_RESULT) resolve([]);
      else reject(new Error('주소를 찾지 못했어요'));
    });
  });
}

/** 좌표 → 한국어 도로명 주소 (없으면 지번 주소). 못 찾으면 '' */
export function coordsToAddress(kakao, lat, lng) {
  return new Promise((resolve, reject) => {
    const geocoder = new kakao.maps.services.Geocoder();
    geocoder.coord2Address(lng, lat, (data, status) => {
      const st = S(kakao);
      if (status === st.OK && data?.length) {
        const road = data[0].road_address;
        const jibun = data[0].address;
        const base = road?.address_name || jibun?.address_name || '';
        const building = road?.building_name;
        resolve(building && base && !base.includes(building) ? `${base} (${building})` : base);
      } else if (status === st.ZERO_RESULT) resolve('');
      else reject(new Error('주소를 찾지 못했어요'));
    });
  });
}
