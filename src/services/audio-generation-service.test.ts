import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SharedDb, type OutboxRow } from "../shared/sqlite.js";
import { V3StateRepository } from "./v3-state-repository.js";
import { AudioGenerationService, audioDay, permitsAutomaticVoice, type AudioJob } from "./audio-generation-service.js";
import { AudioSettingsService } from "./audio-settings-service.js";
import { AudioProviderError, SeedAudioProvider, type GeneratedAudio } from "./seed-audio-provider.js";
import { deliverOutboxRow, markOutboxDeliveryFailed } from "../index-ingress.js";
import { NapCatActionOutcomeUnknownError } from "../napcat-reverse-server.js";

const bytes = Buffer.from("ID3-test-audio"), baseNow = Date.parse("2026-10-30T03:00:00Z");
const audio = (caption = "你好", duration = 2): GeneratedAudio => ({ bytes, duration, originalDuration: duration, caption });
async function fixture(run: (args: { repo:V3StateRepository; db:SharedDb; root:string; settings:AudioSettingsService }) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(),"ubot-audio-")), db = new SharedDb(path.join(root,"state.db"));
  try {
    const repo = new V3StateRepository(db,{stateEncryptionKey:"0".repeat(64)}); repo.markCutover();
    repo.saveCapabilityPolicy({version:1,enabledCapabilities:["conversation"],updatedAt:new Date().toISOString()});
    for (const groupId of ["10001","10002"]) repo.saveGroup({groupId,enabled:true,currentSkillId:"huixian",allowedSkillIds:["huixian"],switcherUserIds:[],liveChatUserIds:[],audioReplyEnabled:true,singingEnabled:true});
    const settings = new AudioSettingsService(repo);
    await run({repo,db,root:path.join(root,"audio-assets"),settings});
  } finally { db.close(); await rm(root,{recursive:true,force:true}); }
}
const enable = (settings:AudioSettingsService) => settings.update({enabled:true,apiKey:"fixture-audio-credential"},settings.get().revision,"operator");

