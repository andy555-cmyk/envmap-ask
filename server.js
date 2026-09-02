/* 환경분석맵 — 현장 질문 답변 프록시
 *
 * 왜 프록시인가: API 키를 HTML 에 넣을 수 없다(프로젝트 절대 규칙).
 * 키는 이 서버의 환경변수에만 있고, 브라우저는 키를 본 적이 없다.
 *
 * 카드(근거)는 서버에 두지 않는다. 페이지가 이미 갖고 있는 것을 요청에 실어 보낸다.
 * 사본을 만들면 언젠가 어긋난다 — 이 프로젝트에서 이미 여러 번 겪었다.
 *
 * 필수 환경변수
 *   GEMINI_API_KEY   제미나이 키
 *   ASK_PASS         접속 암호 (대표·남실장님 두 사람만 쓴다)
 * 선택
 *   ASK_MODEL        기본 gemini-2.0-flash
 *   ASK_ORIGIN       허용 오리진 (기본: 라이브 주소)
 *   ASK_MONTH_CAP    월 최대 호출 수 (기본 3000)
 */
const http = require('http');

/* 응답을 못 돌려주고 연결이 끊기면 브라우저에는 "Failed to fetch" 만 보인다.
   원인을 못 보는 것이 가장 큰 문제라, 무슨 일이 있어도 JSON 으로 답하게 만든다. */
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
process.on('uncaughtException',  (e) => console.error('[uncaughtException]', e));

const KEY    = process.env.GEMINI_API_KEY || '';
const PASS   = process.env.ASK_PASS || '';
/* 모델은 예고 없이 만료된다(2026-09-02 실측: gemini-2.0-flash 404).
   그때마다 사람이 환경변수를 고치게 하지 않는다 — 서버가 스스로 넘어간다. */
const MODEL  = process.env.ASK_MODEL || 'gemini-3.6-flash';
let ACTIVE = MODEL;                      // 실제로 동작하는 모델 (실행 중 갱신)
const ORIGIN = process.env.ASK_ORIGIN || 'https://web-gijang-map-mrksc1tcf2e7efab.sel3.cloudtype.app';
const CAP    = parseInt(process.env.ASK_MONTH_CAP || '3000', 10);
const PORT   = process.env.PORT || 8080;

let month = new Date().toISOString().slice(0, 7);
let used = 0;

const SYS = [
  '너는 도시재생 현황분석 지도의 현장 답변 보조다.',
  '담당 공무원 앞에서 실무자가 질문을 받았을 때 즉답을 돕는 것이 역할이다.',
  '',
  '절대 규칙:',
  '1. 아래 [근거 카드]에 있는 내용만으로 답한다. 카드에 없는 수치·사실을 절대 만들지 않는다.',
  '2. 카드로 답할 수 없으면 "그 자료는 이 지도에 없습니다"라고 분명히 말하고 끝낸다.',
  '   추측하거나 일반 상식으로 메우지 않는다. 현장에서 틀린 숫자를 말하는 것이 모른다고 하는 것보다 훨씬 나쁘다.',
  '3. 수치를 말할 때는 반드시 출처와 기준일과 공간단위를 함께 말한다.',
  '   공무원은 "그거 언제 자료예요?" "어디 기준이에요?"를 반드시 묻는다.',
  '4. 카드에 한계(주의)가 적혀 있으면 반드시 함께 전달한다. 특히 서로 합산하면 안 되는 수치는 그 사실을 먼저 말한다.',
  '5. 공간단위가 다른 수치를 한 문장에서 비교하지 않는다.',
  '6. 한국어 존댓말. 현장에서 그대로 읽을 수 있게 3~5문장으로 짧게. 사족 없이.',
].join('\n');

function send(res, code, obj) {
  try {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': ORIGIN,
    'Access-Control-Allow-Headers': 'content-type,x-ask-pass',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(obj));
  } catch (e) { try { res.end(); } catch (_) {} console.error('[send]', e && e.message); }
}

async function ask(q, cards, region) {
  const ctx = cards.map((c, i) =>
    `[카드 ${i + 1}] ${c.q}\n답: ${c.a}\n출처: ${c.s} / 기준: ${c.d} / 공간단위: ${c.u}` +
    (c.l ? `\n한계: ${c.l}` : '')
  ).join('\n\n');

  const prompt = `${SYS}\n\n대상 지역: ${region || '(미지정)'}\n\n[근거 카드]\n${ctx || '(없음)'}\n\n[질문]\n${q}`;

  return callModel(prompt, ACTIVE, true);
}

