import React, { useContext, useState, useEffect } from "react";
import axios from "axios";
import { AuthContext } from "../context/AuthProvider";
import { db } from "../firebase";
import { doc, getDoc } from "firebase/firestore";

const ChatTester = ({ faqs }) => {
  const { user } = useContext(AuthContext);

  const [userQ, setUserQ] = useState("");
  const [botAnswer, setBotAnswer] = useState("");
  const [loading, setLoading] = useState(false);
  const [tokensUsed, setTokensUsed] = useState(0);
  const [dailyLimit, setDailyLimit] = useState(2000);
  const [tier, setTier] = useState("free");

  const percentUsed = Math.min(100, Math.round((tokensUsed / dailyLimit) * 100));
  const isNearLimit = percentUsed >= 90;

  const getPlanName = () => {
    if (tier === "pro") return "Pro";
    if (tier === "unlimited") return "Unlimited";
    return "Free";
  };

  // ✅ Fetch tier + token usage on mount
  useEffect(() => {
    const fetchUserData = async () => {
      if (!user?.uid) return;

      try {
        const userRef = doc(db, "users", user.uid);
        const userSnap = await getDoc(userRef);
        if (userSnap.exists()) {
          const userData = userSnap.data();
          const firestoreTier = userData.tier || "free";
          setTier(firestoreTier);

          if (firestoreTier === "pro") setDailyLimit(5000);
          else if (firestoreTier === "unlimited") setDailyLimit(999999);
          else setDailyLimit(2000);
        }

        const usageRef = doc(db, "usage", user.uid);
        const usageSnap = await getDoc(usageRef);
        if (usageSnap.exists()) {
          const usageData = usageSnap.data();
          const today = new Date().toDateString().trim();
          const lastReset = (usageData.lastReset || "").toString().trim();

          if (lastReset === today) {
            setTokensUsed(usageData.tokensUsed || 0);
          } else {
            console.warn("⏳ Different date detected. Resetting usage.");
            setTokensUsed(0);
          }
        }
      } catch (err) {
        console.warn("❌ Error fetching user data from Firestore:", err.message);
      }
    };

    fetchUserData();
  }, [user]);

  const testChat = async () => {
    setLoading(true);
    setBotAnswer("");

    try {
      const res = await axios.post(
        `${import.meta.env.VITE_API_BASE_URL}/api/chat`,
        {
          question: userQ,
          faqs: faqs,
        },
        {
          headers: {
            "x-user-id": user?.uid || "guest-user",
          },
        }
      );

      setBotAnswer(res.data.reply);
      setTokensUsed(res.data.tokensUsed);
      setDailyLimit(res.data.dailyLimit);
      setTier(res.data.tier || "free");
      console.log("🔁 Tier from backend:", res.data.tier);
    } catch (err) {
      setBotAnswer(err.response?.data?.error || "❌ Error getting response.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-white rounded-xl shadow p-6 space-y-4">
      <h2 className="text-xl font-semibold text-pink-600">🤖 Test Chatbot</h2>

      {isNearLimit && (
        <div className="p-3 bg-yellow-100 border-l-4 border-yellow-500 text-yellow-800 text-sm rounded">
          ⚠️ You’ve used {percentUsed}% of your daily token limit. You may be blocked soon.
        </div>
      )}

      <div className="flex flex-col md:flex-row gap-4">
        <input
          type="text"
          className="border px-4 py-2 rounded w-full focus:ring-2 focus:ring-pink-300"
          placeholder="Ask something..."
          value={userQ}
          onChange={(e) => setUserQ(e.target.value)}
        />
        <button
          onClick={testChat}
          disabled={loading}
          className="bg-pink-600 text-white px-5 py-2 rounded hover:bg-pink-700"
        >
          {loading ? "Thinking..." : "💬 Ask Bot"}
        </button>
      </div>

      {botAnswer && (
        <div className="p-4 bg-pink-50 border border-pink-200 rounded text-gray-800">
          <strong className="text-pink-800">Bot:</strong>
          <p className="mt-1 whitespace-pre-wrap">{botAnswer}</p>
        </div>
      )}

      <div className="mt-4 space-y-1">
        <div className="text-sm font-medium text-gray-600">
          Token Usage: {tokensUsed} / {dailyLimit}
        </div>
        <p className="text-xs italic text-gray-500">Plan: {getPlanName()}</p>
        <div className="w-full bg-gray-200 rounded-full h-3">
          <div
            className={`h-3 rounded-full transition-all duration-500 ${
              percentUsed >= 100 ? "bg-red-500" : "bg-green-500"
            }`}
            style={{ width: `${percentUsed}%` }}
          />
        </div>
      </div>
    </div>
  );
};

export default ChatTester;
