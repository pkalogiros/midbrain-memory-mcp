import fs from 'node:fs';
import path from 'node:path';
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const read = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const clients = {claude:'Claude Code',codex:'Codex',hermes:'Hermes',nanoclaw:'NanoClaw',pi:'Pi',opencode:'OpenCode'};
function filesIn(dir) { try { return fs.readdirSync(dir).filter(f => /\.(json|jsonl|ndjson|log|txt)$/.test(f)).map(f => path.join(dir,f)); } catch { return []; } }
export function failureTraces(report, runDir, round = '', models = report.run?.models || {}) {
  const groups = new Map();
  for (const cell of report.cells || []) {
    if (!['FAIL','BLOCKED','FLAKY'].includes(cell.status)) continue;
    const refs = (cell.evidence || []).filter(Boolean);
    const key = [cell.client,cell.scenario,refs.find(r=>/read-from-/.test(r))?.match(/read-from-[^./]+/)?.[0] || ''].join(':');
    if (!groups.has(key)) groups.set(key, {cell, rows:[], checks:[], refs:new Set()});
    const group=groups.get(key);group.rows.push(`${cell.row}: ${cell.status}`);group.checks.push(...(cell.checks||[]).filter(c=>!c.ok));refs.forEach(r=>group.refs.add(path.resolve(runDir,r)));
  }
  return [...groups.values()].map(({cell,rows,checks,refs})=>{
    // Scenario-owned evidence supplies context even when a prerequisite failed
    // before the scenario could attach file references to its result.
    const dir=path.join(runDir,'evidence',cell.client,cell.scenario);
    filesIn(dir).forEach(f=>refs.add(f));
    const files=[...refs].filter(f=>f.startsWith(path.resolve(runDir)+path.sep)&&fs.existsSync(f));
    const turns=files.filter(f=>f.endsWith('.json')).map(file=>({file,turn:read(file)})).filter(x=>x.turn?.client===cell.client&&Array.isArray(x.turn.toolCalls));
    const prompts=files.filter(f=>f.endsWith('.prompt.json')).map(f=>read(f)).filter(Boolean);
    const values=[...new Set(checks.flatMap(c=>c.name.match(/VALUE-[a-zA-Z0-9_-]+/g)||[]))];
    const blocks=turns.map(({file,turn:t})=>{
      const calls=t.toolCalls||[];
      const toolRows=calls.map((c,i)=>{
        const text=typeof c.result==='string'?c.result:JSON.stringify(c.result??'');
        const found=values.filter(v=>text.includes(v));
        const problem=text.match(/Memory search failed:[^\n]+|CONNECT_TIMEOUT|Connection closed|Permission[^\n]*denied/i)?.[0];
        const spilled=text.match(/Output has been saved to ([^\n]+)/)?.[1];
        const memory=/midbrain/i.test(c.name||'')||/midbrain/i.test(c.server||'');
        const query=memory?(c.input?.query||c.input?.arguments?.query||''):'';
        const result=problem?`Reported problem: ${problem}`:spilled?'Large result saved to a file; see the subsequent read and native transcript.':found.length?`Expected value present: ${found.join(', ')}`:c.result==null?'No result recorded.':`Result recorded (${text.length} characters).${values.length?' Expected value not present in this result.':''}`;
        return `<tr><td>${i+1}</td><td>${esc(c.name)}</td><td>${esc(query || (memory?'Query not recorded as a separate field.':'See native evidence for input; shell commands are not embedded.'))}</td><td>${esc(result)}</td></tr>`;
      }).join('');
      const memoryCalls=calls.filter(c=>/midbrain/i.test(c.name||'')||/midbrain/i.test(c.server||''));
      const contextValues=values.filter(v=>calls.some(c=>JSON.stringify(c.result??'').includes(v)));
      return `<section><h4>${esc(path.basename(file))}</h4><p><strong>Prompt sent:</strong></p><pre>${esc(t.prompt||'Not recorded.')}</pre><p><strong>Memory in recorded tool context:</strong> ${contextValues.length?esc(contextValues.join(', '))+' appeared in a tool result delivered to the client.':values.length?'The expected value does not appear in the recorded inline results. Check file-backed results before concluding it was unavailable.':'This check does not identify a hidden value to search for; inspect the tool results in the native evidence.'}</p><p><strong>MidBrain use:</strong> ${memoryCalls.length} recorded calls. ${memoryCalls.length?'Calls establish that the named tools were exposed in this turn.':'No recorded call does not prove that the tool was unavailable; discovery and native logs must establish that.'}</p><div class="scroll"><table><thead><tr><th>Order</th><th>Tool</th><th>Memory query</th><th>Recorded result</th></tr></thead><tbody>${toolRows||'<tr><td colspan="4">No tool calls recorded.</td></tr>'}</tbody></table></div><p><strong>Final answer:</strong></p><pre>${esc(t.finalText||'No final answer recorded.')}</pre><p><strong>Runtime:</strong> exit ${esc(t.exitCode??'not recorded')}; timed out: ${esc(t.timedOut??'not recorded')}; error flag: ${esc(t.isError??'not recorded')}.</p>${t.errorDetail?`<p>${esc(t.errorDetail)}</p>`:''}${(t.hookFailures||[]).map(e=>`<p><strong>Hook event:</strong> ${esc(e)}</p>`).join('')}${(t.recoveredErrors||[]).map(e=>`<p><strong>Recovered error:</strong> ${esc(e)}</p>`).join('')}</section>`;
    }).join('');
    return `<details><summary>${esc([round,clients[cell.client]||cell.client,models[cell.client]||'model not recorded',cell.scenario].filter(Boolean).join(' · '))}</summary><p>${esc(rows.join('; '))}</p><p><strong>Expected:</strong> ${esc(cell.expected||checks.map(c=>c.name).join('; ')||'See the prerequisite failure below.')}</p>${cell.blockedReason?`<p><strong>Prerequisite failure:</strong> ${esc(cell.blockedReason)}</p>`:''}${blocks||`<p>No normalized client turn is available for this check. This does not establish whether a model request started. Inspect the native files below.</p>${prompts.map(p=>`<pre>${esc(p.prompt||'Prompt not recorded.')}</pre>`).join('')}`}<p><strong>Exact assertions that did not pass:</strong></p><ul>${checks.map(c=>`<li>${esc(c.name)}${c.detail?` — ${esc(c.detail)}`:''}</li>`).join('')||'<li>No failed assertion; a prerequisite blocked evaluation.</li>'}</ul><p><strong>Native evidence:</strong> transcripts contain the recorded messages/tool results, including file reads; container and hook logs show runtime events. They do not necessarily expose the provider’s complete assembled context.</p><ul>${files.map(f=>`<li><a href="${esc(f)}">${esc(path.relative(runDir,f))}</a></li>`).join('')||'<li>No evidence files recorded.</li>'}</ul></details>`;
  }).join('\n');
}
export function addFailureTraces(directory, modelRounds = []) {
  const sweep=read(path.join(directory,'sweep.json'));
  let rounds;
  if(sweep) rounds=sweep.rounds.filter(r=>r.report).map(r=>({name:r.name,models:r.models,dir:path.dirname(r.report)}));
  else if(fs.existsSync(path.join(directory,'runs'))||fs.existsSync(path.join(directory,'fast','runs'))) {
    rounds=['fast','sonnet'].flatMap(name=>{const base=path.join(directory,name,'runs');try{return fs.readdirSync(base).map(id=>({name,dir:path.join(base,id)}));}catch{return [];}});
  } else rounds=[{name:'',dir:directory}];
  const content=rounds.map(r=>{const report=read(path.join(r.dir,'results.json'))||read(path.join(r.dir,'results.partial.json'));return report?failureTraces(report,r.dir,r.name,r.models || modelRounds.find(m=>m.name===r.name)?.models):'';}).join('\n');
  const section=`<!-- failure-traces:start --><section id="failure-traces"><style>#failure-traces pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#edf2ed;padding:14px}#failure-traces a{overflow-wrap:anywhere}#failure-traces section{margin:20px 0;padding:12px 0;border-top:1px solid #d6dfd7}</style><h2>Debug traces for failed and blocked tests</h2><p>Recorded evidence, not inferred model context. Each trace shows what was sent, which tools ran, what results were recorded, and what the client answered. Native files stay separate; this page embeds no raw transcript or private test-home configuration.</p>${content||'<p>No failed checks recorded in the available checkpoint.</p>'}</section><!-- failure-traces:end -->`;
  const out=path.join(directory,'failure-traces.html');
  fs.writeFileSync(out,`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Failure debug traces</title><style>body{font:16px system-ui;background:#f5f7f4;color:#18382c;max-width:1100px;margin:32px auto;padding:16px}details{background:white;padding:20px;margin:16px 0;border:1px solid #cad7ce;border-radius:8px}summary{font-weight:650;cursor:pointer}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#edf2ed;padding:14px}td,th{padding:10px;border-bottom:1px solid #ccd8cc;text-align:left;vertical-align:top}table{width:100%;font-size:14px}a,td{overflow-wrap:anywhere}.scroll{overflow:auto}</style>${section}`);
  const main=path.join(directory,'report.html');if(fs.existsSync(main)){let html=fs.readFileSync(main,'utf8').replace(/<!-- failure-traces:start -->[\s\S]*?<!-- failure-traces:end -->/g,'');html=html.replace('<footer>',section+'<footer>');fs.writeFileSync(main,html);}
  return out;
}
if(process.argv[1]===new URL(import.meta.url).pathname&&process.argv[2]) console.log(addFailureTraces(process.argv[2]));
