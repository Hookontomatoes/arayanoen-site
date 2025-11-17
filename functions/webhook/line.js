// functions/webhook/line.js
// LINE Webhook（Cloudflare Pages Functions）
//
// 大原則:
//  - FAQスプレッドシート（env.SHEET_CSV_URL）
//  - HP / 公式LINE / STORES / note 等（env.ALLOW_URLS）
// に書いてある内容だけから回答する。

const LINE_REPLY_ENDPOINT = "https://api.line.me/v2/bot/message/reply";

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
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/**
 * FAQ CSV を読み込む。
 *
 * 列配置（1行目はヘッダ想定だが、名前は厳密には使わない）:
 *   A: id
 *   B: category
 *   C: question
 *   D: answer  ← ここを「回答」として返す
 *   E: keywords(optional)
 *   F: LINE/SN
 *   G: source_url_or_note
 *   ...
 *   L: visibility（public の行だけ有効）
 *
 * マッチングは「その行の全セルを結合したテキスト」に対して行う。
 */
async function loadFaqCsv(csvUrl) {
  const res = await fetch(csvUrl, { cf: { cacheTtl: 60, cacheEverything: true } });
  if (!res.ok) throw new Error(`CSV fetch failed: ${res.status}`);
  const text = await res.text();

  // 簡易 CSV パーサ（ダブルクォート対応）
  const rows = [];
  let i = 0, field = "", inQuote = false, row = [];
  while (i < text.length) {
    const c = text[i];
    if (inQuote) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i += 2; continue; }
      if (c === '"') { inQuote = false; i++; continue; }
      field += c; i++; continue;
    } else {
      if (c === '"') { inQuote = true; i++; continue; }
      if (c === ",") { row.push(field); field = ""; i++; continue; }
      if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(field); rows.push(row); field = ""; row = []; i++; continue;
      }
      field += c; i++; continue;
    }
  }
  row.push(field); rows.push(row);

  if (rows.length <= 1) return [];

  // 1行目はヘッダとして捨てる（列名はほぼ使わない）
  const header = rows.shift().map(h => h.trim().toLowerCase());
  const headerIdx = (name) => header.findIndex(h => h === name.toLowerCase());

  // visibility 列の位置（無ければ -1）
  const vIdx = headerIdx("visibility");

  // answer 列の位置：ヘッダに answer が無ければ「D列（インデックス3）」を使う
  let aIdx = headerIdx("answer");
  if (aIdx === -1) aIdx = 3; // 0:A,1:B,2:C,3:D

  // source 列（任意）
  let sIdx = headerIdx("source_url_or_note");
  if (sIdx === -1) sIdx = -1;

  const items = rows
    .map(r => {
      const cols = r.map(c => (c ?? "").trim());

      // 可視性
      let visibility = "public";
      if (vIdx >= 0 && vIdx < cols.length) {
        const v = (cols[vIdx] || "").trim().toLowerCase();
        if (v) visibility = v;
      }

      // 回答（D列前提 / または answer 列）
      const answer = aIdx < cols.length ? (cols[aIdx] || "").trim() : "";

      // 出典
      const source = sIdx >= 0 && sIdx < cols.length ? (cols[sIdx] || "").trim() : "";

      // 行全体テキスト（カテゴリ・質問・回答・キーワードなど全部）
      const joined = cols.join(" ").replace(/\s+/g, " ").toLowerCase();

      return { answer, source, visibility, joined };
    })
    .filter(x => x.visibility === "public" && x.answer);

  return items;
}

/**
 * FAQ 1 行に対する一致度。
 * 「行全体テキスト joined に、ユーザー入力が含まれているか」で見るだけの単純版。
 */
function scoreFaqItem(item, text) {
  const q = (text || "").toLowerCase().trim();
  if (!q) return 0;
  if (!item.joined) return 0;
  return item.joined.includes(q) ? q.length + 1 : 0;
}

/** HTML → プレーンテキスト（HP／STORES／note 用） */
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

