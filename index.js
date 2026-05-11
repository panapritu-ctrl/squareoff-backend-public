const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const crypto = require('crypto');

// Initialize Firebase Admin with Service Account
let serviceAccount;
try {
  serviceAccount = require('./firebase-key.json');
} catch (error) {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } else {
    console.error("Missing Firebase credentials: No firebase-key.json or FIREBASE_SERVICE_ACCOUNT found.");
    process.exit(1);
  }
}
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const app = express();

app.use(cors({ origin: true }));
// Parse JSON body unless it's the SSV callback which might need raw parsing depending on AdMob, but AdMob sends GET request for SSV actually.
app.use(express.json());

// ── Authentication Middleware ───────────────────────────────────────────────
async function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).send({ error: 'Unauthorized: No token provided' });
  }
  const token = authHeader.split('Bearer ')[1];
  try {
    const decodedToken = await admin.auth().verifyIdToken(token);
    req.user = decodedToken;
    next();
  } catch (error) {
    return res.status(401).send({ error: 'Unauthorized: Invalid token' });
  }
}

// ── 1. CLAIM WELCOME BONUS (Reinstall Defense) ─────────────────────────────
app.post('/claimWelcomeBonus', authenticate, async (req, res) => {
  try {
    const uid = req.user.uid;
    const { deviceId } = req.body;

    if (!deviceId) return res.status(400).send({ error: "Missing deviceId" });

    const userRef = db.collection("users").doc(uid);
    const deviceRef = db.collection("devices").doc(deviceId);

    await db.runTransaction(async (t) => {
      const deviceDoc = await t.get(deviceRef);
      if (deviceDoc.exists) {
        throw new Error("already-claimed");
      }
      
      const userDoc = await t.get(userRef);
      const currentCoins = userDoc.exists && userDoc.data().coins != null ? userDoc.data().coins : 0;
      
      t.set(deviceRef, { claimedAt: admin.firestore.FieldValue.serverTimestamp(), claimedBy: uid });
      t.set(userRef, { coins: currentCoins + 500 }, { merge: true });
    });

    res.status(200).send({ success: true, message: "Welcome bonus granted", awarded: 500 });
  } catch (error) {
    if (error.message === "already-claimed") {
      res.status(403).send({ error: "Device already claimed welcome bonus." });
    } else {
      res.status(500).send({ error: "Internal Server Error" });
    }
  }
});

// ── 2. CLAIM DAILY BONUS ───────────────────────────────────────────────────
app.post('/claimDailyBonus', authenticate, async (req, res) => {
  try {
    const uid = req.user.uid;
    const today = new Date().toISOString().split("T")[0]; 

    const bonusRef = db.collection("dailyBonus").doc(uid);
    const userRef = db.collection("users").doc(uid);

    await db.runTransaction(async (t) => {
      const bonusDoc = await t.get(bonusRef);
      if (bonusDoc.exists && bonusDoc.data().lastClaimed === today) {
        throw new Error("already-claimed");
      }

      const userDoc = await t.get(userRef);
      const currentCoins = userDoc.exists && userDoc.data().coins != null ? userDoc.data().coins : 0;

      t.set(bonusRef, { lastClaimed: today }, { merge: true });
      t.set(userRef, { coins: currentCoins + 50 }, { merge: true });
    });

    res.status(200).send({ success: true, message: "Daily bonus granted", awarded: 50 });
  } catch (error) {
    if (error.message === "already-claimed") {
      res.status(403).send({ error: "Already claimed today." });
    } else {
      res.status(500).send({ error: "Internal Server Error" });
    }
  }
});

// ── 3. DELETE ACCOUNT ──────────────────────────────────────────────────────
app.post('/deleteAccount', authenticate, async (req, res) => {
  try {
    const uid = req.user.uid;

    const userRef = db.collection("users").doc(uid);
    const lbRef = db.collection("leaderboard").doc(uid);
    const dbRef = db.collection("dailyBonus").doc(uid);

    const batch = db.batch();
    batch.delete(userRef);
    batch.delete(lbRef);
    batch.delete(dbRef);

    await batch.commit();
    await admin.auth().deleteUser(uid);
    
    res.status(200).send({ success: true });
  } catch (error) {
    res.status(500).send({ error: "Internal Server Error" });
  }
});

// ── 4. ADMOB SSV CALLBACK ──────────────────────────────────────────────────
// AdMob sends a GET request
app.get('/admobSsvCallback', async (req, res) => {
  try {
    const query = req.query;
    
    const signature = query.signature;
    const key_id = query.key_id;
    const custom_data = query.custom_data; 
    const reward_amount = parseInt(query.reward_amount || '0', 10);

    if (!signature || !key_id || !custom_data) {
      return res.status(400).send("Missing required parameters");
    }

    let uid;
    try {
      const parsedData = JSON.parse(custom_data);
      uid = parsedData.uid;
    } catch (e) {
      uid = custom_data; 
    }

    if (!uid) {
      return res.status(400).send("Missing custom_data uid");
    }

    const userRef = db.collection("users").doc(uid);

    await db.runTransaction(async (t) => {
      const doc = await t.get(userRef);
      const currentCoins = doc.exists && doc.data().coins != null ? doc.data().coins : 0;
      t.set(userRef, { coins: currentCoins + reward_amount }, { merge: true });
    });

    res.status(200).send("OK");
  } catch (error) {
    console.error("SSV Error:", error);
    res.status(500).send("Internal Server Error");
  }
});

app.get('/', (req, res) => res.send('SquareOff Backend is Live!'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`SquareOff Backend listening on port ${PORT}`);
});
