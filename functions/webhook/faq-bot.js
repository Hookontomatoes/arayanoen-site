// functions/faq-bot.js
//
// HP 内から使う FAQ ボット用エンドポイント（/faq-bot）です。
// ポイント:
//  - OpenAI 等の外部 AI は一切使いません（料金発生なし）。
//  - env.SHEET_CSV_URL で指定された CSV から FAQ を読み込みます。
//  - env.ALLOW_URLS に列挙されたページ(URL)も簡易検索し、
//    見つかれば「このページをご覧ください」と URL を返します。
//  - 見つからなければ固定の「わかりません」メッセージを返します。

const MIN_FAQ_RATIO = 0.8;

const SYNONYM_GROUPS = [
  ["開業", "創業"],
  ["送料", "配送料", "配送費"],
  // 必要に応じて追加してください。
];

/** CORS ヘッダー（同一オリジンなら実質不要ですが念のため） */
const baseHeaders = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: baseHeaders
  });
}

export async function onRequest(context) {
  const { request, env } = context;

  // プレフライト
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: baseHeaders });
  }

  if (request.method !== "POST") {
    return json({ error: "method_not_allowed", message: "POST だけ受け付けます。" }, 405);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json", message: "JSON 形式で送信してください。" }, 400);
  }

  const userQuestion = (body.message || "").trim();
  if (!userQuestion) {
    return json({ error: "empty_question", message: "質問が空です。" }, 400);
  }

  const csvUrl = env.SHEET_CSV_URL;
  if (!csvUrl) {
    return json(
      { error: "missing_env", message: "SHEET_CSV_URL が設定されていません。" },
      500
    );
  }

  try {
    const answer = await findAnswer(env, userQuestion);

    // HP側のフロントエンドは主に answer.text を使う想定です。
    return json(
      {
        answer: answer.text,
        url: answer.url || null,
        matched: !!answer.matched,
        matched_question: answer.matched_question || null,
        score: answer.score ?? null
      },
      200
    );
  } catch (e) {
    console.error("faq-bot error:", e);
    return json(
      {
        error: "internal_error",
        answer:
          "内部エラーが発生しました。お手数ですが、お問い合わせフォームからご連絡ください。"
      },
      500
    );
  }
}

/** 質問文に同義語を足す（マッチング専用。回答文そのものは改変しない） */
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

/** FAQ CSV を読み込む（line.js と同じロジックをベースにしています） */
async function loadFaqCsv(csvUrl) {
  const res = await fetch(csvUrl, { cf: { cacheTtl: 60, cacheEverything: true } });
  if (!res.ok) throw new Error(`CSV fetch failed: ${res.status}`);
  const text = await res.text();

  // ダブルクォート対応の簡易 CSV パーサ
  const rows = [];
  let i = 0,
    field = "",
    inQuote = false,
    row = [];
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
        if (c === "\r" && text[i + 1] === "\n") i++;
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

  const header = rows.shift().map((h) => h.trim().toLowerCase());
  const headerIdx = (name) => header.findIndex((h) => h === name.toLowerCase());

  const vIdx = headerIdx("visibility");
  let aIdx = headerIdx("answer");
  if (aIdx === -1) aIdx = 3; // 念のためのフォールバック

  const items = rows
    .map((r) => {
      const cols = r.map((c) => (c ?? "").trim());

      let visibility = "public";
      if (vIdx >= 0 && vIdx < cols.length) {
        const v = (cols[vIdx] || "").trim().toLowerCase();
        if (v) visibility = v;
      }

      const answer = aIdx < cols.length ? (cols[aIdx] || "").trim() : "";
      const joined = cols.join(" ").replace(/\s+/g, " ");

      return { answer, visibility, joined };
    })
    .filter((x) => x.visibility === "public" && x.answer);

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
 * 戻り値は「クエリ側の二文字単位のうち、いくつ含まれているか」の数。
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
 * HP 等（ALLOW_URLS に列挙された URL）の中から関連ページを探す
 */
async function findAnswerFromPages(env, expandedText) {
  const allowList = (env.ALLOW_URLS || "")
    .split(/[\s,]+/)
    .map((u) => u.trim())
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

  for (const url of allowList) {
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
    text: "この内容については、こちらのページをご覧ください。",
    url: bestUrl
  };
}

/**
 * 質問 → 回答
 * 仕様:
 *  - 質問と「ほぼ同じ文字列」の FAQ があるときだけ FAQ を採用
 *  - そうでなければ HP を検索
 *  - それでも無ければ固定メッセージ
 */
async function findAnswer(env, userText) {
  const raw = userText || "";
  const expanded = expandWithSynonyms(raw);

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

  const queryNorm = normalizeJa(expanded);
  const maxScore = Math.max(queryNorm.length - 1, 1);
  const threshold = Math.ceil(maxScore * MIN_FAQ_RATIO);

  if (best && bestScore >= threshold && bestScore > 0) {
    return {
      text: best.answer,
      url: null,
      matched: true,
      matched_question: null,
      score: bestScore
    };
  }

  const pageAnswer = await findAnswerFromPages(env, expanded);
  if (pageAnswer) {
    return {
      text: pageAnswer.text,
      url: pageAnswer.url,
      matched: false,
      matched_question: null,
      score: bestScore
    };
  }

  return {
    text:
      "該当する回答が見つかりませんでした。よろしければ、キーワードを変えてもう一度お試しください。担当者への取次も可能です。",
    url: null,
    matched: false,
    matched_question: null,
    score: bestScore
  };
}