/** 日本語テキストをマッチング用に正規化 */
function normalizeJa(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[！!？?。、．，,・･「」『』【】［］\[\]\(\)（）\s]/g, "")
    .trim();
}

/**
 * env.ALLOW_URLS に列挙した URL 群（HP / 公式LINE案内ページ / STORES商品ページ / note 記事など）
 * からテキストを取得し、質問文と近いページを一つ選んで返す。
 *
 * 「改行」だけでなく「カンマ」区切りにも対応。
 * 例:
 *   https://a.example.com/,
 *   https://b.example.com/,
 */
async function findAnswerFromPages(env, userText) {
  const urls = (env.ALLOW_URLS || "")
    .split(/[\s,]+/)          // 改行・スペース・カンマ すべて区切りとみなす
    .map(u => u.trim())
    .filter(Boolean);

  if (!urls.length) return null;

  const queryNorm = normalizeJa(userText);
  if (!queryNorm || queryNorm.length < 2) return null;

  // 質問文の二文字ずつ（バイグラム）を作る
  const bigrams = [];
  for (let i = 0; i < queryNorm.length - 1; i++) {
    bigrams.push(queryNorm.slice(i, i + 2));
  }

  let bestUrl = null;
  let bestScore = 0;

  for (const url of urls) {
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
    const pageNorm = normalizeJa(plain);
    if (!pageNorm) continue;

    let score = 0;

    // 全体一致があれば大きく加点
    if (pageNorm.includes(queryNorm)) score += queryNorm.length * 2;

    // 二文字単位でどれだけ含まれるかを見る
    for (const bg of bigrams) {
      if (pageNorm.includes(bg)) score += 1;
    }

    if (score > bestScore) {
      bestScore = score;
      bestUrl = url;
    }
  }

  if (!bestUrl || bestScore === 0) return null;

  // ページ本文からの要約までは行わず、「ここに載っています」と案内する
  return `この内容については、次のページに記載があります。\n${bestUrl}`;
}

/**
 * 質問 → 回答
 * 1. FAQ 行全体にユーザー入力が含まれていれば、その行の D列(answer) を返す
 * 2. 見つからなければ HP / STORES / note 等（ALLOW_URLS）
 * 3. それでも無ければフォールバック
 */
async function findAnswer(env, userText) {
  const items = await loadFaqCsv(env.SHEET_CSV_URL);

  let best = null;
  let bestScore = -1;
  for (const it of items) {
    const sc = scoreFaqItem(it, userText);
    if (sc > bestScore) {
      best = it;
      bestScore = sc;
    }
  }

  if (best && bestScore > 0) {
    let out = best.answer;
    if (best.source) out += `\n—\n出典: ${best.source}`;
    return out;
  }

  const pageAnswer = await findAnswerFromPages(env, userText);
  if (pageAnswer) return pageAnswer;

  return "該当する回答が見つかりませんでした。よろしければ、キーワードを変えてもう一度お試しください。担当者への取次も可能です。";
}

/** LINE 返信 */
async function replyToLINE(token, replyToken, text) {
  const body = {
    replyToken,
    messages: [{ type: "text", text }],
  };
  const res = await fetch(LINE_REPLY_ENDPOINT, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
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
    if (ev.type === "message" && ev.message?.type === "text") {
      try {
        const answer = await findAnswer(env, ev.message.text || "");
        await replyToLINE(env.LINE_CHANNEL_TOKEN, ev.replyToken, answer);
      } catch (e) {
        await replyToLINE(
          env.LINE_CHANNEL_TOKEN,
          ev.replyToken,
          "内部処理でエラーが発生しました。お手数ですが、時間をおいて再度お試しください。"
        );
      }
    } else {
      if (ev.replyToken) {
        await replyToLINE(env.LINE_CHANNEL_TOKEN, ev.replyToken, "テキストでご質問ください。");
      }
    }
  }

  return new Response("OK", { status: 200 });
}

/** GET: 疎通確認用 */
export async function onRequestGet() {
  return new Response("OK", { status: 200 });
}
