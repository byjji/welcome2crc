/* ============================================================
   lib/firebase.js — Firebase 초기화 (모든 페이지 공통)
   ------------------------------------------------------------
   CDN SDK 를 불러와 앱을 초기화하고, 각 페이지가 쓰는
   auth / db / SDK 함수들을 한곳에서 내보냅니다.
   ⚠️ window.FIREBASE_READY 확인 후 동적 import 로 불러오세요:
      const fb = await import("../../lib/firebase.js");
   ============================================================ */
const SDK = window.FIREBASE_SDK;

const appMod = await import(`${SDK}/firebase-app.js`);
const authMod = await import(`${SDK}/firebase-auth.js`);
const fsMod = await import(`${SDK}/firebase-firestore.js`);

const firebaseApp = appMod.getApps().length
  ? appMod.getApps()[0]
  : appMod.initializeApp(window.FIREBASE_CONFIG);

export const auth = authMod.getAuth(firebaseApp);
export const db = fsMod.getFirestore(firebaseApp);

/* 인증 */
export const {
  onAuthStateChanged, signOut,
  createUserWithEmailAndPassword, signInWithEmailAndPassword,
  updateProfile,
  EmailAuthProvider, reauthenticateWithCredential, updatePassword,
} = authMod;

/* Firestore */
export const {
  collection, doc,
  getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc,
  onSnapshot, query, orderBy, serverTimestamp, increment, deleteField,
} = fsMod;
