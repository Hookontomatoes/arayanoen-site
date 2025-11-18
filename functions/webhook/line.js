// functions/webhook/line.js
// LINE Webhook（Cloudflare Pages Functions）
//
// 大原則:
//  - FAQスプレッドシート（env.SHEET_CSV_URL）
//  - HP / STORES / note 等（env.ALLOW_URLS）
// に書いてある内容だけから回答する。
//   → 事実は必ずこれらのどこかに実在するものだけ。
//   → 表現の多少の言い換えは許容するが、事実は変えない。

const LINE_REPLY_ENDPOINT = "https://api.line.me/v2/bot/message/reply";

// 同義語グループ（マッチング専用）
const SYNONYM_GROUPS = [
  ["開業", "創業"],
  ["送料", "配送料", "配送費"],
  // 必要に応じて追加してください。
];

// FAQ マッチングの最低類似度（0〜1）
const MIN_FAQ_SCORE = 0.45;

// note 記事との最低類似度（0〜1）
const MIN_NOTE_SCORE = 0.15;

/** HMAC-SHA256 (base64) */
async function sign(secret, bodyText) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(bodyText));
  let binary = "";
  const bytes = new Uint8Array(sig);
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** 質問文に同義語を足す（マッチング専用。回答文は改変しない） */
function expandWithSynonyms(text) {
  if (!text) return "";
  const base = String(text);
  let result = base;

  for (const group of SYNONYM_GROUPS) {
    let hit = false;
    for (const w of group) {
      if (base.includes(w)) {
        hit = true;
        break;
      }
    }
    if (hit) {
      for (const w of group) {
        if (!result.includes(w)) {
          result += " " + w;
        }
      }
    }
  }
  return result;
}

/**
 * FAQ CSV を読み込む。
 *
 * 列の想定:
 *   - question   … 質問文（あればマッチングに使用）
 *   - answer     … 回答文
 *   - visibility … public の行だけ回答候補にする（無ければすべて public 扱い）
 *   - その他の列 … マッチングにも回答にも使わない（source_url_or_note など）
 */
async function loadFaqCsv(csvUrl) {
  const res = await fetch(csvUrl, { cf: { cacheTtl: 60, cacheEverything: true } });
  if (!res.ok) {
    throw new Error(`CSV fetch failed: ${res.status}`);
  }
  const text = await res.text();

  // 簡易 CSV パーサ（ダブルクォート対応）
  const rows = [];
  let i = 0;
  let field = "";
  let inQuote = false;
  let row = [];

  while (i < text.length) {
    const c = text[i];
    if (inQuote) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i += 2;
        continue;
      }
      if (c === '"') {
        inQuote = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    } else {
      if (c === '"') {
        inQuote = true;
        i++;
        continue;
      }
      if (c === ",") {
        row.push(field);
        field = "";
        i++;
        continue;
      }
      if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") {
          i++;
        }
        row.push(field);
        rows.push(row);
        field = "";
        row = [];
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
  }
  row.push(field);
  rows.push(row);

  if (rows.length <= 1) return [];

  const header = rows.shift().map(h => h.trim().toLowerCase());
  const headerIdx = (name) => header.findIndex(h => h === name.toLowerCase());

  const vIdx = headerIdx("visibility");
  const qIdx = headerIdx("question");
  let aIdx = headerIdx("answer");
  if (aIdx === -1) {
    // 互換用: 4列目を answer とみなす
    aIdx = 3;
  }

  const items = rows
    .map(r => {
      const cols = r.map(c => (c ?? "").trim());

      // visibility
      let visibility = "public";
      if (vIdx >= 0 && vIdx < cols.length) {
        const v = (cols[vIdx] || "").trim().toLowerCase();
        if (v) visibility = v;
      }

      const answer = aIdx < cols.length ? (cols[aIdx] || "").trim() : "";
      const question = qIdx >= 0 && qIdx < cols.length ? (cols[qIdx] || "").trim() : "";
      const joined = cols.join(" ").replace(/\s+/g, " ");

      return { answer, question, visibility, joined };
    })
    .filter(x => x.visibility === "public" && x.answer);

  return items;
}

/** 日本語テキストをマッチング用に正規化 */
function normalizeJa(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[！!？?。、．，,・･「」『』【】［］\[\]\(\)（）\s]/g, "")
    .trim();
}

