// functions/webhook/line.js
// LINE Webhook（Cloudflare Pages Functions）
//
// ・FAQ スプレッドシート（env.SHEET_CSV_URL）
// ・HP / STORES / note / 他（env.ALLOW_URLS）
// に「書いてあることだけ」を元に回答する。
// note の /rss などは RSS として読み、各 <item> の記事 URL を返す。

const LINE_REPLY_ENDPOINT = "https://api.line.me/v2/bot/message/reply";

// 同じ意味として扱う語（必要に応じて追加）
const SYNONYM_GROUPS = [
  ["開業", "創業"],
  ["送料", "配送料", "配送費"],
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

/** 質問文に同義語を足す（マッチング専用。回答文そのものは改変しない） */
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
        if (!result.includes(w)) result += " " + w;
      }
    }
  }
  return result;
}

/**
 * FAQ CSV を読み込む。
 * 1行目ヘッダ想定:
 *   category_or_question / question / answer / keywords(optional) / source_url_or_note / visibility
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
  const idx = (name) => header.findIndex(h => h === name.toLowerCase());

  const qIdx = idx("question");
  const cIdx = idx("category_or_question");
  const aIdx = idx("answer");
  const sIdx = idx("source_url_or_note");
  const kIdx = idx("keywords(optional)") !== -1 ? idx("keywords(optional)") : idx("keywords");
  const vIdx = idx("visibility");

  const items = [];

  for (const r of rows) {
    const cols = r.map(c => (c ?? "").trim());

    // visibility
    let visibility = "public";
    if (vIdx >= 0 && vIdx < cols.length) {
      const v = (cols[vIdx] || "").trim().toLowerCase();
      if (v) visibility = v;
    }
    if (visibility !== "public") continue;

    const answer = aIdx >= 0 && aIdx < cols.length ? cols[aIdx] : "";
    if (!answer) continue;

    const question = qIdx >= 0 && qIdx < cols.length ? cols[qIdx] : "";
    const category = cIdx >= 0 && cIdx < cols.length ? cols[cIdx] : "";
    const keywords = kIdx >= 0 && kIdx < cols.length ? cols[kIdx] : "";
    const source = sIdx >= 0 && sIdx < cols.length ? cols[sIdx] : "";

    const search = [category, question, answer, keywords].join(" ").replace(/\s+/g, " ");

    items.push({ answer, source, search });
  }

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
 * テキスト同士のスコア計算
 *
 * 優先順位:
 *  1) 質問全文（＋同義語展開）そのものが含まれていれば大きく加点
 *  2) 質問を空白で区切った「単語」（開業 / 創業 など）が含まれていれば加点
 *  3) それでも何もヒットしないときだけ、バイグラムの重なりをおまけ点として使う
 */
function scoreText(targetJoined, expandedText) {
  const targetNorm = normalizeJa(targetJoined);
  const qNorm = normalizeJa(expandedText);
  if (!targetNorm || !qNorm) return 0;

  let score = 0;

  // 1: 質問全文が含まれているか
  if (targetNorm.includes(qNorm)) {
    score += Math.max(30, qNorm.length * 2);
  }

  // 2: 単語単位（主に同義語展開用）
  const words = expandedText.split(/\s+/).filter(Boolean);
  for (const w of words) {
    const n = normalizeJa(w);
    if (!n) continue;
    if (targetNorm.includes(n)) {
      score += Math.max(8, n.length * 2);
    }
  }

  // 3: ここまでで全くヒットしていない場合のみ、バイグラムでおまけ点
  if (score === 0 && qNorm.length > 1) {
    for (let i = 0; i < qNorm.length - 1; i++) {
      const bg = qNorm.slice(i, i + 2);
      if (targetNorm.includes(bg)) score += 0.7;
    }
  }

  return score;
}

/** FAQ 1 行に対する一致度 */
function scoreFaqItem(item, expandedText) {
  return scoreText(item.search || "", expandedText);
}

/** HTML → プレーンテキスト（HP／STORES 用） */
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
 * RSS テキスト → item 配列
 * 各 item: { title, description, link, joined }
 * - <link>本文</link>
 * - <link ... href="..."/>
 * の両方に対応する。
 */