test("audio settings default off, encrypt the independent key and never expose it in reads or audit", async()=>fixture(async({repo,db,settings})=>{
  assert.equal(settings.get().enabled,false); const revision = settings.get().revision;
  enable(settings);
  assert.equal(settings.get().hasApiKey,true);assert.equal(settings.internal().apiKey,"fixture-audio-credential");
  assert.doesNotMatch(JSON.stringify(settings.get()),/fixture-audio-credential/);
  assert.doesNotMatch(JSON.stringify(repo.listDocuments("admin-operation")),/fixture-audio-credential/);
  const row=db.db.prepare("SELECT ciphertext FROM v3_system_secrets WHERE secret_key='audio_generation:api_key'").get() as {ciphertext:string};
  assert.doesNotMatch(row.ciphertext,/fixture-audio-credential/);
  assert.throws(()=>settings.update({enabled:false},revision,"operator"),/target_changed/);
  settings.update({enabled:false,apiKey:""},settings.get().revision,"operator");
  assert.deepEqual(repo.getCapabilityPolicy()?.enabledCapabilities,["conversation"]);
  assert.equal(settings.get().hasApiKey,false);
}));
test("Seed audio requests use the separate X-Api-Key once and validate bounded MP3 output and original duration",async()=>{
  let calls=0;
  const provider = new SeedAudioProvider(async(url,init)=>{
    calls++;assert.equal(String(url),"https://openspeech.bytedance.com/api/v3/tts/create");
    assert.equal(new Headers(init?.headers).get("X-Api-Key"),"test-key");
    const body=JSON.parse(String(init?.body)); assert.equal(body.model,"seed-audio-1.0"); assert.equal(body.audio_config.enable_subtitle,true);assert.equal(body.audio_config.format,"mp3"); assert.equal(body.references,undefined);
    return Response.json({code:0,audio:bytes.toString("base64"),duration:2,original_duration:2.4,subtitle:{text:"你好"}});
  });
  assert.equal((await provider.generate("test-key","speech","你好")).originalDuration,2.4); assert.equal(calls,1);
  for (const [status,unknown] of [[400,false],[500,true]] as const) await assert.rejects(new SeedAudioProvider(async()=>new Response("private provider body",{status})).generate("key","speech","你好"),e=>e instanceof AudioProviderError && e.outcomeUnknown===unknown && !e.message.includes("private"));
  await assert.rejects(new SeedAudioProvider(async()=>Response.json({code:0,audio:bytes.toString("base64"),duration:2,original_duration:121})).generate("key","speech","你好"),/audio_result_unknown/);
});
test("audio reserves the maximum before calling, persists one request and publishes caption before an asset reference",async()=>fixture(async({repo,db,root,settings})=>{
  enable(settings);let calls=0;
  const service:AudioGenerationService=new AudioGenerationService(repo,root,{async generate():Promise<GeneratedAudio>{calls++;assert.equal(service.usage().reservedSeconds,120);return audio();}},()=>baseNow);
  const args={groupId:"10001",userId:"20001",kind:"speech" as const,text:"你好",sourceKey:"source-1"};
  const job=service.enqueue(args);assert.equal(service.enqueue(args).id,job.id);
  await Promise.all([service.tick(),new AudioGenerationService(repo,root,{async generate(){throw new Error("must not run");}},()=>baseNow).tick()]);
  assert.equal(calls,1);assert.equal(service.usage().chargedSeconds,2);assert.equal(service.usage().reservedSeconds,0);
  const rows=db.db.prepare("SELECT * FROM outbox ORDER BY id").all() as unknown as OutboxRow[];
  assert.deepEqual(rows.map(r=>r.kind),["audio_caption","audio_asset"]);assert.equal(rows[1]!.text,job.id);assert.doesNotMatch(JSON.stringify(rows),/base64|ID3/);
  const saved=repo.getDocument<AudioJob>("audio-job",job.id,job);assert.equal(saved.text,undefined);
  const sent:string[]=[];const transport={async sendGroupMessage(_g:string,text:string){sent.push(text);return{messageId:"caption-1"};},async sendGroupImage(){},async sendGroupAudio(_g:string,file:string){sent.push(file);return{messageId:"audio-1"};}};
  await assert.rejects(deliverOutboxRow(db,transport,rows[1]!,baseNow,undefined,undefined,undefined,service.assets),/audio_caption_unconfirmed/);
  assert.equal(sent.length,0);
  await deliverOutboxRow(db,transport,rows[0]!,baseNow,undefined,undefined,undefined,service.assets);
  await deliverOutboxRow(db,transport,rows[1]!,baseNow,undefined,undefined,undefined,service.assets);
  assert.equal(sent[0],"【语音字幕】你好");assert.ok(sent[1]!.startsWith("base64://"));
  await assert.rejects(service.assets.load(job.id,"10001"),/audio_asset_unavailable/);
  await assert.rejects(readFile(path.join(root,`${job.id}.mp3`)),/ENOENT/);
  await service.tick();assert.equal(repo.getDocument<AudioJob>("audio-job",job.id,job).status,"succeeded");
}));
test("unknown paid results retain reservation and are never retried across restarts; shared daily budget stops new requests",async()=>fixture(async({repo,root,settings})=>{
  enable(settings);let calls=0;
  const provider={async generate(){calls++;throw new AudioProviderError("audio_result_unknown",true);}};
  const service=new AudioGenerationService(repo,root,provider,()=>baseNow);
  for(let i=0;i<16;i++){service.enqueue({groupId:"10001",userId:"20001",kind:"speech",text:"你好",sourceKey:String(i)});await new AudioGenerationService(repo,root,provider,()=>baseNow).tick();}
  assert.equal(calls,15);assert.equal(service.usage().reservedSeconds,1800);assert.equal(service.usage().recent.filter(j=>j.status==="skipped").length,1);
  await service.tick();assert.equal(calls,15);
}));
test("caption mismatch falls back to complete text and accounts the paid audio; files are hash checked and group scoped",async()=>fixture(async({repo,db,root,settings})=>{
  enable(settings);const service=new AudioGenerationService(repo,root,{async generate(){return audio("改写过的内容",3);}},()=>baseNow);
  service.enqueue({groupId:"10001",userId:"20001",kind:"speech",text:"你好"});await service.tick();
  assert.equal(service.usage().chargedSeconds,3);
  const notices=db.db.prepare("SELECT kind,text FROM outbox").all() as Array<{kind:string;text:string}>;
  assert.equal(notices.length,1);assert.match(JSON.parse(notices[0]!.text).text,/先发文字：你好/);
  const id="audio-"+"a".repeat(32);await service.assets.save(id,"10001",audio());
  await assert.rejects(service.assets.load(id,"10002"),/audio_asset_unavailable/);
  await writeFile(path.join(root,`${id}.mp3`),Buffer.from("ID3-test-other"));
  await assert.rejects(service.assets.load(id,"10001"),/audio_asset_invalid/);
}));
test("audio queue bounds waiting work, honors group closure, song cooldowns, and restart recovery",async()=>fixture(async({repo,db,root,settings})=>{
  enable(settings);let calls=0;
  const service=new AudioGenerationService(repo,root,{async generate(){calls++;return audio("原创歌词",20);}},()=>baseNow);
  const song=service.enqueue({groupId:"10001",userId:"20001",kind:"song",text:"摸鱼"});
  assert.throws(()=>service.enqueue({groupId:"10001",userId:"20002",kind:"song",text:"午饭"}),/audio_cooldown/);
  for(let i=0;i<3;i++)service.enqueue({groupId:"10002",userId:"20001",kind:"speech",text:"你好"});
  assert.throws(()=>service.enqueue({groupId:"10002",userId:"20001",kind:"speech",text:"你好"}),/audio_queue_full/);
  repo.saveGroup({...repo.getGroup("10002")!,audioReplyEnabled:false});await service.tick();assert.equal(calls,1);
  const stored=repo.getDocument<AudioJob>("audio-job",song.id,song);assert.equal(stored.status,"queued_delivery");
  const pending=service.enqueue({groupId:"10001",userId:"20001",kind:"speech",text:"你好"});
  repo.saveDocument("audio-job",pending.id,{...pending,status:"running",startedAt:baseNow-160_000,day:audioDay(baseNow),reservedSeconds:120});
  await service.tick();assert.equal(calls,1);assert.equal(service.usage().reservedSeconds,120);
  const assetRow=db.db.prepare("SELECT * FROM outbox WHERE kind='audio_asset'").get() as unknown as OutboxRow;
  assert.equal(markOutboxDeliveryFailed(db,assetRow,new NapCatActionOutcomeUnknownError("unknown")),"terminal");
  assert.ok(await service.assets.load(song.id,"10001"));
}));
test("automatic voice only accompanies short directed casual replies outside Beijing quiet hours",()=>{
  const args={directed:true,input:"今天吃什么",reply:"来碗热腾腾的面吧"};
  assert.equal(permitsAutomaticVoice(args,baseNow,()=>0),true);assert.equal(permitsAutomaticVoice(args,baseNow,()=>0.1),false);
  for(const patch of [{directed:false},{automaticReply:true},{knowledge:true},{input:"急救怎么办"},{reply:"https://example.com"},{reply:"长".repeat(121)}])assert.equal(permitsAutomaticVoice({...args,...patch},baseNow,()=>0),false);
  assert.equal(permitsAutomaticVoice(args,Date.parse("2026-10-30T17:00:00Z"),()=>0),false);
  assert.equal(audioDay(Date.parse("2026-10-30T16:00:00Z")),"2026-10-31");
});
