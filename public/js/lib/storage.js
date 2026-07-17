/* ============================================================
   lib/storage.js — Cloud Storage (갤러리 사진 전용)
   ------------------------------------------------------------
   Storage SDK 는 사진을 올리거나 지울 때만 필요하므로
   lib/firebase.js 에 합치지 않고 별도 모듈로 둡니다.
   쓰는 쪽(gallery.js)에서 동적 import 로 불러오세요:
     const st = await import("../../lib/storage.js");
   ============================================================ */
const SDK = window.FIREBASE_SDK;

const appMod = await import(`${SDK}/firebase-app.js`);
const stMod = await import(`${SDK}/firebase-storage.js`);

const firebaseApp = appMod.getApps().length
  ? appMod.getApps()[0]
  : appMod.initializeApp(window.FIREBASE_CONFIG);

export const storage = stMod.getStorage(firebaseApp);

export const {
  ref: sref, uploadBytes, getDownloadURL, deleteObject,
} = stMod;