function parseRss(text) {
  const items = [];
  const itemRegex = /<item\b[\s\S]*?<\/item>/gi;
  let m;
  while ((m = itemRegex.exec(text)) !== null) {
    const block = m[0];

    const getTagText = (name) => {
      const r = new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, "i");
      const mm = r.exec(block);
      if (!mm) return "";
      let v = mm[1].trim();
      v = v.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
      return v.trim();
    };

    const title = getTagText("title");
    const desc = getTagText("description");

    let link = getTagText("link"); // <link>...</link> パターン
    if (!link) {
      const hrefMatch = block.match(/<link[^>]+href="([^"]+)"[^>]*\/?>/i);
      if (hrefMatch) link = hrefMatch[1].trim();
    }

    const joined = (title + " " + desc).replace(/\s+/g, " ");

    if (title || desc) {
      items.push({ title, description: desc, link, joined });
    }
  }
  return items;
}

/**
 * ALLOW_URLS に書かれた URL 群から「ページ／記事の一覧」を作る。
 * - 通常の URL: ページ1件
 * - /rss や feed: RSS とみなし、各 item を記事として扱う
 */
async function loadSiteDocuments(env) {
  const urls = (env.ALLOW_URLS || "")
    .split(/[\s,]+/)
    .map(u => u.trim())
    .filter(Boolean);

  const docs = [];

  for (const url of urls) {
    let res;
    try {
      res = await fetch(url, { cf: { cacheTtl: 300, cacheEverything: true } });
    } catch {
      continue;
    }
    if (!res.ok) continue;

    let text;
    try {
      text = await res.text();
    } catch {
      continue;
    }

    const lowerUrl = url.toLowerCase();

    if (lowerUrl.endsWith("/rss") || lowerUrl.includes("rss") || lowerUrl.includes("feed")) {
      // RSS / フィード
      const items = parseRss(text);
      for (const it of items) {
        const docUrl = it.link || url; // link が取れなかった場合だけ /rss を使う
        const joined = (it.joined || "").replace(/\s+/g, " ");
        docs.push({
          title: it.title || "",
          snippet: (it.description || "").replace(/\s+/g, " ").slice(0, 200),
          url: docUrl,
          joined,
        });
      }
    } else {
      // 通常の HTML ページ
      const plain = htmlToText(text);
      if (!plain) continue;
      docs.push({
        title: "",
        snippet: plain.slice(0, 200),
        url,
        joined: plain,
      });
    }
  }

  return docs;
}

/** ページ／記事 1 件に対する一致度 */
function scoreDoc(doc, expandedText) {
  return scoreText(doc.joined || "", expandedText);
}

/**
 * 質問 → 回答
 * 1. FAQ から探す
 * 2. なければ HP / STORES / note 等から探し、記事 URL を返す
 * 3. それでも無ければフォールバック
 */
async function findAnswer(env, userText) {
  const expanded = expandWithSynonyms(userText || "");

  // 1: FAQ
  const faqItems = await loadFaqCsv(env.SHEET_CSV_URL);
  let bestFaq = null;
  let bestFaqScore = -1;
  for (const it of faqItems) {
    const sc = scoreFaqItem(it, expanded);
    if (sc > bestFaqScore) {
      bestFaq = it;
      bestFaqScore = sc;
    }
  }
  // スコア 5 以上なら採用（短い質問でも通るように）
  if (bestFaq && bestFaqScore >= 5) {
    let out = bestFaq.answer;
    if (bestFaq.source) out += `\n—\n出典: ${bestFaq.source}`;
    return out;
  }

  // 2: サイト群（HP / note / STORES など）
  const docs = await loadSiteDocuments(env);
  if (docs.length > 0) {
    let bestDoc = null;
    let bestDocScore = -1;
    for (const d of docs) {
      const sc = scoreDoc(d, expanded);
      if (sc > bestDocScore) {
        bestDoc = d;
        bestDocScore = sc;
      }
    }
    if (bestDoc && bestDocScore >= 5) {
      let msg = "";
      if (bestDoc.snippet) {
        msg += bestDoc.snippet + "\n\n";
      }
      msg += "この内容については、次のページに記載があります。\n" + bestDoc.url;
      return msg;
    }
  }

  // 3: 何も見つからない場合
  return "該当する回答が見つかりませんでした。よろしければ、キーワードを変えてもう一度お試しください。担当者への取次も可能です。";
}

/** LINE 返信 */
async function replyToLINE(token, replyToken, text) {
  const body = { replyToken, messages: [{ type: "text", text }] };
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
    } else if (ev.replyToken) {
      await replyToLINE(env.LINE_CHANNEL_TOKEN, ev.replyToken, "テキストでご質問ください。");
    }
  }

  return new Response("OK", { status: 200 });
}

/** GET: 疎通確認用 */
export async function onRequestGet() {
  return new Response("OK", { status: 200 });
}
