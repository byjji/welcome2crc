# 🥕 당근러닝크루 (C.R.C) 웹사이트

울산 당근러닝크루의 공식 웹사이트. **공개 소개 페이지 + 크루원 전용 공간 + 내 정보·관리 허브**로 구성된 정적 사이트입니다.

빌드 도구 없이 **브라우저 ES 모듈**로 동작하고, **Firebase**(Hosting · Auth · Firestore · Storage)로 배포·운영합니다.
크루원 대부분이 모바일로 접속하므로 **모바일 화면을 우선**으로 만들었습니다 (데스크탑도 동일 기능).

## 화면 구성

| 페이지 | 대상 | 내용 |
|---|---|---|
| `index.html` 소개 페이지 | 누구나 | 크루 소개 · 정기런 일정 · 공식 기록 · 가입 안내 |
| `app.html` 크루 공간 | 크루원(로그인) | 하단 5탭 — 홈 · 일정/출첵 · 소식(공지+투표) · 갤러리 · 멤버 |
| `admin.html` 내 정보·관리 | 크루원 / 운영진 | 내 정보 수정(모두) · 소개 페이지 관리(운영진) |

## 주요 기능

- **계정+비밀번호 로그인** — 아이디 형식(대소문자 구분, 이메일 없음) + 힌트 기반 비밀번호 찾기
- **가입 승인제** — `pending` → 운영진 승인 → `member` / `admin` (role 기반 권한)
- **일정 · 출석체크 · 이달의 기록(마일리지)**
- **소식** — 공지(고정·펼쳐보기) + 투표(실시간 집계 · 마감일시 · 투표자 명단)
- **갤러리** — 앨범 · 카테고리 책갈피 탭 · 미리보기 업로드 · 라이트박스 · **전체/선택 다운로드**, 하이브리드 저장(감상 영구 / 원본 60일)
- **멤버 관리** — 승인/거절/내보내기, 운영진 지정, 멤버 정보 열람
- **소개 페이지 관리** — 운영진이 화면에서 편집, 저장 즉시 반영(재배포 불필요)
- **PWA** — 홈 화면 설치 · 자동 업데이트 알림 · **뒤로가기로 이전 단계 이동**(앱이 바로 종료되지 않고, 홈에서 두 번 눌러 종료)

## 기술 스택

- **프론트엔드**: 순수 HTML / CSS / JavaScript (ES 모듈, 빌드 없음)
- **백엔드**: Firebase Authentication · Cloud Firestore · Cloud Storage · Hosting
- **배포**: GitHub Actions (`master` 푸시 → 자동 배포, PR → 미리보기 배포)

## 빠른 시작

### 로컬 미리보기
JS 모듈을 쓰므로 파일을 직접 열면 안 되고 간단한 서버가 필요합니다.

```bash
npx serve public          # → http://localhost:3000
# 또는: cd public && python -m http.server 8123
```

### 배포

| 무엇을 바꿨나 | 방법 |
|---|---|
| `public/` 안의 HTML/CSS/JS | `git push` → GitHub Actions 자동 배포 |
| `firestore.rules` (DB 규칙) | `firebase deploy --only firestore:rules` |
| `storage.rules` (사진 규칙) | `firebase deploy --only storage` |
| 설치 사용자에게 업데이트 알림 | `public/sw.js` 의 `VERSION` 값을 올린 뒤 push |
| 소개 페이지 내용 | 배포 불필요 — 관리 화면에서 저장하면 즉시 반영 |

## 문서

- **[PROJECT.md](PROJECT.md)** — 전체 구조 · 화면별 기능 · 데이터 모델 · 운영/요금 가이드 (개발·운영 문서)
- **[docs/사용설명서.pdf](docs/사용설명서.pdf)** — 크루원·운영진용 **화면별·권한별 사용법** (PDF)
- **[CHANGE.md](CHANGE.md)** — 변경 이력

## 폴더 개요

```
public/            배포 폴더 — index/app/admin.html + manifest·sw + css/ js/ img/ icons/ data/
  css/             base·components (공통) + pages/ (화면 전용)
  js/
    lib/           공통 모듈 (firebase·storage·account·format·icons·pwa·swipe·ui·colorpicker)
    pages/         화면별 로직 — public / app / admin
firestore.rules    Firestore 보안 규칙
storage.rules      Cloud Storage(갤러리 사진) 보안 규칙
firebase.json      Hosting 배포 설정
docs/              사용 설명서
```

> 파일별 상세 설명은 [PROJECT.md](PROJECT.md) 의 **폴더 구조** 섹션 참고.

## 운영 메모

- Firebase 프로젝트: **`carrotrunningcrew`** (리전 `asia-northeast3`)
- 갤러리(Cloud Storage)는 **Blaze 플랜**이 필요하지만, 사용량이 무료 할당 안이라 실제 비용은 사실상 **$0** (→ PROJECT.md 요금 섹션)
- **첫 운영진**은 Firebase 콘솔에서 `members` 문서의 `role` 을 `admin` 으로 직접 지정
