// functions/webhook/line.js
// LINE Webhook（Cloudflare Pages Functions）
//
// 大原則:
//  - スプレッドシートの FAQ（env.SHEET_CSV_URL）
//  - HP / 公式LINE / STORES / note などの公開ページ（env.ALLOW_URLS に列挙）
// に「書いてあること」だけから回答を返す。
// それ以外の知ったかぶりは一切しない。

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
  // base64
  let binary = "";
  const bytes = new Uint8Array(sig);
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/**
 * CSV を配列に。
 * 必要な列:
 *   - answer（必須）
 * 任意の列（あればマッチングに使う）:
 *   - question
 *   - category_or_question
 *   - keywords / keywords(optional)
 *   - source_url_or_note
 *   - visibility（public の行だけ有効）
 */
async function loadFaqCsv(csvUrl) {
  const res = await fetch(csvUrl, { cf: { cacheTtl: 60, cacheEverything: true } });
  if (!res.ok) throw new Error(`CSV fetch failed: ${res.status}`);
  const text = await res.text();

  // 簡易 CSV パーサ（ダブルクォート対応・改行対応）
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

  if (rows.length === 0) return [];

  // ヘッダ解決
  const header = rows.shift().map(h => h.trim().toLowerCase());
  const idx = (name) => header.findIndex(h => h === name.toLowerCase());

  const qIdx  = idx("question");
  const cIdx  = idx("category_or_question");
  const aIdx  = idx("answer");
  const sIdx  = idx("source_url_or_note");
  const kIdx  = idx("keywords(optional)") !== -1 ? idx("keywords(optional)") : idx("keywords");
  const vIdx  = idx("visibility");

  const maxIdx = Math.max(qIdx, cIdx, aIdx, sIdx, kIdx, vIdx);

  const items = rows
    .filter(r => r.length > maxIdx && aIdx >= 0 && r[aIdx] != null && r[aIdx].trim() !== "")
    .map(r => {
      const question  = qIdx >= 0 ? (r[qIdx] ?? "").trim() : "";
      const category  = cIdx >= 0 ? (r[cIdx] ?? "").trim() : "";
      const answer    = aIdx >= 0 ? (r[aIdx] ?? "").trim() : "";
      const source    = sIdx >= 0 ? (r[sIdx] ?? "").trim() : "";
      const keywords  = kIdx >= 0 ? (r[kIdx] ?? "").trim() : "";
      const visibility= vIdx >= 0 ? (r[vIdx] ?? "").trim().toLowerCase() : "public";

      // マッチング用テキスト（質問・カテゴリ・キーワード・回答・出典を全部まとめる）
      const searchableText = [
        question,
        category,
        keywords,
        answer,
        source
      ].filter(Boolean).join(" ").toLowerCase();

      return {
        question,
        category,
        answer,
        source,
        keywords,
        visibility,
        searchableText,
      };
    })
    .filter(x => x.visibility === "public");

  return items;
}

/** ごく簡易な一致度（FAQ 1 行に対するスコア） */
function scoreItem(item, text) {
  const t = text.toLowerCase();
  let s = 0;

  // 質問文・カテゴリ・回答にそのまま含まれていれば高めに加点
  const mainFields = [item.question, item.category, item.answer];
  for (const f of mainFields) {
    if (f && t && f.toLowerCase().includes(t)) s += 4;
    if (f && t && t.includes(f.toLowerCase()) && f.length >= 4) s += 3;
  }

  // キーワード列
  const kws = (item.keywords || "").split(/[,\s]+/).filter(Boolean);
  for (const kw of kws) {
    const k = kw.toLowerCase();
    if (t.includes(k)) s += 2;
  }

  // 部分一致：ユーザー入力の単語ごとに、行全体のテキストに含まれるか
  const words = t.split(/\s+/).filter(w => w.length >= 2);
  for (const w of words) {
    if (item.searchableText.includes(w)) s += 0.5;
  }

  return s;
}

/** HTML → プレーンテキスト（HP／STORES／note など用） */
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

/**
 * env.ALLOW_URLS に列挙した URL 群（HP／公式LINEの案内ページ／STORES商品ページ／note記事など）
 * からテキストを取得し、ユーザーの質問と近い箇所を抜き出して返す。
 *
 * env.ALLOW_URLS には、改行区切りで URL を列挙する想定。
 */
async function findAnswerFromPages(env, userText) {
  const urls = (env.ALLOW_URLS || "")
    .split(/\r?\n/)
    .map(u => u.trim())
    .filter(Boolean);

  if (!urls.length) return null;

  const query = userText.toLowerCase();
  const words = query.split(/\s+/).filter(w => w.length >= 2);

  let bestUrl = null;
  let bestScore = 0;
  let bestSnippet = "";

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
    const lower = plain.toLowerCase();

    let score = 0;
    for (const w of words) {
      if (lower.includes(w)) score += 1;
    }

    if (score > bestScore) {
      bestScore = score;
      bestUrl = url;

      let pos = -1;
      for (const w of words) {
        pos = lower.indexOf(w);
        if (pos !== -1) break;
      }
      if (pos === -1) pos = 0;

      const start = Math.max(0, pos - 40);
      const end = Math.min(plain.length, start + 160);
      bestSnippet = plain.slice(start, end).replace(/\s+/g, " ");
    }
  }

  if (!bestUrl || bestScore === 0) return null;

  let message = "";
  if (bestSnippet) {
    message += bestSnippet.trim() + "\n\n";
  }
  message += "詳しくは次のページをご確認ください。\n" + bestUrl;
  return message;
}

/**
 * 質問 → 回答
 * 優先順:
 *  1. FAQ スプレッドシート（env.SHEET_CSV_URL）
 *  2. HP／公式LINE／STORES／note のページ（env.ALLOW_URLS）
 *  3. どこにも無ければフォールバックメッセージ
 */
async function findAnswer(env, userText) {
  const items = await loadFaqCsv(env.SHEET_CSV_URL);

  // まず FAQ（CSV）でスコアリング
  let best = null;
  let bestScore = -1;
  for (const it of items) {
    const sc = scoreItem(it, userText);
    if (sc > bestScore) {
      best = it;
      bestScore = sc;
    }
  }

  // FAQ から十分な一致があればそれを返す
  if (best && bestScore >= 1) {
    let out = best.answer;
    if (best.source) out += `\n—\n出典: ${best.source}`;
    return out;
  }

  // FAQ に明確な候補が無ければ、HP／公式LINE／STORES／note を検索
  const pageAnswer = await findAnswerFromPages(env, userText);
  if (pageAnswer) return pageAnswer;

  // それでも見つからない場合だけ、フォールバック
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

  // 複数イベントに対応
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
      // 画像などテキスト以外が来た場合の最低限の返答
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
