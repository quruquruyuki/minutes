// 議事録アプリ用 Supabase Edge Function
// action: transcribe（文字起こし） / summarize（議事録化） / save（Notion保存）
// 使うシークレット: ALLOWED_EMAIL（ログインを許可するメール）, openai_api_key, ANTHROPIC_API_KEY, NOTION_API_KEY, GEMINI_API_KEY（Gemini使用時のみ）
// 議事録DBのIDは秘密情報ではないので下に直接書いている（MINUTES_DATA_SOURCE_ID で上書き可）
import { encodeBase64 } from "jsr:@std/encoding@1/base64";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-app-passcode",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// 名前の大文字・小文字の違いを吸収して読む
const env = (...keys: string[]) => {
  for (const k of keys) {
    const v = Deno.env.get(k) ?? Deno.env.get(k.toLowerCase()) ?? Deno.env.get(k.toUpperCase());
    if (v) return v;
  }
  return "";
};
const MINUTES_DS = () => env("MINUTES_DATA_SOURCE_ID") || "41a85790-2406-818c-9fb4-000b58841972";
const SEMINAR_DS = () => env("SEMINAR_DATA_SOURCE_ID") || "41a85790-2406-8160-a503-000b3ff716d6"; // Tsumura wiki / セミナーノート
// 料金表（USD／100万トークン）。共通設定（app_settings: global/prices）があればそちらで上書きする。下は予備
const PRICE: Record<string, { ain?: number; in: number; out: number }> = {
  "gpt-4o-transcribe": { ain: 6, in: 2.5, out: 10 },
  "gpt-4o-mini-transcribe": { ain: 3, in: 1.25, out: 5 },
  "claude-sonnet-5-5": { in: 2, out: 10 },
  "claude-opus-5-5": { in: 4, out: 20 },
  "gemini-3.5-flash": { in: 1.5, out: 9 },
  "gemini-3.5-flash-lite": { in: 0.3, out: 2.5 },
};
let WHISPER_PER_MIN = 0.006;
// 分単位で料金がかかるモデル（USD／分）。共通設定の「モデル名_per_min」で上書きする
const PER_MIN: Record<string, number> = { "whisper-1": 0.006, "gpt-transcribe": 0.0045 };

