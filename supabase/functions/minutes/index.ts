// 議事録アプリ用 Supabase Edge Function
// action: transcribe（文字起こし） / summarize（議事録化） / save（Notion保存）
// 使うシークレット: APP_PASSCODE, openai_api_key, ANTHROPIC_API_KEY, NOTION_API_KEY, GEMINI_API_KEY（Gemini使用時のみ）
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
// 料金表（USD／100万トークン）。2026年11月時点の公表価格。変わったらここを直す
const PRICE: Record<string, { ain?: number; in: number; out: number }> = {
  "gpt-4o-transcribe": { ain: 6, in: 2.5, out: 10 },
  "gpt-4o-mini-transcribe": { ain: 3, in: 1.25, out: 5 },
  "claude-sonnet-5-5": { in: 2, out: 10 },
  "claude-opus-5-5": { in: 4, out: 20 },
  "gemini-3.5-flash": { in: 1.5, out: 9 },
  "gemini-3.5-flash-lite": { in: 0.3, out: 2.5 },
};
const WHISPER_PER_MIN = 0.006;
const usdOf = (model: string, tin: number, tout: number, ain = 0) => {
  const p = PRICE[model];
  if (!p) return null; // 料金表にないモデル
  return ((ain * (p.ain ?? p.in)) + tin * p.in + tout * p.out) / 1e6;
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POSTのみ対応" }, 405);
  if (!env("APP_PASSCODE") || req.headers.get("x-app-passcode") !== env("APP_PASSCODE")) {
    return json({ error: "パスコードが違います" }, 401);
  }
  try {
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
    const m = model || "gemini-3.5-flash";
    const d = await geminiAudio(m, file, prompt);
    const u = d.usageMetadata ?? {};
    const usd = usdOf(m, u.promptTokenCount ?? 0, (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0));
    return { text: geminiText(d), usd };
  }

  // OpenAI
  const fd = new FormData();
  fd.append("file", file, file.name || "audio.m4a");
  const om = model || "gpt-4o-transcribe";
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
  if (u.type === "duration" || om === "whisper-1") {
    const sec = u.seconds ?? Number(form.get("seconds") ?? 0);
    usd = sec ? (sec / 60) * WHISPER_PER_MIN : null;
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

async function summarize(body: any) {
  const { transcript, engine = "claude", model = "", memo = "" } = body;
  if (!transcript) throw new Error("文字起こしが空です");
  const user = `${SUMMARY_PROMPT}${memo ? `\n\n補足メモ: ${memo}` : ""}\n\n--- 文字起こし ---\n${transcript}`;
  let raw = "";
  let usd: number | null = null;

  if (engine === "gemini") {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model || "gemini-3.5-flash"}:generateContent`,
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
    usd = usdOf(model || "gemini-3.5-flash", u.promptTokenCount ?? 0, (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0));
  } else {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": env("ANTHROPIC_API_KEY"),
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: model || "claude-sonnet-5-5",
        max_tokens: 8000,
        messages: [{ role: "user", content: user }],
      }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(`Claude: ${d.error?.message ?? r.status}`);
    raw = (d.content ?? []).map((c: any) => c.text ?? "").join("");
    usd = usdOf(model || "claude-sonnet-5-5", d.usage?.input_tokens ?? 0, d.usage?.output_tokens ?? 0);
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

async function saveToNotion(body: any) {
  const { result: x, transcript = "", date, duration = "" } = body;
  const blocks: any[] = [];
  const meta = [`ジャンル: ${x.genre || "-"}`, duration && `録音時間: ${duration}`].filter(Boolean).join("　");
  blocks.push(para(meta));
  blocks.push(h2("要約"), ...chunk(x.summary || "-").map(para));
  if (x.participants?.length) blocks.push(h2("参加者"), para(x.participants.join("、")));
  if (x.topics?.length) {
    blocks.push(h2("議題と要点"));
    for (const t of x.topics) {
      blocks.push(h3(t.heading || "議題"));
      for (const p of t.points ?? []) blocks.push(li(p));
    }
  }
  if (x.decisions?.length) blocks.push(h2("決定事項"), ...x.decisions.map(li));
  if (x.todos?.length) {
    blocks.push(h2("ToDo"));
    for (const t of x.todos) {
      const extra = [t.owner && `担当: ${t.owner}`, t.due && `期限: ${t.due}`].filter(Boolean).join(" / ");
      blocks.push(todo(extra ? `${t.task}（${extra}）` : t.task));
    }
  }
  if (transcript) blocks.push(h2("文字起こし全文"), ...chunk(transcript).map(para));

  const page = await notion("pages", "POST", {
    parent: { type: "data_source_id", data_source_id: MINUTES_DS() },
    properties: {
      "名前": { title: rt(x.title || "議事録") },
      "日付": { date: { start: date || new Date().toISOString().slice(0, 10) } },
    },
    children: blocks.slice(0, 100),
  });
  for (let i = 100; i < blocks.length; i += 100) {
    await notion(`blocks/${page.id}/children`, "PATCH", { children: blocks.slice(i, i + 100) });
  }
  return { url: page.url };
}
