/**
 * Firebase Web Config for online play (copy this into config.js,
 * OR paste directly inside the "Online Setup" button in the app).
 *
 * Firebase web config values are safe to include in public frontend apps:
 * real protection comes from database.rules.json + Anonymous Auth.
 */
export const FIREBASE_CONFIG = {
  apiKey: 'YOUR_API_KEY',
  authDomain: 'YOUR_PROJECT_ID.firebaseapp.com',
  databaseURL: 'https://YOUR_PROJECT_ID-default-rtdb.firebaseio.com',
  projectId: 'YOUR_PROJECT_ID',
  appId: 'YOUR_APP_ID',
};