// ── 全アプリ共通の設定（Supabase の app_settings テーブル）──
// AIモデルや料金単価はここから読む。1分間は使い回す。読めないときは従来の値（Secret・既定値）を使う
const SETTINGS_TTL = 60_000;
let settingsCache: { at: number; map: Record<string, unknown> } | null = null;
async function appSettings(app: string): Promise<Record<string, unknown>> {
  if (settingsCache && Date.now() - settingsCache.at < SETTINGS_TTL) return settingsCache.map;
  const map: Record<string, unknown> = {};
  try {
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const q = `select=app,key,value&app=in.${encodeURIComponent(`("global","${app}")`)}`;
    const r = await fetch(`${Deno.env.get("SUPABASE_URL")}/rest/v1/app_settings?${q}`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
    if (r.ok) for (const row of await r.json()) map[row.app === "global" ? `global.${row.key}` : row.key] = row.value;
    else console.error("app_settings", r.status, await r.text());
  } catch (e) { console.error("app_settings", e); }
  settingsCache = { at: Date.now(), map };
  return map;
}
async function setting(app: string, key: string, fallback: string): Promise<string> {
  const v = (await appSettings(app))[key];
  return typeof v === "string" && v.trim() ? v.trim() : fallback;
}

// 共通設定の料金表を取り込む
async function applyPrices() {
  const p = (await appSettings("minutes"))["global.prices"];
  if (!p || typeof p !== "object") return;
  for (const [k, v] of Object.entries(p as Record<string, any>)) {
    if (k === "whisper-1_per_min" && typeof v === "number") WHISPER_PER_MIN = v;
    if (k.endsWith("_per_min") && typeof v === "number") PER_MIN[k.slice(0, -"_per_min".length)] = v;
    else if (v && typeof v === "object" && typeof v.in === "number") PRICE[k] = v;
  }
}
const usdOf = (model: string, tin: number, tout: number, ain = 0) => {
  const p = PRICE[model];
  if (!p) return null; // 料金表にないモデル
  return ((ain * (p.ain ?? p.in)) + tin * p.in + tout * p.out) / 1e6;
};
// ログイン中のユーザーが ALLOWED_EMAIL 本人かを確かめる
async function isAllowedUser(req: Request) {
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return false;
  const r = await fetch(`${env("SUPABASE_URL")}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: env("SUPABASE_ANON_KEY") },
  });
  if (!r.ok) return false;
  const u = await r.json();
  const allowed = env("ALLOWED_EMAIL").toLowerCase().split(",").map((x) => x.trim()).filter(Boolean);
  return !!u.email && allowed.includes(String(u.email).toLowerCase());
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POSTのみ対応" }, 405);
  if (!(await isAllowedUser(req))) return json({ error: "ログインし直してください" }, 401);
  try {
    await applyPrices();
    const ct = req.headers.get("content-type") ?? "";
    if (ct.includes("multipart/form-data")) {
      const form = await req.formData();
      if (form.get("action") !== "transcribe") return json({ error: "不明な処理" }, 400);
      return json(await transcribe(form));
    }
    const body = await req.json();
    if (body.action === "summarize") return json(await summarize(body));
    if (body.action === "save") return json(await saveToNotion(body));
    return json({ error: "不明な処理" }, 400);
  } catch (e) {
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});

// ---------- 文字起こし ----------
async function transcribe(form: FormData) {
  const file = form.get("file") as File;
  const engine = String(form.get("engine") ?? "openai");
  const model = String(form.get("model") ?? "");
  const hint = String(form.get("hint") ?? "");
  if (!file) throw new Error("音声ファイルがありません");
  if (engine === "gemini" && !env("GEMINI_API_KEY")) throw new Error("GEMINI_API_KEY が未登録です");

  if (engine === "gemini") {
    const prompt =
      "この音声を日本語で一字一句、文字起こししてください。要約や補足はせず、聞き取れた発言だけを出力してください。" +
      "話者が変わったと分かる場合は改行してください。" +
      (hint ? `\n次の言葉が出てくる可能性があります: ${hint}` : "");
    const m = model || await setting("minutes", "gemini_model", "gemini-3.5-flash");
    const d = await geminiAudio(m, file, prompt);
    const u = d.usageMetadata ?? {};
    const usd = usdOf(m, u.promptTokenCount ?? 0, (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0));
    return { text: geminiText(d), usd };
  }

  // OpenAI
  const fd = new FormData();
  fd.append("file", file, file.name || "audio.m4a");
  const om = model || await setting("minutes", "transcribe_model", "gpt-4o-transcribe");
  fd.append("model", om);
  fd.append("language", "ja");
  fd.append("response_format", "json");
  if (hint) fd.append("prompt", `次の言葉が出てくる可能性があります: ${hint}`);
  const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${env("OPENAI_API_KEY")}` },
    body: fd,
  });
  const d = await r.json();
  if (!r.ok) throw new Error(`OpenAI: ${d.error?.message ?? r.status}`);
  const u = d.usage ?? {};
  let usd: number | null = null;
  if (u.type === "duration" || PER_MIN[om] != null) {
    const sec = u.seconds ?? Number(form.get("seconds") ?? 0);
    usd = sec ? (sec / 60) * (PER_MIN[om] ?? WHISPER_PER_MIN) : null;
  } else if (u.input_tokens != null) {
    const ain = u.input_token_details?.audio_tokens ?? u.input_tokens;
    const tin = u.input_token_details?.text_tokens ?? 0;
    usd = usdOf(om, tin, u.output_tokens ?? 0, ain);
  }
  return { text: d.text ?? "", usd };
}

