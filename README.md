# StrikeCoach (M0 웹앱)

PRD의 M0 범위: 카메라 자세 인식 + 펀치/킥 카운트 + 가드 하락 감지 + 음성 큐 + 세션 리포트.
빌드 도구 없이 ES 모듈로 동작하고, 자세 인식은 MediaPipe Pose Landmarker를 브라우저에서 돌린다(CDN에서 로드, 인터넷 필요).

## 실행

```bash
python -m http.server 5173 --bind 127.0.0.1 --directory app
```

- 앱: http://localhost:5173
- 테스트: http://localhost:5173/tests.html (제목이 PASS면 통과)
- 웹캠이 없거나 권한이 없으면 촬영 준비 화면에서 "데모로 해보기"로 합성 자세 데이터를 써서 전체 흐름을 돌릴 수 있다.
- 휴대폰에서 카메라를 쓰려면 https 주소가 필요하다(브라우저 정책). PC에서는 localhost라 바로 된다.

## 구조

| 경로 | 역할 |
|---|---|
| `js/analysis/analyzer.js` | 프레임 단위 분석: 잽/크로스, 킥, 가드 하락, 가드 유지율 |
| `js/feedback/cues.js` | 음성 큐 규칙(한 번에 하나, 같은 큐 10초 간격) + 음성 출력 |
| `js/pose/camera-source.js` | 전면 카메라 + MediaPipe |
| `js/pose/demo-source.js` | 카메라 없이 쓰는 합성 자세(테스트 기대값의 기준) |
| `js/screens/*` | 온보딩, 홈, 촬영 준비, 실시간 훈련, 리포트 |
| `js/store.js` | 설정·세션 기록(localStorage, 영상은 저장 안 함) |
| `css/app.css` | 디자인 토큰(ux-prototype.html과 같음) |

## 아직 안 된 것

- 훅·어퍼컷 구분, 킥 후 복귀 시간 측정, 영상 리뷰, 기록 그래프, 스파링·섀도 드릴·코치 공유
- 분석 임계값은 합성 데이터로만 검증함. 실제 미트 훈련 영상으로 조정이 필요하다.
- 서비스 워커(오프라인 설치)
