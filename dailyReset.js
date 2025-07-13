// server/dailyReset.js
import cron from "node-cron";
import { db } from "./firebase.js";
import { Timestamp } from "firebase-admin/firestore"; // ✅ Correct backend Timestamp

cron.schedule("30 18 * * *", async () => {
  const snapshot = await db.collection("companies").get();

  for (const doc of snapshot.docs) {
    await doc.ref.update({
      tokensUsedToday: 0,
      lastReset: Timestamp.now(),
    });
  }

  console.log("✅ Daily reset completed");
  console.log("📆 Daily CRON job initialized");
});
