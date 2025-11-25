// js/firebase.js
// Replace the firebaseConfig object with your project's values from Firebase console.

(function (window) {
  const firebaseConfig = {
    apiKey: "AIzaSyDQJf2WswK6h2C-gZoQQhKRerFGmnYNWwU",
    authDomain: "esp32-firebase-demo-3472c.firebaseapp.com",
    databaseURL: "https://esp32-firebase-demo-3472c-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "esp32-firebase-demo-3472c",
    storageBucket: "esp32-firebase-demo-3472c.firebasestorage.app",
    messagingSenderId: "295010265468",
    appId: "1:295010265468:web:217288ec31530584075cf9"
    // storageBucket, messagingSenderId, appId, measurementId optionally...
  };

  if (!window.firebase) {
    console.error('Firebase SDK not found. Load firebase-app-compat.js and firebase-firestore-compat.js first.');
    return;
  }

  if (!firebase.apps || firebase.apps.length === 0) {
    firebase.initializeApp(firebaseConfig);
  }

  const db = firebase.firestore();

  // convert a Firestore Timestamp or object to JS Date
  function tsToDate(ts) {
    if (!ts) return new Date();
    if (typeof ts.toDate === 'function') return ts.toDate();
    if (ts.seconds) return new Date(ts.seconds * 1000);
    return new Date(ts);
  }

  async function writeReading({ ph, temp, laju }) {
    return db.collection('biogas').add({
      ph: Number(ph),
      temp: Number(temp),
      laju: Number(laju),
      timestamp: firebase.firestore.FieldValue.serverTimestamp()
    });
  }

  // robust listener: uses createTime as fallback and returns rows oldest -> newest
  function listenLatest(onChange, n = 200) {
    if (typeof onChange !== 'function') throw new Error('onChange callback required');
    const q = db.collection('biogas').orderBy('timestamp', 'desc').limit(n);

    const unsubscribe = q.onSnapshot(snapshot => {
      const rows = [];
      snapshot.forEach(doc => {
        const data = doc.data() || {};
        let ts = data.timestamp;
        if (!ts) ts = doc.createTime || doc.updateTime || null;
        rows.push({
          id: doc.id,
          ph: data.ph,
          temp: data.temp,
          laju: data.laju,
          timestamp: ts
        });
      });
      rows.reverse(); // oldest -> newest
      onChange(rows);
    }, err => {
      console.error('Firestore listen error:', err);
    });
    return unsubscribe;
  }

  // fetch once (optionally force server source)
  async function fetchLatestOnce(n = 200, { sourceServer = false } = {}) {
    try {
      const q = db.collection('biogas').orderBy('timestamp', 'desc').limit(n);
      const snapshot = sourceServer ? await q.get({ source: 'server' }) : await q.get();
      const rows = [];
      snapshot.forEach(doc => {
        const data = doc.data() || {};
        let ts = data.timestamp;
        if (!ts) ts = doc.createTime || doc.updateTime || null;
        rows.push({ id: doc.id, ph: data.ph, temp: data.temp, laju: data.laju, timestamp: ts });
      });
      return rows.reverse();
    } catch (err) {
      console.error('fetchLatestOnce error', err);
      throw err;
    }
  }

  // test writer
  async function pushTestReading(ph, temp, laju) {
    return writeReading({ ph, temp, laju });
  }

  window.firebaseApp = window.firebaseApp || {};
  Object.assign(window.firebaseApp, {
    db,
    writeReading,
    listenLatest,
    pushTestReading,
    fetchLatestOnce,
    tsToDate
  });

})(window);