async function geminiAudio(model: string, file: File, prompt: string) {
  const b64 = encodeBase64(new Uint8Array(await file.arrayBuffer()));
  // iPhoneの録音は audio/mp4。通らなかった場合は audio/aac で再試行する
  const types = [file.type || "audio/mp4"];
  if (types[0].includes("mp4")) types.push("audio/aac");
  let lastErr = "";
  for (const mime of types) {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: { "x-goog-api-key": env("GEMINI_API_KEY"), "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ inline_data: { mime_type: mime.split(";")[0], data: b64 } }, { text: prompt }] }],
        }),
      },
    );
    const d = await r.json();
    if (r.ok) return d;
    lastErr = d.error?.message ?? String(r.status);
  }
  throw new Error(`Gemini: ${lastErr}`);
}

const geminiText = (d: any) =>
  (d.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? "").join("");

// ---------- 議事録化 ----------
const SUMMARY_PROMPT = `以下は会議・打ち合わせ・会話の文字起こしです。これをもとに日本語の議事録を作ってください。
文字起こしには聞き間違いが含まれることがあるので、文脈から自然な言葉に直してください。書かれていないことは推測で足さないでください。
次のJSONだけを出力してください（前後に説明文やコードブロックを付けない）:
{
  "title": "内容が分かる短いタイトル",
  "genre": "仕事 / 勉強会 / 家族 / 趣味 などのジャンルを1語で",
  "summary": "3〜5文の要約",
  "participants": ["分かる範囲の参加者"],
  "topics": [{"heading": "議題", "points": ["要点"]}],
  "decisions": ["決まったこと"],
  "todos": [{"task": "やること", "owner": "担当（不明なら空）", "due": "期限（不明なら空）"}]
}`;

const SEMINAR_PROMPT = `以下は製品や疾患に関するセミナー・講演の文字起こしです。製薬会社のMRがあとで見返して、医師との面談に活かせるノートを日本語で作ってください。
文字起こしには聞き間違いが含まれることがあります。薬剤名・疾患名・試験名は文脈から正しい表記に直してください。
数値・試験名・ガイドラインなどは、話された内容をそのまま正確に残し、話されていないことは推測で足さないでください。
次のJSONだけを出力してください（前後に説明文やコードブロックを付けない）:
{
  "title": "演題が分かる短いタイトル",
  "speaker": "演者名と所属（分かる範囲。不明なら空）",
  "summary": "3〜5文の要約",
  "keywords": ["疾患名・製品名・試験名など検索に使う語を3〜8個"],
  "topics": [{"heading": "セクションの見出し", "points": ["要点"]}],
  "data": ["出てきたデータ・エビデンス（試験名、対象、結果の数値などを1項目ずつ）"],
  "qa": [{"q": "質問", "a": "回答"}],
  "tips": ["医師との面談で話題にできそうなポイント"]
}`;

const DEAL_PROMPT = `以下は商談・提案・見積もり説明など、相手から説明を受けた場面の文字起こしです。説明を受けた側（自分）があとで見返して、検討や他社との比較に使えるノートを日本語で作ってください。
文字起こしには聞き間違いが含まれることがあるので、文脈から自然な言葉に直してください。
金額・数量・面積・期限・条件などは、話された内容をそのまま正確に残し、話されていないことは推測で足さないでください。
次のJSONだけを出力してください（前後に説明文やコードブロックを付けない）:
{
  "title": "相手と内容が分かる短いタイトル",
  "counterpart": "相手の会社名・担当者（分かる範囲。不明なら空）",
  "summary": "3〜5文の要約",
  "proposal": [{"heading": "提案・説明の項目", "points": ["内容"]}],
  "money": ["金額・見積もり・値引き・支払い・期限などの条件（1項目ずつ）"],
  "pros": ["良いと感じられる点・相手が強調した強み"],
  "cons": ["気になる点・リスク・注意点"],
  "qa": [{"q": "質問", "a": "回答"}],
  "todos": [{"task": "自分が確認・検討すること、相手からの宿題", "owner": "担当（自分・相手など。不明なら空）", "due": "期限（不明なら空）"}]
}`;

