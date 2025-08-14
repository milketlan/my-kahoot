import React, { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { TrendingUp, Users, Trophy, Play, Square, ChevronRight, QrCode, Shuffle, Trash2, CheckCircle2, Clock, Flame, Loader2, Crown, Eye, EyeOff, Settings, Star, Send, Image as ImageIcon, LogOut } from "lucide-react";
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid } from "recharts";
import { initializeApp, getApp, getApps } from "firebase/app";
import {
  getFirestore,
  doc,
  setDoc,
  getDoc,
  updateDoc,
  addDoc,
  collection,
  onSnapshot,
  serverTimestamp,
  query,
  where,
  orderBy,
  getDocs,
  runTransaction,
  deleteDoc,
} from "firebase/firestore";
import { QRCodeCanvas } from "qrcode.react";

// ========================= SETUP =========================
// 1) 在 Firebase Console 建立專案並啟用 Firestore (建議先用 Test Mode)
// 2) 將以下設定替換為你的 Firebase 專案設定
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyBSXyXYb03LNmOjeB5NOJ0f36UrAD6RRA0",
  authDomain: "my-kahoot-2a4a5.firebaseapp.com",
  projectId: "my-kahoot-2a4a5",
  storageBucket: "my-kahoot-2a4a5.firebasestorage.app",
  messagingSenderId: "971297985221",
  appId: "1:971297985221:web:5d23f815b22c47dfb4d6ac",
  measurementId: "G-G9K2WFWT3H"
};

let app, db;
try {
  app = getApps().length ? getApp() : initializeApp(FIREBASE_CONFIG);
  db = getFirestore(app);
  console.log("[Firebase] app initialized:", app.name);
} catch (e) {
  console.error("[Firebase] init error:", e);
}

// 工具：產生 6 位數 PIN 與隨機 ID
const pin6 = () => Math.floor(100000 + Math.random() * 900000).toString();
const rid = () => Math.random().toString(36).slice(2, 10);

// 工具：安全的時間 (由伺服端時間標記對齊)
const now = () => new Date().getTime();

// 工具：DiceBear 大頭貼（純 URL，不需註冊）
const avatarUrlFor = (name) => `https://api.dicebear.com/8.x/thumbs/svg?seed=${encodeURIComponent(name || rid())}`;

// 工具：格式化 mm:ss
const fmt = (s) => {
  const m = Math.floor(s / 60);
  const r = Math.max(0, Math.floor(s % 60));
  return `${m}:${r.toString().padStart(2, "0")}`;
};

// 預設 10 題（可在主持端編輯）
const SAMPLE_QUESTIONS = [
  {
    text: "下列哪一個是質數？",
    options: ["21", "29", "1", "91"],
    correctIndex: 1,
    durationSec: 20,
  },
  {
    text: "太陽系中最大的行星？",
    options: ["木星", "土星", "天王星", "地球"],
    correctIndex: 0,
    durationSec: 15,
  },
  {
    text: "JS 中可以聲明常數的關鍵字？",
    options: ["let", "const", "var", "static"],
    correctIndex: 1,
    durationSec: 15,
  },
  {
    text: "台灣的首都是哪裡？",
    options: ["高雄", "台中", "台北", "新竹"],
    correctIndex: 2,
    durationSec: 12,
  },
  {
    text: "1 公里等於多少公尺？",
    options: ["10", "100", "1000", "10000"],
    correctIndex: 2,
    durationSec: 10,
  },
  {
    text: "二進位 1010 為十進位？",
    options: ["8", "9", "10", "11"],
    correctIndex: 2,
    durationSec: 12,
  },
  {
    text: "HTTP 狀態碼 404 代表？",
    options: ["成功", "伺服器錯誤", "未授權", "找不到資源"],
    correctIndex: 3,
    durationSec: 10,
  },
  {
    text: "React 的狀態 Hook 是？",
    options: ["useRef", "useMemo", "useEffect", "useState"],
    correctIndex: 3,
    durationSec: 12,
  },
  {
    text: "下列哪個不是原色？",
    options: ["紅", "綠", "藍", "黑"],
    correctIndex: 3,
    durationSec: 12,
  },
  {
    text: "Pi (π) 約等於？",
    options: ["2.14", "3.14", "3.41", "4.13"],
    correctIndex: 1,
    durationSec: 10,
  },
];

