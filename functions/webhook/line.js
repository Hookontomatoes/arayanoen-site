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
  let sIdx = headerIdx("source_url_or_note");
  if (sIdx === -1) sIdx = -1;

  const items = rows
    .map(r => {
      const cols = r.map(c => (c ?? "").trim());

      let visibility = "public";
      if (vIdx >= 0 && vIdx < cols.length) {
        const v = (cols[vIdx] || "").trim().toLowerCase();
        if (v) visibility = v;
      }

      const answer = aIdx < cols.length ? (cols[aIdx] || "").trim() : "";
      const source = sIdx >= 0 && sIdx < cols.length ? (cols[sIdx] || "").trim() : "";
      const joined = cols.join(" ").replace(/\s+/g, " ");

      return { answer, source, visibility, joined };
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
 * ★ 新機能: note 記事を検索する
 * note.com のドメインから、質問に関連する記事を自動検索
 */
async function searchNoteArticles(noteDomain, expandedText) {
  // note の検索 URL（例: https://note.com/あなたのアカウント名?q=キーワード）
  // または Google Custom Search API などを使う方法もあります
  
  // ここでは簡易的に、sitemap や RSS から記事一覧を取得する想定
  // 実装例: note.com/ユーザー名/rss から最新記事を取得
  const rssUrl = `${noteDomain}/rss`;
  
  try {
    const res = await fetch(rssUrl, { cf: { cacheTtl: 300, cacheEverything: true } });
    if (!res.ok) return null;
    
    const xml = await res.text();
    
    // RSS から <link> タグを抽出（簡易パース）
    const linkMatches = xml.matchAll(/<link>([^<]+)<\/link>/g);
    const urls = [];
    for (const match of linkMatches) {
      const url = match[1].trim();
      if (url && url.startsWith('http')) {
        urls.push(url);
      }
    }
    
    if (!urls.length) return null;
    
    // 各記事をスコアリング
    const queryNorm = normalizeJa(expandedText);
    if (!queryNorm || queryNorm.length < 2) return null;
    
    const bigrams = [];
    for (let i = 0; i < queryNorm.length - 1; i++) {
      bigrams.push(queryNorm.slice(i, i + 2));
    }
    
    let bestUrl = null;
    let bestScore = 0;
    
    for (const url of urls) {
      try {
        const articleRes = await fetch(url, { cf: { cacheTtl: 300, cacheEverything: true } });
        if (!articleRes.ok) continue;
        
        const html = await articleRes.text();
        const plain = htmlToText(html);
        const pageNorm = normalizeJa(plain);
        
        let score = 0;
        for (const bg of bigrams) {
          if (pageNorm.includes(bg)) score++;
        }
        
        if (score > bestScore) {
          bestScore = score;
          bestUrl = url;
        }
      } catch {
        continue;
      }
    }
    
    if (!bestUrl || bestScore === 0) return null;
    return bestUrl;
    
  } catch {
    return null;
  }
}

/**
 * ★ 改良版: ドメインパターン + note 自動検索対応
 * ALLOW_URLS の例:
 *   https://arayanoen-site.pages.dev/
 *   https://arayanoen-sizen.stores.jp/
 *   note.com/araya_noen2018/*
 *   ↑ のように * をつけるとそのドメイン配下を自動検索
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
    // ★ ワイルドカード対応（note.com/xxx/* など）
    if (pattern.includes('*')) {
      const baseDomain = pattern.replace('*', '').replace(/\/+$/, '');
      
      // note の場合は RSS 検索
      if (baseDomain.includes('note.com')) {
        const noteUrl = await searchNoteArticles(baseDomain, expandedText);
        if (noteUrl) {
          return {
            text: "この内容については、こちらの記事をご覧ください:",
            url: noteUrl
          };
        }
      }
      continue;
    }

    // 通常の URL（固定ページ）
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
    const pageNorm = normalizeJa(plain);
    if (!pageNorm) continue;

    let score = 0;
    for (const bg of bigrams) {
      if (pageNorm.includes(bg)) score++;
    }

    if (score > bestScore) {
      bestScore = score;
      bestUrl = pattern;
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
    let out = best.answer;
    if (best.source) out += `\n—\n出典: ${best.source}`;
    return { text: out, url: null };
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
