// functions/webhook/line.js
// LINE Webhook（Cloudflare Pages Functions）
//
// 大原則:
//  - FAQスプレッドシート（env.SHEET_CSV_URL）
//  - HP / 公式LINE / STORES / note 等（env.ALLOW_URLS）
// に書いてある内容だけから回答する。
//   → 回答テキストは必ずこれらのどこかに実在するものだけ。
//   → ただし、言い方の違い（開業 / 創業 など）はここで定義した同義語として扱う。

const LINE_REPLY_ENDPOINT = "https://api.line.me/v2/bot/message/reply";

// ここに「同じ意味として扱いたい言葉」をグループで列挙してください。
const SYNONYM_GROUPS = [
  ["開業", "創業"],
  ["送料", "配送料", "配送費"],
  // 必要に応じて追加してください。
];

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

/** 質問文に同義語を足す（マッチング専用。回答文は改変しない） */
function expandWithSynonyms(text) {
  if (!text) return "";
  const base = String(text);
  let result = base;
  for (const group of SYNONYM_GROUPS) {
    let hit = false;
    for (const w of group) {
      if (base.includes(w)) { hit = true; break; }
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

  const header = rows.shift().map(h => h.trim().toLowerCase());
  const headerIdx = (name) => header.findIndex(h => h === name.toLowerCase());

  const vIdx = headerIdx("visibility");
  let aIdx = headerIdx("answer");
  if (aIdx === -1) aIdx = 3;
  // source_url_or_note は使わないのでインデックスだけ読み取って無視する
  const sIdx = headerIdx("source_url_or_note");

  const items = rows
    .map(r => {
      const cols = r.map(c => (c ?? "").trim());

      let visibility = "public";
      if (vIdx >= 0 && vIdx < cols.length) {
        const v = (cols[vIdx] || "").trim().toLowerCase();
        if (v) visibility = v;
      }

      const answer = aIdx < cols.length ? (cols[aIdx] || "").trim() : "";
      // source_url_or_note はここでは使用しない
      const joined = cols.join(" ").replace(/\s+/g, " ");

      return { answer, visibility, joined };
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

/**
 * FAQ 1 行に対する一致度。
 */
function scoreFaqItem(item, expandedText) {
  const queryNorm = normalizeJa(expandedText);
  if (!queryNorm) return 0;

  const targetNorm = normalizeJa(item.joined || "");
  if (!targetNorm) return 0;

  if (queryNorm.length === 1) {
    return targetNorm.includes(queryNorm) ? 1 : 0;
  }

  let score = 0;
  for (let i = 0; i < queryNorm.length - 1; i++) {
    const bg = queryNorm.slice(i, i + 2);
    if (targetNorm.includes(bg)) score++;
  }
  return score;
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

/**
 * ★ 改良版: ドメインパターン対応（note 専用 RSS は廃止）
 * ALLOW_URLS の例:
 *   https://arayanoen-site.pages.dev/
 *   https://arayanoen-sizen.stores.jp/
 *   https://note.com/araya_noen2018/*
 *
 * 「*」が付いている場合は、"* を取り除いた URL をそのまま取得」
 *   例: https://note.com/araya_noen2018/* 
 *        → https://note.com/araya_noen2018/
 */
async function findAnswerFromPages(env, expandedText) {
  const allowList = (env.ALLOW_URLS || "")
    .split(/[\s,]+/)
    .map(u => u.trim())
    .filter(Boolean);

  if (!allowList.length) return null;

  const queryNorm = normalizeJa(expandedText);
  if (!queryNorm || queryNorm.length < 2) return null;

  const bigrams = [];
  for (let i = 0; i < queryNorm.length - 1; i++) {
    bigrams.push(queryNorm.slice(i, i + 2));
  }

  let bestUrl = null;
  let bestScore = 0;

  for (const pattern of allowList) {
    // "*” が含まれる場合は、"* を外したベースURLで取得
    let url = pattern;
    if (pattern.includes("*")) {
      url = pattern.replace("*", "").replace(/\/+$/, "") + "/";
    }

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
    for (const bg of bigrams) {
      if (pageNorm.includes(bg)) score++;
    }

    if (score > bestScore) {
      bestScore = score;
      bestUrl = url;
    }
  }

  if (!bestUrl || bestScore === 0) return null;

  return {
    text: "この内容については、こちらのページをご覧ください:",
    url: bestUrl
  };
}

/**
 * 質問 → 回答
 */
async function findAnswer(env, userText) {
  const expanded = expandWithSynonyms(userText || "");

  const items = await loadFaqCsv(env.SHEET_CSV_URL);

  let best = null;
  let bestScore = -1;
  for (const it of items) {
    const sc = scoreFaqItem(it, expanded);
    if (sc > bestScore) {
      best = it;
      bestScore = sc;
    }
  }

  if (best && bestScore > 0) {
    // 出典列は使わない
    return { text: best.answer, url: null };
  }

  const pageAnswer = await findAnswerFromPages(env, expanded);
  if (pageAnswer) return pageAnswer;

  return { 
    text: "該当する回答が見つかりませんでした。よろしければ、キーワードを変えてもう一度お試しください。担当者への取次も可能です。",
    url: null
  };
}

/** LINE 返信（URL ボタン対応） */
async function replyToLINE(token, replyToken, text, url = null) {
  let messages;
  
  if (url) {
    // URL がある場合はボタンテンプレートを使用
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
    // 通常のテキストメッセージ
    messages = [{ type: "text", text }];
  }

  const body = { replyToken, messages };
  
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
