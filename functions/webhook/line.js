// functions/webhook/line.js
// LINE Webhook（Cloudflare Pages Functions）
// ・署名検証（LINE_CHANNEL_SECRET）
// ・テキスト受信 → シート検索（SHEET_CSV_URL）→ 最適回答
// ・FAQで見つからなければ ALLOW_URLS に列挙した HP／STORES／note などを検索
// ・それでも無ければフォールバック文面

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

/** CSVを配列に。ヘッダ名は動的に位置解決（最低: question, answer, source_url_or_note, keywords(optional), visibility） */
async function loadFaqCsv(csvUrl) {
  const res = await fetch(csvUrl, { cf: { cacheTtl: 60, cacheEverything: true } });
  if (!res.ok) throw new Error(`CSV fetch failed: ${res.status}`);
  const text = await res.text();

  // 簡易CSVパーサ（ダブルクォート対応・改行対応）
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
        // CRLF/CR/LF
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(field); rows.push(row); field = ""; row = []; i++; continue;
      }
      field += c; i++; continue;
    }
  }
  // 末尾フィールド
  row.push(field); rows.push(row);

  // ヘッダ
  const header = rows.shift().map(h => h.trim().toLowerCase());
  const idx = (name) => header.findIndex(h => h === name.toLowerCase());

  // question / category_or_question 両方を許可
  const qIdx = (() => {
    const cand = ["question", "category_or_question"];
    for (const name of cand) {
      const j = idx(name);
      if (j !== -1) return j;
    }
    return -1;
  })();

  const aIdx = idx("answer");
  const sIdx = idx("source_url_or_note");
  const kIdx = idx("keywords(optional)") !== -1 ? idx("keywords(optional)") : idx("keywords");
  const vIdx = idx("visibility");

  const maxIdx = Math.max(qIdx, aIdx, sIdx, kIdx, vIdx);

  // 正常な列だけ抽出（visibility が public のみ）
  const items = rows
    .filter(r => r.length > maxIdx)
    .map(r => ({
      question: qIdx >= 0 ? (r[qIdx]?.trim() ?? "") : "",
      answer: aIdx >= 0 ? (r[aIdx]?.trim() ?? "") : "",
      source: sIdx >= 0 ? (r[sIdx]?.trim() ?? "") : "",
      keywords: kIdx >= 0 ? (r[kIdx]?.trim() ?? "") : "",
      visibility: vIdx >= 0 ? (r[vIdx]?.trim().toLowerCase() ?? "public") : "public",
    }))
    .filter(x => x.visibility === "public");

  return items;
}

/** ごく簡易な一致度（含有・スコア） */
function scoreItem(item, text) {
  const t = text.toLowerCase();
  let s = 0;
  if (item.question && t.includes(item.question.toLowerCase())) s += 3;
  const kws = (item.keywords || "").split(/[,\s]+/).filter(Boolean);
  for (const kw of kws) if (t.includes(kw.toLowerCase())) s += 1;
  // 部分一致：質問の単語を拾う
  const words = t.split(/\s+/).filter(w => w.length >= 2);
  for (const w of words) if (item.question.toLowerCase().includes(w)) s += 0.3;
  return s;
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

/** ALLOW_URLS に列挙した HP／STORES／note などから回答候補を探す */
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

    const html = await res.text();
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

/** 質問→回答（FAQ優先 → HP／STORES／note → フォールバック） */
async function findAnswer(env, userText) {
  const items = await loadFaqCsv(env.SHEET_CSV_URL);

  // まず CSV（FAQ）をスコアリング
  let best = null, bestScore = -1;
  for (const it of items) {
    const sc = scoreItem(it, userText);
    if (sc > bestScore) { best = it; bestScore = sc; }
  }

  // FAQ から十分な一致があればそれを返す
  if (best && bestScore >= 1) {
    let out = best.answer;
    if (best.source) out += `\n—\n出典: ${best.source}`;
    return out;
  }

  // FAQで見つからなければ、HP／LINE／STORES／note（ALLOW_URLS）を検索
  const pageAnswer = await findAnswerFromPages(env, userText);
  if (pageAnswer) return pageAnswer;

  // それでも無ければフォールバック
  return "該当する回答が見つかりませんでした。よろしければ、キーワードを変えてもう一度お試しください。担当者への取次も可能です。";
}

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
        // 失敗時もエラーで止めない
        await replyToLINE(
          env.LINE_CHANNEL_TOKEN,
          ev.replyToken,
          "内部処理でエラーが発生しました。お手数ですが、時間をおいて再度お試しください。"
        );
      }
    } else {
      // 未対応種別には簡易応答
      if (ev.replyToken) {
        await replyToLINE(env.LINE_CHANNEL_TOKEN, ev.replyToken, "テキストでご質問ください。");
      }
    }
  }
  return new Response("OK", { status: 200 });
}

// GET テスト（ブラウザから /webhook/line を開いた時の疎通用）
export async function onRequestGet() {
  return new Response("OK", { status: 200 });
}
