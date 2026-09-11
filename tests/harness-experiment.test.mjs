import { it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadExperiment, experimentChecks } from '../harness/lib/experiment.mjs';
import capture from '../harness/scenarios/s01-capture.mjs';
import recall from '../harness/scenarios/s03-fresh-session-continuity.mjs';
import unrelated from '../harness/scenarios/s06-no-match-clean.mjs';

it('validates experiment selection and prevents disclosing the answer in the recall prompt', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'experiment-'));
  const file=path.join(dir,'config.json');
  try {
    fs.writeFileSync(file,JSON.stringify({clients:['claude'],prompts:{recall:{prompt:'{{marker}} {{value}}'}}}));
    expect(()=>loadExperiment(file,['claude'])).toThrow('must not disclose');
    fs.writeFileSync(file,JSON.stringify({clients:['claude'],scenarios:['recall']}));
    expect(()=>loadExperiment(file,['claude'])).toThrow('requires capture');
    expect(loadExperiment('harness/examples/simple.json',['claude','codex','hermes','nanoclaw']).scenarios).toHaveLength(3);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

it('runs the three Simple scenarios with exactly three client prompts and skips recall after failed capture', async () => {
  const home=fs.realpathSync(os.tmpdir()); let marker,value; const prompts=[];
  const ctx={options:{simple:true,quickSimple:true,indexGraceMs:0},meta:{},dirs:{home,run:home,logs:home},turns:[],writeJson:vi.fn(),evidenceDir:()=>home,subMarker:()=> 'TASK-simple'};
  const client={id:'claude',expectedCaptureLabel:'claude',runTurn:async ({prompt})=>{
    prompts.push(prompt);marker='TASK-simple';value ||= prompt.match(/VALUE-[a-f0-9]+/)?.[0];
    const n=prompts.length;
    return {client:'claude',sessionId:`session-${n}`,finalText:n===1?marker:n===2?value:'Canberra',exitCode:0,timedOut:false,isError:false,toolCalls:n===2?[{name:'midbrain__memory_search',input:{query:marker},result:value,ok:true}]:[],rawPath:path.join(home,'test.ndjson'),durationMs:1};
  }};
  const api={waitForRows:async()=>({rows:['user','assistant'].map((role,i)=>({id:i,role,text:role==='user'?prompts[0]:marker,memory_metadata:{client:'claude',session_id:'session-1',cwd:'~/'}})),elapsedMs:0,polls:1,timedOut:false})};
  for(const scenario of [capture,recall,unrelated]) await scenario.run({ctx,client,api,project:home});
  expect(prompts).toHaveLength(3);
  expect(prompts[1]).not.toContain(value);
  expect(prompts[0]).not.toContain('Reply with only this exact literal line');
  ctx.meta.s02Writes={};
  expect((await recall.run({ctx,client,api,project:home})).every(c=>c.status==='BLOCKED')).toBe(true);
  expect(prompts).toHaveLength(3);
});

it('checks custom answers separately from successful memory evidence', () => {
  const ctx={options:{experiment:{prompts:{recall:{criteria:{contains:['{{value}}'],memoryContains:['{{value}}']}}}}}};
  expect(experimentChecks(ctx,'recall',{finalText:'VALUE-test',toolCalls:[]},{value:'VALUE-test'}).map(c=>c.ok)).toEqual([true,false]);
});
