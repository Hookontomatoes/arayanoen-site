// functions/webhook/line.js
// LINE Webhook（Cloudflare Pages Functions）
//
// 大原則:
//  - 回答に使うテキストは FAQ スプレッドシート（env.SHEET_CSV_URL）
//    と HP / 公式LINE / STORES / note（env.ALLOW_URLS に指定）に
//    実在するものだけ。
//  - 言い方の違い（開業 / 創業、送料 / 配送料 など）は同義語テーブルで吸収する。
//  - 信頼できる一致がない場合は「該当する回答が見つかりませんでした」で返す。

const LINE_REPLY_ENDPOINT = "https://api.line.me/v2/bot/message/reply";

// 同じ意味として扱いたい言葉のグループ
// 必要に応じてここに追記してください。
const SYNONYM_GROUPS = [
  ["開業", "創業"],
  ["送料", "配送料", "配送費"],
  // ["農業体験", "体験ツアー", "農業ツアー"], など
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
 *
 * 列配置（1行目はヘッダ。名前はだいたい次を想定）:
 *   A: id
 *   B: category_or_question
 *   C: question（任意）
 *   D: answer  ← 回答として返す
 *   E: keywords(optional) / keywords
 *   G: source_url_or_note（元ページの URL やメモ）
 *   L: visibility（public の行だけ有効）
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

  // ヘッダ行
  const header = rows.shift().map(h => h.trim().toLowerCase());
  const headerIdx = (name) => header.findIndex(h => h === name.toLowerCase());

  const vIdx = headerIdx("visibility");
  let aIdx = headerIdx("answer");
  if (aIdx === -1) aIdx = 3; // D列
  let sIdx = headerIdx("source_url_or_note");
  if (sIdx === -1) sIdx = -1;

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
      const source = sIdx >= 0 && sIdx < cols.length ? (cols[sIdx] || "").trim() : "";

      // 行全体テキスト（カテゴリ・質問・回答・キーワードなど全部）
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
 * 質問文（同義語展開済み）と行全体テキストを正規化し、
 * 二文字単位（バイグラム）の重なり数でスコアを出す。
 */
function scoreFaqItem(item, expandedText) {
  const queryNorm = normalizeJa(expandedText);
  if (!queryNorm) return 0;

  const targetNorm = normalizeJa(item.joined || "");
  if (!targetNorm) return 0;

  // 完全含有なら大きく加点（長いほど高得点）
  let score = 0;
  if (queryNorm.length >= 3 && targetNorm.includes(queryNorm)) {
    score += queryNorm.length * 2;
  }

  if (queryNorm.length === 1) {
    return score + (targetNorm.includes(queryNorm) ? 1 : 0);
  }

  for (let i = 0; i < queryNorm.length - 1; i++) {
    const bg = queryNorm.slice(i, i + 2);
    if (targetNorm.includes(bg)) score++;
  }
  return score;
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

/** RSS テキスト → item 配列（title, description, link, joined）に変換 */
function parseRss(text) {
  const items = [];
  const itemRegex = /<item\b[\s\S]*?<\/item>/gi;
  let m;
  while ((m = itemRegex.exec(text)) !== null) {
    const block = m[0];
    const tag = (name) => {
      const r = new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, "i");
      const mm = r.exec(block);
      if (!mm) return "";
      let v = mm[1].trim();
      v = v.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
      return v.trim();
    };
    const title = tag("title");
    const desc = tag("description");
    const link = tag("link");
    const joined = (title + " " + desc).replace(/\s+/g, " ");
    if (title || desc) {
      items.push({ title, description: desc, link, joined });
    }
  }
  return items;
}

/**
 * ALLOW_URLS に書かれた URL 群から「ページ／記事の一覧」を作る。
 * - 通常の URL: そのページ 1件だけを文書として扱う
 * - /rss や feed: RSS とみなして item を文書として扱う
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

    // RSS / フィード
    if (lowerUrl.endsWith("/rss") || lowerUrl.includes("rss") || lowerUrl.includes("feed")) {
      const items = parseRss(text);
      for (const it of items) {
        const joinedNorm = it.joined.replace(/\s+/g, " ");
        docs.push({
          title: it.title || "",
          snippet: it.description || "",
          url: it.link || url, // 記事の link が無ければ RSS 自体
          joined: joinedNorm,
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

/** ページ／記事 1 件に対する一致度（FAQ と同じくバイグラム） */
function scoreDoc(doc, expandedText) {
  const queryNorm = normalizeJa(expandedText);
  if (!queryNorm) return 0;
  const targetNorm = normalizeJa(doc.joined || "");
  if (!targetNorm) return 0;

  let score = 0;

  // 完全含有は大きく加点
  if (queryNorm.length >= 3 && targetNorm.includes(queryNorm)) {
    score += queryNorm.length * 2;
  }

  if (queryNorm.length === 1) {
    return score + (targetNorm.includes(queryNorm) ? 1 : 0);
  }

  for (let i = 0; i < queryNorm.length - 1; i++) {
    const bg = queryNorm.slice(i, i + 2);
    if (targetNorm.includes(bg)) score++;
  }
  return score;
}

/**
 * 質問 → 回答
 * 1. FAQ 行全体と質問文（＋同義語）を付き合わせて、一番スコアが高い行の answer を返す
 * 2. FAQ で見つからなければ、HP / STORES / note（RSS 含む）の中で
 *    一番近いページ／記事を探し、その URL を案内する
 * 3. それでもダメならフォールバック
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
  // スコアがある程度以上のときだけ採用（ゼロやごく小さい値は不採用）
  if (bestFaq && bestFaqScore > 1) {
    let out = bestFaq.answer;
    if (bestFaq.source) out += `\n—\n出典: ${bestFaq.source}`;
    return out;
  }

  // 2: HP / STORES / note 等
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
    // ページ側もスコアが十分高いときだけ URL を返す
    // （スコア 3 未満なら「無関係」とみなして捨てる）
    if (bestDoc && bestDocScore >= 3) {
      let msg = "";
      if (bestDoc.snippet) {
        msg += bestDoc.snippet.replace(/\s+/g, " ").slice(0, 120) + "\n\n";
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