/** ２文字ずつの共通度で類似度（0〜1）を出す */
function bigramSimilarity(a, b) {
  const na = normalizeJa(a);
  const nb = normalizeJa(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;

  const grams = new Set();
  for (let i = 0; i < na.length - 1; i++) {
    grams.add(na.slice(i, i + 2));
  }
  if (!grams.size) return 0;

  let hit = 0;
  for (let i = 0; i < nb.length - 1; i++) {
    const g = nb.slice(i, i + 2);
    if (grams.has(g)) {
      hit++;
    }
  }
  const denom = Math.max(na.length - 1, nb.length - 1);
  return denom > 0 ? hit / denom : 0;
}

/** FAQ 1行に対する一致度（0〜1） */
function scoreFaqItem(item, userText) {
  const target = item.question || item.joined || "";
  return bigramSimilarity(userText, target);
}

/** HTML → プレーンテキスト */
function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/** プレーンテキストから「質問に近い一文」を抜き出す（note 用） */
function extractBestSentence(plainText, userText) {
  const sentences = plainText
    .split(/[。！？!?]/)
    .map(s => s.trim())
    .filter(Boolean);

  if (!sentences.length) return null;

  let best = null;
  let bestScore = 0;

  for (const s of sentences) {
    const sc = bigramSimilarity(userText, s);
    if (sc > bestScore) {
      bestScore = sc;
      best = s;
    }
  }

  if (!best || bestScore === 0) return null;

  // 長すぎる場合は少しだけ丸める（事実は変わらない範囲）
  if (best.length > 120) {
    return best.slice(0, 120) + "…";
  }
  return best;
}

/**
 * note の RSS から記事一覧を取得し、
 * ユーザーの質問に一番近い記事と一文を探す。
 *
 * notePattern: 例) "https://note.com/araya_noen2018/*"
 */
async function searchNoteFromWildcard(notePattern, userText) {
  // パターンからユーザー名を抽出
  // https://note.com/ユーザー名/*
  const m = notePattern.match(/^https?:\/\/note\.com\/([^\/\s]+)\/\*$/);
  if (!m) return null;
  const user = m[1];

  const rssUrl = `https://note.com/${encodeURIComponent(user)}/rss`;

  let rssRes;
  try {
    rssRes = await fetch(rssUrl, { cf: { cacheTtl: 300, cacheEverything: true } });
  } catch {
    return null;
  }
  if (!rssRes.ok) return null;

  const rssText = await rssRes.text();

  // <item> ごとにリンクを抜き出す（/n/ を含む記事だけ）
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let itemMatch;
  while ((itemMatch = itemRe.exec(rssText)) !== null) {
    const block = itemMatch[1];
    const linkMatch = block.match(/<link>([^<]+)<\/link>/);
    if (!linkMatch) continue;
    const url = linkMatch[1].trim();
    if (!url.startsWith("http")) continue;
    if (!url.includes("/n/")) continue; // 記事URLだけ
    items.push(url);
  }

  if (!items.length) return null;

  // 取得する記事数に上限を設ける（最新10件）
  const targetUrls = items.slice(0, 10);

  let bestUrl = null;
  let bestScore = 0;
  let bestSnippet = null;

  for (const url of targetUrls) {
    let res;
    try {
      res = await fetch(url, { cf: { cacheTtl: 300, cacheEverything: true } });
    } catch {
      continue;
    }
    if (!res.ok) continue;

    let html;
    try {
      html = await res.text();
    } catch {
      continue;
    }

    const plain = htmlToText(html);
    if (!plain) continue;

    const score = bigramSimilarity(userText, plain);
    if (score <= 0) continue;

    const snippet = extractBestSentence(plain, userText);

    if (score > bestScore) {
      bestScore = score;
      bestUrl = url;
      bestSnippet = snippet;
    }
  }

  if (!bestUrl || bestScore < MIN_NOTE_SCORE) {
    return null;
  }

  return {
    url: bestUrl,
    snippet: bestSnippet,
    score: bestScore
  };
}

/**
 * ALLOW_URLS に書かれたページから回答候補を探す。
 *  - note のワイルドカードパターン: `https://note.com/ユーザー名/*`
 *  - それ以外: 固定URLページをそのまま取得してスコアリング
 */
async function findAnswerFromPages(env, expandedText) {
  const allowList = (env.ALLOW_URLS || "")
    .split(/[\s,]+/)
    .map(u => u.trim())
    .filter(Boolean);

  if (!allowList.length) return null;

  const userText = expandedText || "";
  const queryNorm = normalizeJa(userText);
  if (!queryNorm || queryNorm.length < 2) return null;

  // まず note のワイルドカードを優先的に検索
  let bestNote = null;
  for (const pattern of allowList) {
    if (/^https?:\/\/note\.com\/[^\/\s]+\/\*$/.test(pattern)) {
      const r = await searchNoteFromWildcard(pattern, userText);
      if (r && (!bestNote || r.score > bestNote.score)) {
        bestNote = r;
      }
    }
  }
  if (bestNote) {
    // note については、一番近い一文 + リンクを返す
    const text = bestNote.snippet
      ? bestNote.snippet
      : "この内容については、こちらの記事をご覧ください。";
    return { text, url: bestNote.url };
  }

  // 通常ページ (HP / STORES など)
  let bestUrl = null;
  let bestScore = 0;

  for (const pattern of allowList) {
    // note のワイルドカードは上で処理済み
    if (/^https?:\/\/note\.com\/[^\/\s]+\/\*$/.test(pattern)) {
      continue;
    }

    let res;
    try {
      res = await fetch(pattern, { cf: { cacheTtl: 300, cacheEverything: true } });
    } catch {
      continue;
    }
    if (!res.ok) continue;

    let html;
    try {
      html = await res.text();
    } catch {
      continue;
    }
    const plain = htmlToText(html);
    if (!plain) continue;

    const score = bigramSimilarity(userText, plain);
    if (score > bestScore) {
      bestScore = score;
      bestUrl = pattern;
    }
  }

  if (!bestUrl || bestScore === 0) {
    return null;
  }

  return {
    text: "この内容については、こちらのページをご覧ください。",
    url: bestUrl
  };
}

/**
 * 質問 → 回答
 * 1. FAQ シートから最も近い Q&A を探す
 * 2. 見つからなければ ALLOW_URLS（HP / note / STORES）を検索
 * 3. それでも無ければ「見つかりません」メッセージ
 */
async function findAnswer(env, userText) {
  const raw = userText || "";
  const expanded = expandWithSynonyms(raw);

  // 1. FAQ
  const items = await loadFaqCsv(env.SHEET_CSV_URL);

  let best = null;
  let bestScore = -1;
  for (const it of items) {
    const sc = scoreFaqItem(it, raw);
    if (sc > bestScore) {
      best = it;
      bestScore = sc;
    }
  }

  if (best && bestScore >= MIN_FAQ_SCORE) {
    // FAQ の answer はそのまま返す
    return { text: best.answer, url: null };
  }

  // 2. ページ群 (HP / note / STORES)
  const pageAnswer = await findAnswerFromPages(env, expanded);
  if (pageAnswer) {
    return pageAnswer;
  }

  // 3. どこにも見つからなかった場合
  return {
    text: "該当する回答が見つかりませんでした。よろしければ、キーワードを変えてもう一度お試しください。担当者への取次も可能です。",
    url: null
  };
}

/** LINE 返信（URL ボタン対応） */
async function replyToLINE(token, replyToken, text, url = null) {
  let messages;

  if (url) {
    // URL がある場合はボタンテンプレート
    messages = [
      {
        type: "template",
        altText: text,
        template: {
          type: "buttons",
          text: text.length > 60 ? text.substring(0, 60) : text,
          actions: [
            {
              type: "uri",
              label: "詳細を見る",
              uri: url
            }
          ]
        }
      }
    ];
  } else {
    // 通常テキストのみ
    messages = [{ type: "text", text }];
  }

  const body = { replyToken, messages };

  const res = await fetch(LINE_REPLY_ENDPOINT, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`LINE reply failed: ${res.status} ${t}`);
  }
}

