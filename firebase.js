// firebase.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-storage.js";

const firebaseConfig = {
  apiKey: "AIzaSyDwfMxbM8DG7T3MllkjtYY1R2PPRYvfYHg",
  authDomain: "katik-messenger.firebaseapp.com",
  databaseURL: "https://katik-messenger-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "katik-messenger",
  storageBucket: "katik-messenger.firebasestorage.app",
  messagingSenderId: "528309622983",
  appId: "1:528309622983:web:faa6c893c6a36013eac6e2"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);
export const storage = getStorage(app);