// 分數計算：正確即有基礎分 700，速度加分最多 300（愈快愈多）。
function calcPoints(isCorrect, elapsedMs, durationSec) {
  if (!isCorrect) return 0;
  const base = 700;
  const t = Math.max(0, Math.min(elapsedMs, durationSec * 1000));
  const speed = 1 - t / (durationSec * 1000);
  const bonus = Math.round(300 * speed);
  return base + bonus;
}

// ========================= FIRESTORE 層 =========================
async function createGame(hostName) {
  const id = rid();
  const pin = pin6();
  const hostSecret = rid();
  const gameRef = doc(db, "games", id);
  await setDoc(gameRef, {
    pin,
    hostSecret,
    hostName: hostName || "主持人",
    status: "lobby", // lobby | question | review | scoreboard | finished
    currentQuestionIndex: -1,
    createdAt: serverTimestamp(),
    questionStartAt: null,
    questionEndAt: null,
    questionDurationSec: null,
    revealAnswer: false,
    allowJoin: true,
  });
  // 預先寫入範例題目
  const qcol = collection(gameRef, "questions");
  for (let i = 0; i < SAMPLE_QUESTIONS.length; i++) {
    await setDoc(doc(qcol, String(i)), { ...SAMPLE_QUESTIONS[i], index: i });
  }
  return { id, pin, hostSecret };
}

async function joinGameByPin(pin, name, avatar) {
  // 找到對應 PIN 的遊戲
  const q = query(collection(db, "games"), where("pin", "==", pin));
  const snap = await getDocs(q);
  if (snap.empty) throw new Error("查無此房號");
  const gameDoc = snap.docs[0];
  const gameId = gameDoc.id;
  const g = gameDoc.data();
  if (g.status !== "lobby" && !g.allowJoin) throw new Error("目前暫停加入");

  const playerId = rid();
  await setDoc(doc(db, "games", gameId, "players", playerId), {
    name,
    avatar: avatar || avatarUrlFor(name),
    score: 0,
    joinedAt: serverTimestamp(),
    present: true,
  });
  return { gameId, playerId };
}

async function startQuestion(gameId, index) {
  const gref = doc(db, "games", gameId);
  const qref = doc(db, "games", gameId, "questions", String(index));
  const qdoc = await getDoc(qref);
  if (!qdoc.exists()) throw new Error("題目不存在");
  const qdata = qdoc.data();
  await updateDoc(gref, {
    status: "question",
    currentQuestionIndex: index,
    questionDurationSec: qdata.durationSec || 15,
    revealAnswer: false,
    questionStartAt: serverTimestamp(),
    questionEndAt: null,
  });
}

async function endQuestion(gameId) {
  const gref = doc(db, "games", gameId);
  await updateDoc(gref, {
    questionEndAt: serverTimestamp(),
    status: "review",
  });
}

async function submitAnswer(gameId, playerId, questionIndex, optionIndex) {
  const gref = doc(db, "games", gameId);
  const g = (await getDoc(gref)).data();
  if (g.status !== "question") return; // 已結束
  const aRef = doc(collection(db, "games", gameId, "answers"), `${playerId}_${questionIndex}`);
  await setDoc(aRef, {
    playerId,
    questionIndex,
    optionIndex,
    createdAt: serverTimestamp(),
  }, { merge: true });
}