/** POST: Webhook 本体 */
export async function onRequestPost({ request, env }) {
  const rawBody = await request.text();

  // 署名検証
  const sigHeader = request.headers.get("x-line-signature") || "";
  const expected = await sign(env.LINE_CHANNEL_SECRET, rawBody);
  if (sigHeader !== expected) {
    return new Response("signature mismatch", { status: 400 });
  }

  const body = JSON.parse(rawBody);

  for (const ev of body.events || []) {
    if (ev.type === "message" && ev.message && ev.message.type === "text") {
      try {
        const answer = await findAnswer(env, ev.message.text || "");
        await replyToLINE(env.LINE_CHANNEL_TOKEN, ev.replyToken, answer.text, answer.url);
      } catch (e) {
        await replyToLINE(
          env.LINE_CHANNEL_TOKEN,
          ev.replyToken,
          "内部処理でエラーが発生しました。お手数ですが、時間をおいて再度お試しください。"
        );
      }
    } else {
      if (ev.replyToken) {
        await replyToLINE(
          env.LINE_CHANNEL_TOKEN,
          ev.replyToken,
          "テキストでご質問ください。"
        );
      }
    }
  }

  return new Response("OK", { status: 200 });
}

/** GET: 疎通確認用 */
export async function onRequestGet() {
  return new Response("OK", { status: 200 });
}