async function summarize(body: any) {
  const { transcript, engine = "claude", model = "", memo = "", mode = "meeting", quality = "standard" } = body;
  if (!transcript) throw new Error("文字起こしが空です");
  const prompt = mode === "seminar" ? SEMINAR_PROMPT : mode === "deal" ? DEAL_PROMPT : SUMMARY_PROMPT;
  const user = `${prompt}${memo ? `\n\n補足メモ: ${memo}` : ""}\n\n--- 文字起こし ---\n${transcript}`;
  let raw = "";
  let usd: number | null = null;
  const sm = model || (engine === "gemini"
    ? await setting("minutes", "gemini_model", "gemini-3.5-flash")
    : quality === "hq"
      ? await setting("minutes", "summary_model_hq", "claude-opus-5-5")
      : await setting("minutes", "summary_model", "claude-sonnet-5-5"));

  if (engine === "gemini") {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${sm}:generateContent`,
      {
        method: "POST",
        headers: { "x-goog-api-key": env("GEMINI_API_KEY"), "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: user }] }],
          generationConfig: { responseMimeType: "application/json" },
        }),
      },
    );
    const d = await r.json();
    if (!r.ok) throw new Error(`Gemini: ${d.error?.message ?? r.status}`);
    raw = geminiText(d);
    const u = d.usageMetadata ?? {};
    usd = usdOf(sm, u.promptTokenCount ?? 0, (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0));
  } else {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": env("ANTHROPIC_API_KEY"),
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: sm,
        max_tokens: 8000,
        messages: [{ role: "user", content: user }],
      }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(`Claude: ${d.error?.message ?? r.status}`);
    raw = (d.content ?? []).map((c: any) => c.text ?? "").join("");
    usd = usdOf(sm, d.usage?.input_tokens ?? 0, d.usage?.output_tokens ?? 0);
  }

  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("議事録の形式で返ってきませんでした");
  return { result: JSON.parse(m[0]), usd };
}

// ---------- Notion保存 ----------
const rt = (s: string) => [{ type: "text", text: { content: s } }];
const chunk = (s: string, n = 1900) => {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out;
};
const para = (s: string) => ({ object: "block", type: "paragraph", paragraph: { rich_text: rt(s) } });
const h2 = (s: string) => ({ object: "block", type: "heading_2", heading_2: { rich_text: rt(s) } });
const h3 = (s: string) => ({ object: "block", type: "heading_3", heading_3: { rich_text: rt(s) } });
const li = (s: string) => ({ object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: rt(s.slice(0, 1900)) } });
const todo = (s: string) => ({ object: "block", type: "to_do", to_do: { rich_text: rt(s.slice(0, 1900)), checked: false } });

async function notion(path: string, method: string, body: unknown) {
  const r = await fetch(`https://api.notion.com/v1/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env("NOTION_API_KEY", "NOTION_TOKEN")}`,
      "Notion-Version": "2025-09-03",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(`Notion: ${d.message ?? r.status}`);
  return d;
}

// ページを作り、100ブロックを超える分は後から足す
async function createPage(dataSourceId: string, properties: any, blocks: any[]) {
  const page = await notion("pages", "POST", {
    parent: { type: "data_source_id", data_source_id: dataSourceId },
    properties,
    children: blocks.slice(0, 100),
  });
  for (let i = 100; i < blocks.length; i += 100) {
    await notion(`blocks/${page.id}/children`, "PATCH", { children: blocks.slice(i, i + 100) });
  }
  return { url: page.url };
}
const todoBlocks = (todos: any[]) => todos.map((t) => {
  const extra = [t.owner && `担当: ${t.owner}`, t.due && `期限: ${t.due}`].filter(Boolean).join(" / ");
  return todo(extra ? `${t.task}（${extra}）` : t.task);
});
const topicBlocks = (topics: any[], fallback: string) => topics.flatMap((t) => [h3(t.heading || fallback), ...(t.points ?? []).map(li)]);

async function saveSeminar(body: any) {
  const { result: x, transcript = "", date, duration = "" } = body;
  const blocks: any[] = [];
  const meta = [x.speaker && `演者: ${x.speaker}`, duration && `録音時間: ${duration}`].filter(Boolean).join("　");
  if (meta) blocks.push(para(meta));
  blocks.push(h2("要約"), ...chunk(x.summary || "-").map(para));
  if (x.topics?.length) blocks.push(h2("要点"), ...topicBlocks(x.topics, "要点"));
  if (x.data?.length) blocks.push(h2("データ・エビデンス"), ...x.data.map(li));
  if (x.qa?.length) {
    blocks.push(h2("質疑応答"));
    for (const q of x.qa) blocks.push(li(`Q. ${q.q}`), para(`A. ${q.a}`));
  }
  if (x.tips?.length) blocks.push(h2("面談で使えるポイント"), ...x.tips.map(li));
  if (transcript) blocks.push(h2("文字起こし全文"), ...chunk(transcript).map(para));

  const kw = [...new Set((x.keywords ?? []).map((k: string) => String(k).replace(/,/g, " ").trim().slice(0, 90)).filter(Boolean))].slice(0, 10);
  return createPage(SEMINAR_DS(), {
    "名前": { title: rt(x.title || "セミナーノート") },
    "日付": { date: { start: date || new Date().toISOString().slice(0, 10) } },
    "演者": { rich_text: rt((x.speaker || "").slice(0, 1900)) },
    "キーワード": { multi_select: kw.map((name) => ({ name })) },
  }, blocks);
}

// 商談：議事録と同じデータベースに、商談向けの項目で保存する
async function saveDeal(body: any) {
  const { result: x, transcript = "", date, duration = "" } = body;
  const blocks: any[] = [];
  const meta = ["ジャンル: 商談", x.counterpart && `相手: ${x.counterpart}`, duration && `録音時間: ${duration}`].filter(Boolean).join("　");
  blocks.push(para(meta));
  blocks.push(h2("要約"), ...chunk(x.summary || "-").map(para));
  if (x.proposal?.length) blocks.push(h2("提案・説明の内容"), ...topicBlocks(x.proposal, "項目"));
  if (x.money?.length) blocks.push(h2("金額・条件"), ...x.money.map(li));
  if (x.pros?.length) blocks.push(h2("良い点"), ...x.pros.map(li));
  if (x.cons?.length) blocks.push(h2("気になる点"), ...x.cons.map(li));
  if (x.qa?.length) {
    blocks.push(h2("質疑応答"));
    for (const q of x.qa) blocks.push(li(`Q. ${q.q}`), para(`A. ${q.a}`));
  }
  if (x.todos?.length) blocks.push(h2("確認・検討すること"), ...todoBlocks(x.todos));
  if (transcript) blocks.push(h2("文字起こし全文"), ...chunk(transcript).map(para));
  return createPage(MINUTES_DS(), {
    "名前": { title: rt(x.title || "商談") },
    "日付": { date: { start: date || new Date().toISOString().slice(0, 10) } },
  }, blocks);
}

async function saveToNotion(body: any) {
  if (body.mode === "seminar") return saveSeminar(body);
  if (body.mode === "deal") return saveDeal(body);
  const { result: x, transcript = "", date, duration = "" } = body;
  const blocks: any[] = [];
  const meta = [`ジャンル: ${x.genre || "-"}`, duration && `録音時間: ${duration}`].filter(Boolean).join("　");
  blocks.push(para(meta));
  blocks.push(h2("要約"), ...chunk(x.summary || "-").map(para));
  if (x.participants?.length) blocks.push(h2("参加者"), para(x.participants.join("、")));
  if (x.topics?.length) blocks.push(h2("議題と要点"), ...topicBlocks(x.topics, "議題"));
  if (x.decisions?.length) blocks.push(h2("決定事項"), ...x.decisions.map(li));
  if (x.todos?.length) blocks.push(h2("ToDo"), ...todoBlocks(x.todos));
  if (transcript) blocks.push(h2("文字起こし全文"), ...chunk(transcript).map(para));
  return createPage(MINUTES_DS(), {
    "名前": { title: rt(x.title || "議事録") },
    "日付": { date: { start: date || new Date().toISOString().slice(0, 10) } },
  }, blocks);
}