async function scoreQuestion(gameId) {
  // 由主持端呼叫：計算分數、最快正確者、更新排行榜
  await runTransaction(db, async (trx) => {
    const gref = doc(db, "games", gameId);
    const gdoc = await trx.get(gref);
    const g = gdoc.data();
    const idx = g.currentQuestionIndex;

    const qref = doc(db, "games", gameId, "questions", String(idx));
    const qdoc = await trx.get(qref);
    const qd = qdoc.data();

    const answersQ = query(
      collection(db, "games", gameId, "answers"),
      where("questionIndex", "==", idx)
    );
    const asnap = await getDocs(answersQ);

    const start = g.questionStartAt?.toDate?.() || new Date();
    const durationSec = qd.durationSec || 15;

    let fastest = { playerId: null, ms: Infinity };
    const awardMap = new Map(); // playerId -> points

    asnap.forEach((adoc) => {
      const a = adoc.data();
      const isCorrect = a.optionIndex === qd.correctIndex;
      const created = a.createdAt?.toDate?.() || new Date();
      const elapsed = Math.max(0, created.getTime() - start.getTime());
      const pts = calcPoints(isCorrect, elapsed, durationSec);
      const prev = awardMap.get(a.playerId) || 0;
      awardMap.set(a.playerId, Math.max(prev, pts)); // 只保留一次作答最高分（防抖）
      if (isCorrect && elapsed < fastest.ms) {
        fastest = { playerId: a.playerId, ms: elapsed };
      }
    });

    // 更新玩家分數
    const playersSnap = await getDocs(collection(db, "games", gameId, "players"));
    const updates = [];
    playersSnap.forEach((pdoc) => {
      const p = pdoc.data();
      const add = awardMap.get(pdoc.id) || 0;
      const newScore = (p.score || 0) + add;
      updates.push(trx.update(pdoc.ref, { score: newScore, lastGain: add }));
    });

    // 標記此題結果
    updates.push(trx.update(qref, {
      fastestPlayerId: fastest.playerId,
      fastestTimeMs: isFinite(fastest.ms) ? fastest.ms : null,
      processedAt: serverTimestamp(),
    }));

    // 揭示答案、切到 scoreboard 狀態（題後會顯示排行榜）
    updates.push(trx.update(gref, { revealAnswer: true, status: "scoreboard" }));
    return Promise.all(updates);
  });
}

async function nextQuestion(gameId) {
  const gref = doc(db, "games", gameId);
  const gdoc = await getDoc(gref);
  const g = gdoc.data();
  const next = (g.currentQuestionIndex || 0) + 1;
  const total = (await getDocs(collection(db, "games", gameId, "questions"))).size;
  if (next >= total) {
    await updateDoc(gref, { status: "finished" });
  } else {
    await startQuestion(gameId, next);
  }
}

async function toggleJoin(gameId, allow) {
  await updateDoc(doc(db, "games", gameId), { allowJoin: allow });
}

// ========================= UI 元件 =========================
function Card({ children, className = "" }) {
  return (
    <div className={`rounded-2xl shadow-lg bg-white/70 backdrop-blur border border-slate-200 p-5 ${className}`}>
      {children}
    </div>
  );
}

function PrimaryButton({ children, ...rest }) {
  return (
    <button
      className="inline-flex items-center gap-2 px-4 py-2 rounded-xl shadow bg-indigo-600 text-white hover:bg-indigo-700 active:scale-[0.99]"
      {...rest}
    >
      {children}
    </button>
  );
}

function GhostButton({ children, ...rest }) {
  return (
    <button className="inline-flex items-center gap-2 px-4 py-2 rounded-xl border border-slate-300 hover:bg-slate-50" {...rest}>
      {children}
    </button>
  );
}

function SectionTitle({ icon: Icon, title, subtitle }) {
  return (
    <div className="flex items-center gap-3 mb-3">
      {Icon && <Icon className="w-5 h-5 text-slate-500" />}
      <div>
        <div className="text-slate-900 font-semibold">{title}</div>
        {subtitle && <div className="text-slate-500 text-sm">{subtitle}</div>}
      </div>
    </div>
  );
}

function Podium({ players }) {
  const podium = players.slice(0, 3);
  return (
    <div className="grid grid-cols-3 gap-4 items-end mt-6">
      {podium.map((p, i) => (
        <motion.div key={p.id} initial={{ y: 20, opacity: 0 }} animate={{ y: 0, opacity: 1 }} className="text-center">
          <div className={`mx-auto w-20 h-20 rounded-full ring-4 ring-yellow-400 overflow-hidden`}> 
            <img alt="avatar" src={p.avatar} className="w-full h-full object-cover" />
          </div>
          <div className="mt-2 font-medium">{p.name}</div>
          <div className="text-slate-500 text-sm">{i === 0 ? "🥇" : i === 1 ? "🥈" : "🥉"} {p.score}</div>
        </motion.div>
      ))}
    </div>
  );
}

