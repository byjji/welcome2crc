# 🥕 당근러닝크루 (C.R.C) 웹사이트 — 버전 2 (Firebase)

울산 당근러닝크루 웹사이트. 소개 페이지 + **크루원 전용 공간**으로 구성됩니다.

> 버전 1 (Netlify 정적 사이트)은 `master` 브랜치에 있습니다. 이 브랜치(`firebase`)가 버전 2입니다.

## 무엇이 달라지나 (기존 운영 방식의 문제 해결)

| 기존 방식 | 문제 | 버전 2 |
|---|---|---|
| 크루 소개 없음 | 신규 멤버가 크루를 알 방법이 인스타뿐 | **소개 페이지** (index.html) |
| 공지/일정/투표 → 카카오 오픈채팅 | 대화에 묻혀서 다시 찾기 어려움 | **크루 공간**의 공지·일정·투표 탭 |
| 출석체크 → 당근모임 | 크루 운영과 분리된 외부 앱 | **일정마다 참석/불참 버튼** (출석 기록 저장) |
| 모집 → 인스타 DM | 신청 정보가 정리되지 않음 | **가입 신청 폼** → 운영진이 크루 공간에서 확인·승인 |

## 구성

```
public/               ← Firebase Hosting 으로 배포되는 폴더
  index.html          공개 소개 페이지 (소개·정기런·기록·갤러리·가입신청)
  app.html            크루 공간 (로그인 필요: 공지/일정·출첵/투표/멤버)
  admin.html          ★ 페이지 관리 (운영진 전용: 소개 문구·공식 기록·갤러리)
  css/style.css       기본 디자인 (버전1과 동일한 테마)
  css/v2.css          크루 공간 전용 스타일
  css/v3.css          기록 종목 탭·갤러리 앨범·관리자 페이지 스타일
  js/site-data.js     소개 페이지 기본값 (관리자 페이지 저장 내용이 우선)
  js/firebase-config.js ★★ Firebase 연결 설정 (아래 3단계에서 붙여넣기)
  js/public.js        소개 페이지 동작
  js/app.js           크루 공간 동작
  js/admin.js         페이지 관리 동작
  images/             크루 사진
firebase.json         Firebase 배포 설정
firestore.rules       DB 보안 규칙 (누가 뭘 읽고 쓸 수 있는지)
```

## 처음 설정 (최초 1회, 약 15분)

### 1. Firebase 프로젝트 만들기
1. https://console.firebase.google.com 접속 (Google 계정 필요)
2. **프로젝트 추가** → 이름 예: `crc-web` → (애널리틱스는 꺼도 됨) → 만들기

### 2. 웹 앱 등록
1. 프로젝트 홈에서 **웹(`</>`)** 아이콘 클릭
2. 앱 닉네임 예: `crc-site` → 앱 등록 (Hosting 체크는 안 해도 됨)
3. 화면에 나오는 `firebaseConfig = { apiKey: "AIza..." ... }` 값 복사

### 3. 설정 붙여넣기
`public/js/firebase-config.js` 를 열어 복사한 값으로 교체:

```js
window.FIREBASE_CONFIG = {
  apiKey: "AIza................",
  authDomain: "crc-web.firebaseapp.com",
  projectId: "crc-web",
  storageBucket: "crc-web.appspot.com",
  messagingSenderId: "1234567890",
  appId: "1:1234567890:web:abcdef",
};
```

### 4. 로그인 기능 켜기 (Authentication)
1. 왼쪽 메뉴 **제품 카테고리 → 보안 → Authentication** → 시작하기
   - 콘솔 버전에 따라 "빌드"/"구축" 카테고리에 있을 수도 있습니다.
   - 안 보이면: 사이드바의 **"모든 제품"** → Authentication 선택 (한 번 열면 사이드바에 고정됨)
2. **로그인 방법(Sign-in method)** 탭에서:
   - **Google** → 사용 설정 (프로젝트 지원 이메일 선택) → 저장
   - **이메일/비밀번호** → 사용 설정 → 저장

### 5. 데이터베이스 만들기 (Firestore)
1. 왼쪽 메뉴(또는 "모든 제품")에서 **Cloud Firestore** → 데이터베이스 만들기
2. 위치: `asia-northeast3 (서울)` 권장 → **프로덕션 모드**로 시작
   (보안 규칙은 다음 단계에서 우리 파일로 덮어씁니다)

### 6. 배포 (Firebase CLI)
터미널에서:

```bash
npm install -g firebase-tools   # 최초 1회
firebase login                  # 브라우저로 Google 로그인
cd d:\Development\CRC_Web
firebase use --add              # 위에서 만든 프로젝트 선택, 별칭은 default
firebase deploy                 # 보안 규칙 + 사이트 배포
```