async function callModel(prompt, model, allowFallback) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 25000);
  let r, raw;
  try {
    r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      { method: 'POST', signal: ac.signal,
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': KEY },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.1,
            /* ⚠ 2026-09-02 실측 — Gemini 3.x 는 '사고(thinking)' 토큰이 출력 한도를 먼저 먹는다.
               500 으로 두었더니 답이 24자에서 잘렸다. 한도를 넉넉히 주고 사고를 끈다. */
            maxOutputTokens: 2048,
            thinkingConfig: { thinkingBudget: 0 },
          },
        }) }
    );
    raw = await r.text();
  } catch (e) {
    throw new Error('upstream 연결 실패: ' + String(e && e.message || e).slice(0, 160));
  } finally { clearTimeout(timer); }

  if (!r.ok) {
    /* 만료 안내에 후속 모델명이 들어 있다. 한 번만 그 모델로 다시 시도하고, 성공하면 그걸로 고정한다 */
    const m = raw.match(/use\s+models\/([A-Za-z0-9.\-]+)/);
    if (allowFallback && r.status === 404 && m && m[1] && m[1] !== model) {
      console.log('[model] ' + model + ' 만료 → ' + m[1] + ' 로 전환');
      const out = await callModel(prompt, m[1], false);
      ACTIVE = m[1];
      return out;
    }
    throw new Error('gemini ' + r.status + ' — ' + raw.replace(/\s+/g, ' ').slice(0, 240));
  }
  let j; try { j = JSON.parse(raw); } catch (e) { throw new Error('gemini 응답 파싱 실패: ' + raw.slice(0, 200)); }
  const c = j && j.candidates && j.candidates[0];
  const parts = c && c.content && c.content.parts;
  const t = (parts || []).map((p) => p && p.text).filter(Boolean).join('');
  if (!t) {
    /* 왜 비었는지 알려준다 — 안전필터·토큰한도 등 */
    throw new Error('응답 없음 (finishReason=' + ((c && c.finishReason) || '?') + ')');
  }
  if (c && c.finishReason === 'MAX_TOKENS') return t.trim() + ' …(길이 제한으로 잘림)';
  return t.trim();
}

http.createServer((req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  if (req.url === '/health') return send(res, 200, { ok: true, model: ACTIVE, configured: MODEL, used, cap: CAP, month });
  const isDiag = req.method === 'POST' && req.url === '/diag';
  if (!isDiag && !(req.method === 'POST' && req.url === '/ask')) return send(res, 404, { error: 'not found' });

  if (!KEY)  return send(res, 500, { error: 'GEMINI_API_KEY 미설정' });
  if (!PASS) return send(res, 500, { error: 'ASK_PASS 미설정' });
  if (req.headers['x-ask-pass'] !== PASS) return send(res, 401, { error: '암호가 다릅니다' });

  const m = new Date().toISOString().slice(0, 7);
  if (m !== month) { month = m; used = 0; }
  if (used >= CAP) return send(res, 429, { error: `이번 달 한도(${CAP}회)를 다 썼습니다` });

  let body = '';
  req.on('data', (d) => { body += d; if (body.length > 200000) req.destroy(); });
  req.on('end', async () => {
    try {
      const p = JSON.parse(body || '{}');
      const q = (p.q || '').trim();
      if (!q) return send(res, 400, { error: '질문이 비었습니다' });
      const cards = Array.isArray(p.cards) ? p.cards.slice(0, 12) : [];
      if (isDiag) {
        /* 키·모델이 실제로 동작하는지 확인만 한다. 실패해도 원문을 그대로 돌려준다 */
        try { const a = await ask('연결 확인', [], ''); return send(res, 200, { diag: 'ok', sample: a.slice(0, 120) }); }
        catch (e) { return send(res, 200, { diag: 'fail', reason: String(e.message || e).slice(0, 400) }); }
      }
      used++;
      const answer = await ask(q, cards, p.region);
      send(res, 200, { answer, cards: cards.length, used, cap: CAP });
    } catch (e) {
      send(res, 502, { error: String(e.message || e).slice(0, 300) });
    }
  });
}).listen(PORT, () => console.log('ask proxy on', PORT, 'model', ACTIVE));