function TinyRank({ players }) {
  return (
    <div className="mt-3">
      <SectionTitle icon={Trophy} title="目前排行榜 (Top 10)" />
      <div className="space-y-2">
        {players.slice(0, 10).map((p, i) => (
          <div key={p.id} className="flex items-center justify-between bg-slate-50 rounded-xl px-3 py-2">
            <div className="flex items-center gap-2">
              <span className="w-6 text-right font-semibold">{i + 1}</span>
              <img src={p.avatar} alt="av" className="w-7 h-7 rounded-full" />
              <span className="truncate max-w-[12rem]">{p.name}</span>
            </div>
            <div className="font-mono">{p.score}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ========================= 主持端 =========================
function HostSetup({ onCreated }) {
  const [hostName, setHostName] = useState("");
  const [creating, setCreating] = useState(false);
  const [checking, setChecking] = useState(false);
  const [health, setHealth] = useState(null); // 'ok' | 'fail' | null
  const [healthMsg, setHealthMsg] = useState("");

  async function doHealthCheck() {
    if (!db) {
      setHealth('fail');
      setHealthMsg('Firebase 尚未初始化，請先填入 FIREBASE_CONFIG');
      return;
    }
    try {
      setChecking(true);
      // 嘗試寫入與讀取一筆測試資料
      const pingRef = doc(db, "_health", "ping");
      await setDoc(pingRef, { clientAt: new Date().toISOString(), serverAt: serverTimestamp() }, { merge: true });
      const got = await getDoc(pingRef);
      if (got.exists()) {
        setHealth('ok');
        setHealthMsg('Firestore 已啟用且可讀寫');
      } else {
        setHealth('fail');
        setHealthMsg('無法讀回測試文件');
      }
    } catch (e) {
      setHealth('fail');
      setHealthMsg(e.message || '未知錯誤');
    } finally {
      setChecking(false);
    }
  }

  return (
    <Card className="max-w-xl mx-auto mt-8">
      <SectionTitle icon={Settings} title="建立新的遊戲" subtitle="輸入主持人名稱，立即產生房號與預設 10 題。" />
      <div className="space-y-4">
        <input
          className="w-full border rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-indigo-400"
          placeholder="主持人名稱"
          value={hostName}
          onChange={(e) => setHostName(e.target.value)}
        />
        <div className="flex items-center gap-2 flex-wrap">
          <PrimaryButton
            onClick={async () => {
              try {
                setCreating(true);
                const created = await createGame(hostName || "主持人");
                onCreated(created);
              } catch (e) {
                alert("建立失敗：" + e.message);
              } finally {
                setCreating(false);
              }
            }}
            disabled={!db || creating}
          >
            {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />} 建立遊戲
          </PrimaryButton>

          <GhostButton onClick={async () => { if (!db) { setHealth('fail'); setHealthMsg('Firebase 尚未初始化，請先填入 FIREBASE_CONFIG'); alert('Firebase 尚未初始化，請先在程式頂部填入 FIREBASE_CONFIG 並重新整理。'); return; } await doHealthCheck(); }} disabled={checking}>
            {checking ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />} 測試 Firestore
          </GhostButton>

          {health && (
            <span className={`text-sm px-2 py-1 rounded-md ${health === 'ok' ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'}`}>
              {health === 'ok' ? '✅ ' : '❌ '}{healthMsg}
            </span>
          )}
        </div>

        {!db && (
          <div className="text-sm text-rose-600">
            ⚠️ 尚未設定 Firebase：請在檔案頂部填入 FIREBASE_CONFIG 後重新整理。
          </div>
        )}
      </div>
    </Card>
  );
}

function HostConsole({ gameId, hostSecret }) {
  const [game, setGame] = useState(null);
  const [players, setPlayers] = useState([]);
  const [questions, setQuestions] = useState([]);
  const [showPin, setShowPin] = useState(true);
  const [editingIdx, setEditingIdx] = useState(null);

  useEffect(() => {
    const gref = doc(db, "games", gameId);
    const unsub = onSnapshot(gref, (snap) => setGame({ id: snap.id, ...snap.data() }));
    const unsubP = onSnapshot(collection(db, "games", gameId, "players"), (snap) => {
      const arr = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      arr.sort((a, b) => (b.score || 0) - (a.score || 0));
      setPlayers(arr);
    });
    const unsubQ = onSnapshot(collection(db, "games", gameId, "questions"), (snap) => {
      const arr = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      arr.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      setQuestions(arr);
    });
    return () => { unsub(); unsubP(); unsubQ(); };
  }, [gameId]);

  const joinUrl = useMemo(() => {
    const base = window.location.origin + window.location.pathname;
    const u = new URL(base);
    u.searchParams.set("join", game?.pin || "");
    return u.toString();
  }, [game]);

  const currentQ = useMemo(() => {
    if (!game) return null;
    return questions.find((q) => Number(q.index) === Number(game.currentQuestionIndex));
  }, [questions, game]);

  if (!game) return null;

  const canStart = game.status === "lobby" && questions.length > 0;

  return (
    <div className="max-w-6xl mx-auto p-4">
      <div className="grid md:grid-cols-3 gap-4">
        <Card className="md:col-span-2 bg-gradient-to-br from-indigo-50 to-sky-50">
          <div className="flex items-start justify-between">
            <div>
              <div className="text-2xl font-bold">🎉 Kahoot 風格小測驗</div>
              <div className="text-slate-500">Game ID: <span className="font-mono">{gameId}</span></div>
              <div className="text-slate-500">主持人：{game.hostName}</div>
            </div>
            <GhostButton onClick={() => setShowPin((s) => !s)}>
              {showPin ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />} 顯示/隱藏 QR
            </GhostButton>
          </div>

          {showPin && (
            <div className="grid md:grid-cols-2 gap-4 mt-4 items-center">
              <div className="space-y-2">
                <div className="text-slate-600">玩家掃描 QR 碼加入：</div>
                <div className="p-4 bg-white rounded-2xl w-fit shadow border border-slate-200">
                  <QRCodeCanvas value={joinUrl} size={180} includeMargin={true} />
                </div>
                <div className="text-slate-600 text-sm">或開啟此連結：
                  <a className="text-indigo-600 underline break-all" href={joinUrl} target="_blank" rel="noreferrer">{joinUrl}</a>
                </div>
                <div className="flex items-center gap-2 mt-2">
                  <GhostButton onClick={() => toggleJoin(gameId, !game.allowJoin)}>
                    {game.allowJoin ? <LockOpenIcon /> : <LockIcon />} {game.allowJoin ? "暫停加入" : "允許加入"}
                  </GhostButton>
                </div>
              </div>
              <div className="text-center">
                <div className="text-slate-700">房號 (PIN)</div>
                <div className="text-5xl font-black tracking-widest">{game.pin}</div>
                <div className="text-slate-500 mt-2">目前玩家：{players.length}</div>
                <div className="mt-3">
                  <PrimaryButton
                    disabled={!canStart}
                    onClick={() => startQuestion(gameId, 0)}
                  >
                    <Play className="w-4 h-4" /> 開始遊戲
                  </PrimaryButton>
                </div>
              </div>
            </div>
          )}

          {game.status !== "lobby" && (
            <div className="mt-4">
              <SectionTitle icon={Flame} title={`題目 ${game.currentQuestionIndex + 1} / ${questions.length}`} subtitle={currentQ?.text} />
              {currentQ && (
                <div className="grid md:grid-cols-2 gap-3">
                  {currentQ.options?.map((opt, i) => (
                    <div key={i} className={`rounded-xl px-4 py-3 border ${game.revealAnswer && currentQ.correctIndex === i ? "border-emerald-500 bg-emerald-50" : "border-slate-200 bg-white"}`}>
                      <div className="font-medium">{String.fromCharCode(65 + i)}. {opt}</div>
                    </div>
                  ))}
                </div>
              )}

              <div className="flex gap-2 mt-4 flex-wrap">
                {game.status === "question" && (
                  <PrimaryButton onClick={() => endQuestion(gameId)}>
                    <Square className="w-4 h-4" /> 結束作答
                  </PrimaryButton>
                )}
                {game.status === "review" && (
                  <PrimaryButton onClick={() => scoreQuestion(gameId)}>
                    <CheckCircle2 className="w-4 h-4" /> 揭示答案並計分
                  </PrimaryButton>
                )}
                {game.status === "scoreboard" && (
                  <PrimaryButton onClick={() => nextQuestion(gameId)}>
                    <ChevronRight className="w-4 h-4" /> 下一題
                  </PrimaryButton>
                )}
              </div>

              {game.status === "scoreboard" && (
                <TinyRank players={players} />
              )}
            </div>
          )}
        </Card>

        <Card>
          <SectionTitle icon={Users} title="玩家名單" subtitle="最多可同時 100 人參與。" />
          <div className="max-h-[52vh] overflow-auto space-y-2 pr-1">
            {players.map((p, i) => (
              <div key={p.id} className="flex items-center justify-between bg-slate-50 rounded-xl px-3 py-2 border border-slate-200">
                <div className="flex items-center gap-2">
                  <span className="w-6 text-right text-slate-500">{i + 1}</span>
                  <img src={p.avatar} className="w-7 h-7 rounded-full" />
                  <span className="truncate max-w-[10rem]">{p.name}</span>
                </div>
                <div className="font-mono text-sm">{p.score}</div>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <Card className="mt-4">
        <SectionTitle icon={Settings} title="題庫編輯" subtitle="點選題目即可編輯；也可新增刪除。" />
        <div className="space-y-3">
          {questions.map((q, idx) => (
            <div key={q.id} className="border rounded-xl p-3">
              {editingIdx === idx ? (
                <QuestionEditor
                  value={q}
                  onCancel={() => setEditingIdx(null)}
                  onSave={async (val) => {
                    await updateDoc(doc(db, "games", gameId, "questions", String(q.index)), val);
                    setEditingIdx(null);
                  }}
                  onDelete={async () => {
                    await deleteDoc(doc(db, "games", gameId, "questions", String(q.index)));
                    setEditingIdx(null);
                  }}
                />
              ) : (
                <div className="flex items-start justify-between">
                  <div>
                    <div className="font-medium">第 {idx + 1} 題：{q.text}</div>
                    <div className="text-sm text-slate-600">作答秒數：{q.durationSec}s ・ 正解：{String.fromCharCode(65 + q.correctIndex)}</div>
                  </div>
                  <GhostButton onClick={() => setEditingIdx(idx)}>
                    編輯
                  </GhostButton>
                </div>
              )}
            </div>
          ))}
          <div className="flex gap-2">
            <GhostButton onClick={async () => {
              const index = questions.length;
              await setDoc(doc(db, "games", gameId, "questions", String(index)), {
                index,
                text: "新題目",
                options: ["A", "B", "C", "D"],
                correctIndex: 0,
                durationSec: 15,
              });
            }}>
              <PlusIcon /> 新增題目
            </GhostButton>
            <GhostButton onClick={async () => {
              // 亂序選項小工具
              const batch = await getDocs(collection(db, "games", gameId, "questions"));
              for (const d of batch.docs) {
                const qd = d.data();
                const old = qd.options.map((v, i) => ({ v, i }));
                old.sort(() => Math.random() - 0.5);
                const newOpts = old.map((o) => o.v);
                const newCorrect = old.findIndex((o) => o.i === qd.correctIndex);
                await updateDoc(d.ref, { options: newOpts, correctIndex: newCorrect });
              }
              alert("已隨機打亂各題選項順序");
            }}>
              <Shuffle className="w-4 h-4" /> 亂序全部選項
            </GhostButton>
          </div>
        </div>
      </Card>

      {game.status === "finished" && (
        <Card className="mt-4">
          <SectionTitle icon={Crown} title="總排名" subtitle="恭喜前三名！" />
          <Podium players={players} />
        </Card>
      )}
    </div>
  );
}

function QuestionEditor({ value, onSave, onCancel, onDelete }) {
  const [text, setText] = useState(value.text || "");
  const [options, setOptions] = useState(value.options || ["A", "B", "C", "D"]);
  const [correctIndex, setCorrectIndex] = useState(value.correctIndex ?? 0);
  const [durationSec, setDurationSec] = useState(value.durationSec || 15);

  return (
    <div className="space-y-3">
      <input className="w-full border rounded-xl px-3 py-2" value={text} onChange={(e) => setText(e.target.value)} />
      <div className="grid md:grid-cols-2 gap-2">
        {options.map((opt, i) => (
          <div key={i} className={`flex items-center gap-2 border rounded-xl px-3 py-2 ${i === correctIndex ? "border-emerald-500 bg-emerald-50" : "border-slate-200"}`}>
            <span className="font-mono">{String.fromCharCode(65 + i)}</span>
            <input className="flex-1 outline-none" value={opt} onChange={(e) => setOptions((arr) => arr.map((o, idx) => (idx === i ? e.target.value : o)))} />
            <input type="radio" name="correct" checked={i === correctIndex} onChange={() => setCorrectIndex(i)} />
          </div>
        ))}
      </div>
      <div className="flex items-center gap-3">
        <label className="text-sm text-slate-600">作答秒數</label>
        <input type="number" min={5} max={90} className="border rounded-xl px-2 py-1 w-24" value={durationSec} onChange={(e) => setDurationSec(Number(e.target.value))} />
      </div>
      <div className="flex gap-2">
        <PrimaryButton onClick={() => onSave({ text, options, correctIndex, durationSec })}>
          <CheckCircle2 className="w-4 h-4" /> 儲存
        </PrimaryButton>
        <GhostButton onClick={onCancel}>取消</GhostButton>
        <GhostButton onClick={onDelete}>
          <Trash2 className="w-4 h-4" /> 刪除此題
        </GhostButton>
      </div>
    </div>
  );
}

// ========================= 玩家端 =========================
function PlayerJoin() {
  const [pin, setPin] = useState(new URLSearchParams(window.location.search).get("join") || "");
  const [name, setName] = useState("");
  const [avatar, setAvatar] = useState("");
  const [joining, setJoining] = useState(false);
  const [joined, setJoined] = useState(null); // { gameId, playerId }

  if (joined) return <PlayerRoom {...joined} name={name} avatar={avatar} />;

  return (
    <Card className="max-w-md mx-auto mt-10">
      <SectionTitle icon={Users} title="加入遊戲" subtitle="輸入房號 (PIN) 與暱稱。" />
      <div className="space-y-3">
        <input className="w-full border rounded-xl px-4 py-3" placeholder="房號 6 碼" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))} />
        <input className="w-full border rounded-xl px-4 py-3" placeholder="暱稱" value={name} onChange={(e) => {
          setName(e.target.value);
          setAvatar(avatarUrlFor(e.target.value));
        }} />
        <div className="flex items-center gap-3">
          <img src={avatar || avatarUrlFor(name)} className="w-12 h-12 rounded-full border" />
          <GhostButton onClick={() => setAvatar(avatarUrlFor(name + Math.random()))}><ImageIcon className="w-4 h-4" /> 換一張頭像</GhostButton>
        </div>
        <PrimaryButton
          disabled={!db || !pin || !name || joining}
          onClick={async () => {
            try {
              setJoining(true);
              const j = await joinGameByPin(pin, name, avatar || avatarUrlFor(name));
              setJoined(j);
            } catch (e) {
              alert(e.message);
            } finally {
              setJoining(false);
            }
          }}
        >
          {joining ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} 加入
        </PrimaryButton>
        {!db && <div className="text-sm text-rose-600">⚠️ Firebase 未設定，無法連線。</div>}
      </div>
    </Card>
  );
}

function PlayerRoom({ gameId, playerId, name, avatar }) {
  const [game, setGame] = useState(null);
  const [question, setQuestion] = useState(null);
  const [answering, setAnswering] = useState(false);
  const [picked, setPicked] = useState(null);
  const [players, setPlayers] = useState([]);

  useEffect(() => {
    const gref = doc(db, "games", gameId);
    const unsub = onSnapshot(gref, async (snap) => {
      const g = { id: snap.id, ...snap.data() };
      setGame(g);
      if (g.status === "question") {
        const qref = doc(db, "games", gameId, "questions", String(g.currentQuestionIndex));
        const qdoc = await getDoc(qref);
        setQuestion({ id: qdoc.id, ...qdoc.data() });
        setAnswering(true);
        setPicked(null);
      }
    });
    const unsubP = onSnapshot(collection(db, "games", gameId, "players"), (snap) => {
      const arr = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      arr.sort((a, b) => (b.score || 0) - (a.score || 0));
      setPlayers(arr);
    });
    return () => { unsub(); unsubP(); };
  }, [gameId]);

  if (!game) return null;

  const isQuestion = game.status === "question" && question;
  const isScoreboard = game.status === "scoreboard";
  const isFinished = game.status === "finished";

  return (
    <div className="max-w-3xl mx-auto p-4">
      <Card>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img src={avatar} className="w-10 h-10 rounded-full" />
            <div>
              <div className="font-semibold">{name}</div>
              <div className="text-sm text-slate-500">房號：{game.pin}</div>
            </div>
          </div>
          <div className="text-sm text-slate-500">狀態：{game.status}</div>
        </div>
      </Card>

      {isQuestion && (
        <Card className="mt-4">
          <SectionTitle icon={Flame} title={`題目：${question.text}`} subtitle={`限時 ${question.durationSec}s`} />
          <div className="grid md:grid-cols-2 gap-3">
            {question.options?.map((opt, i) => (
              <button
                key={i}
                disabled={!answering}
                onClick={async () => {
                  if (picked !== null) return;
                  setPicked(i);
                  setAnswering(false);
                  await submitAnswer(gameId, playerId, question.index, i);
                }}
                className={`text-left rounded-xl px-4 py-3 border hover:shadow transition ${picked === i ? "border-indigo-500 ring-2 ring-indigo-200" : "border-slate-200"}`}
              >
                <div className="font-medium">{String.fromCharCode(65 + i)}. {opt}</div>
              </button>
            ))}
          </div>
          <div className="mt-3 text-sm text-slate-500">越快提交，正確時可獲得更多加分！</div>
        </Card>
      )}

      {isScoreboard && (
        <Card className="mt-4">
          <SectionTitle icon={Trophy} title="題後排名" subtitle="本題結束後的暫時排行榜。" />
          <TinyRank players={players} />
        </Card>
      )}

      {isFinished && (
        <Card className="mt-4">
          <SectionTitle icon={Crown} title="最終排名" subtitle="恭喜所有參賽者！" />
          <Podium players={players} />
        </Card>
      )}
    </div>
  );
}

// ========================= 小圖示（Tailwind-only） =========================
function PlusIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-plus"><path d="M5 12h14"/><path d="M12 5v14"/></svg>
  );
}
function LockIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-lock"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
  );
}
function LockOpenIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-lock-open"><path d="M3 11V7a5 5 0 0 1 9.9-1"/><rect x="3" y="11" width="18" height="11" rx="2"/></svg>
  );
}

// ========================= App Root =========================
export default function KahootLiteApp() {
  const [mode, setMode] = useState(() => {
    const join = new URLSearchParams(window.location.search).get("join");
    return join ? "player" : "host";
  });

  return (
    <div className="min-h-screen bg-gradient-to-br from-violet-100 via-sky-100 to-emerald-100">
      <header className="max-w-6xl mx-auto p-4 flex items-center justify-between">
        <div className="text-xl font-bold">Kahoot 風格小測驗</div>
        <div className="flex gap-2">
          <GhostButton onClick={() => setMode("host")}>主持端</GhostButton>
          <GhostButton onClick={() => setMode("player")}>玩家端</GhostButton>
        </div>
      </header>

      {mode === "host" ? (
        <HostGate />
      ) : (
        <PlayerJoin />
      )}

      <footer className="max-w-6xl mx-auto p-4 text-center text-sm text-slate-600">
        開源示例。建議使用 Firebase Firestore 作為後端，GitHub Pages 作為前端靜態託管。
      </footer>
    </div>
  );
}

function HostGate() {
  const [created, setCreated] = useState(null);
  if (!created) return <HostSetup onCreated={setCreated} />;
  return <HostConsole gameId={created.id} hostSecret={created.hostSecret} />;
}
