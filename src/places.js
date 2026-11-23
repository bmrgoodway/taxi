// 별무리 마을 주요 거점 — 원클릭 출발지·도착지
// 좌표는 무료 지도(OpenStreetMap)에 찍어 주는 '대략 위치'용입니다. (지도 앱 길찾기와 조금 다를 수 있어요)
export const PLACES = [
  { name: '별무리학교', emoji: '🏫', lat: 36.0013119, lng: 127.5058117 },
  { name: '별무리교회', emoji: '⛪', lat: 36.0013612, lng: 127.5053436 },
  { name: '이든카페', emoji: '☕', lat: 36.1071814, lng: 127.4896976 },
  { name: '금산터미널', emoji: '🚌', lat: 36.110517, lng: 127.49111 },
  { name: '대전역', emoji: '🚄', lat: 36.332326, lng: 127.434211 },
  { name: '서대전역', emoji: '🚉', lat: 36.322517, lng: 127.403933 },
  { name: '복합터미널', emoji: '🚏', lat: 36.3516567, lng: 127.4374114 },
];

export const placeOf = (name) => PLACES.find((p) => p.name === name) || null;
