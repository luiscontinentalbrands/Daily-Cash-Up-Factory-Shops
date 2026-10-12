// Paste your Firebase web app settings here.
// Firebase console → Project settings (gear icon) → General → "Your apps" → Web app → SDK setup and configuration → Config.
// These values are not passwords: they identify your project. Your data is protected by
// Firebase Authentication plus the rules in firestore.rules.
export const firebaseConfig = {
  apiKey: "PASTE_API_KEY",
  authDomain: "PASTE_PROJECT_ID.firebaseapp.com",
  projectId: "PASTE_PROJECT_ID",
  storageBucket: "PASTE_PROJECT_ID.appspot.com",
  messagingSenderId: "PASTE_SENDER_ID",
  appId: "PASTE_APP_ID"
};

// Staff are signed out automatically after this many minutes without touching the app.
export const IDLE_MINUTES = 15;