> ⚠️ **터미널은 PowerShell(또는 CMD)을 사용하세요.** Git Bash에서 `firebase login` 하면
> `Cannot run login in non-interactive mode` 에러가 납니다.
> (Git Bash를 꼭 쓰려면 `winpty firebase login` 처럼 앞에 `winpty`를 붙이면 됩니다.)

완료되면 `https://프로젝트ID.web.app` 주소가 나옵니다. 🎉

### 7. 첫 운영진(관리자) 지정
1. 배포된 사이트의 **크루 공간**에서 본인 계정으로 가입 (Google 또는 이메일)
2. Firebase 콘솔 → **Firestore Database** → `members` 컬렉션 → 본인 문서 클릭
3. `role` 필드 값을 `pending` → **`admin`** 으로 수정
4. 사이트 새로고침 → 👑 운영진 메뉴(공지 작성, 승인 등)가 나타납니다

이후 다른 멤버는 사이트 안에서 승인/운영진 지정이 가능하니, 콘솔에 다시 들어갈 일은 거의 없습니다.

## 사용 흐름

- **일반 방문자**: 소개 페이지 → 가입 신청서 제출 (또는 인스타 DM)
- **운영진**: 크루 공간 → 멤버 탭에서 신청서 확인 → 게스트런 안내 → 크루 공간 가입 유도 → 승인
- **크루원**: 크루 공간에서 공지 확인, 일정에 참석/불참 체크, 투표 참여

## 페이지 관리 (admin.html) — 운영진 전용

크루 공간 헤더의 **⚙️ 페이지 관리** 버튼(또는 `/admin.html` 직접 접속)으로 들어갑니다.
운영진(`role: admin`) 계정만 접근 가능하며, 저장 내용은 Firestore 에 저장되어
소개 페이지가 열릴 때 자동으로 반영됩니다. (재배포 불필요)

| 탭 | 관리 내용 |
|---|---|
| 📝 소개 문구 | 크루 이름·슬로건·소개 문단·인스타 아이디 / 크루 현황 숫자 / 핵심 가치 카드 / 정기런 일정 |
| 🏅 공식 기록 | 대회 등록(대회명 + 연월) → 대회마다 종목(풀코스·하프·10km·5km)별 기록 추가/삭제 |
| 📸 갤러리 | 앨범 만들기 → 사진 업로드(자동 압축)·삭제. 소개 페이지에서 앨범을 누르면 사진 뷰어가 열립니다 |

- 아직 관리자 페이지에서 저장한 적이 없는 항목은 `js/site-data.js` 의 기본값이 표시됩니다.
- 사진은 Firebase Storage 없이(무료 플랜 유지) 자동 압축 후 Firestore 에 저장됩니다.
  한 장당 약 0.3~0.8MB 로 저장되므로 앨범당 수십 장 규모에 적합합니다.

> ⚠️ **처음 한 번은 보안 규칙 배포가 필요합니다.** GitHub 자동 배포는 사이트(Hosting)만
> 올리므로, 규칙이 바뀐 이 버전은 터미널에서 아래를 한 번 실행해 주세요:
> ```bash
> firebase deploy --only firestore:rules
> ```

## 로컬 미리보기

모듈(JS import)을 사용하므로 파일을 직접 열면 안 되고, 간단한 서버가 필요합니다:

```bash
cd d:\Development\CRC_Web
npx serve public
# 또는 firebase 로그인이 되어 있다면: firebase serve
```

→ http://localhost:3000 (serve 기준)

## 콘텐츠 수정

- **가장 쉬운 방법: 관리자 페이지(`admin.html`)에서 수정** — 저장 즉시 반영, 코드/배포 불필요
- `public/js/site-data.js` 는 관리자 페이지에서 저장한 적 없을 때 보이는 **기본값**입니다

## 요금

Firebase 무료 플랜(Spark)으로 충분합니다:
- Firestore: 일 5만 회 읽기 / 2만 회 쓰기 무료 — 수십 명 크루 규모로는 여유
- Authentication: 무제한 무료 (일반 로그인)
- Hosting: 10GB 저장 / 월 360MB 전송 무료

## 알아두면 좋은 것

- 보안은 `firestore.rules` 가 지킵니다. 크루원이 아니면 공지/일정/투표를 **서버 차원에서** 읽을 수 없습니다.
- "내보내기"한 멤버가 다시 로그인하면 자동으로 '승인 대기' 상태가 됩니다 (계정 자체 삭제는 콘솔 → Authentication 에서).
- 카카오 로그인은 Firebase 기본 지원이 아니라 제외했습니다 (Google/이메일 로그인 사용).
