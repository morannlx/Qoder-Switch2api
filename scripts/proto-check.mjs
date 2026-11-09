/**
 * 反代协议契约自检：针对一个正在运行的反代实例，验证 ZCode 等客户端真正依赖的帧形状。
 * 运行：PROXY_BASE=http://127.0.0.1:7891 node scripts/proto-check.mjs
 */
const base = process.env.PROXY_BASE || 'http://127.0.0.1:7891';
const tests = [];
const t0 = Date.now();

// 1. chat stream usage frame contract
{
  const r = await fetch(base + '/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-flash', stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'hi' }] }),
  });
  const t = await r.text();
  const parsed = t.split('\n').filter(l => l.startsWith('data: ')).map(l => l.slice(6)).filter(d => d !== '[DONE]')
    .map(f => { try { return JSON.parse(f); } catch { return null; } }).filter(Boolean);
  const usageIdx = parsed.findIndex(c => c.usage);
  const finishIdx = parsed.findIndex(c => c.choices?.some(x => x.finish_reason));
  tests.push(['chat stream usage frame exists', usageIdx >= 0]);
  tests.push(['usage frame has empty choices', usageIdx >= 0 && Array.isArray(parsed[usageIdx].choices) && parsed[usageIdx].choices.length === 0]);
  tests.push(['finish frame precedes usage', finishIdx >= 0 && finishIdx < usageIdx]);
  tests.push(['usage has positive prompt_tokens', (parsed[usageIdx]?.usage?.prompt_tokens || 0) > 0]);
}

// 2. /v1/messages true streaming
{
  const r = await fetch(base + '/v1/messages', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-flash', max_tokens: 150, stream: true, messages: [{ role: 'user', content: 'count 1 to 3' }] }),
  });
  const t = await r.text();
  const evs = [...t.matchAll(/^event: (\w+)/gm)].map(m => m[1]);
  tests.push(['messages has message_start first', evs[0] === 'message_start']);
  tests.push(['messages has message_stop last', evs[evs.length - 1] === 'message_stop']);
  tests.push(['messages has message_delta', evs.includes('message_delta')]);
  tests.push(['messages blocks balanced', (evs.filter(e => e === 'content_block_start').length) === (evs.filter(e => e === 'content_block_stop').length)]);
  const delta = t.match(/event: message_delta\ndata: (.*)/);
  const du = delta ? JSON.parse(delta[1]) : null;
  tests.push(['messages usage has cache_read/cache_creation', du && 'cache_read_input_tokens' in du.usage && 'cache_creation_input_tokens' in du.usage]);
  tests.push(['messages usage output_tokens > 0', (du?.usage?.output_tokens || 0) > 0]);
}

// 3. /v1/models context window
{
  const r = await fetch(base + '/v1/models');
  const d = await r.json();
  const m = d.data.find(x => x.id !== 'auto' && x.id !== 'lite');
  tests.push(['models declares context_length', m?.context_length === 180000]);
  tests.push(['models declares max_input_tokens', m?.max_input_tokens === 180000]);
  tests.push(['models declares limit.context', m?.limit?.context === 180000]);
  tests.push(['models declares capabilities', !!m?.capabilities, JSON.stringify(m?.capabilities)]);
}

// 4. responses usage details
{
  const r = await fetch(base + '/v1/responses', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-flash', input: 'say ok', stream: false }),
  });
  const d = await r.json();
  tests.push(['responses usage has input_tokens_details', !!d.usage?.input_tokens_details]);
  tests.push(['responses usage has output_tokens_details', !!d.usage?.output_tokens_details]);
}

// 5. tool-call stream ordering for anthropic
{
  const r = await fetch(base + '/v1/messages', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-flash', max_tokens: 300, stream: true,
      tools: [{ name: 'get_weather', description: 'weather', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }],
      messages: [{ role: 'user', content: 'Weather in Beijing? You must call get_weather.' }],
    }),
  });
  const t = await r.text();
  const evs = [...t.matchAll(/^event: (\w+)/gm)].map(m => m[1]);
  tests.push(['tool round: blocks balanced', evs.filter(e => e === 'content_block_start').length === evs.filter(e => e === 'content_block_stop').length]);
  tests.push(['tool round: has tool_use block', t.includes('"type":"tool_use"')]);
  const stop = t.match(/"stop_reason":"(\w+)"/);
  tests.push(['tool round: stop_reason tool_use', stop?.[1] === 'tool_use', stop?.[1]]);
}

for (const [name, ok, extra] of tests) console.log((ok ? 'PASS' : 'FAIL').padEnd(5), name, extra || '');
const passed = tests.filter((t) => t[1]).length;
console.log('---');
console.log('passed', passed, '/', tests.length, 'in', Date.now() - t0, 'ms');
if (passed !== tests.length) process.exitCode = 1;
