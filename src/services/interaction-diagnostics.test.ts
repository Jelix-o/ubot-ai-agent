import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SharedDb } from "../shared/sqlite.js";
import { InteractionDiagnostics } from "./interaction-diagnostics.js";

test("interaction diagnostics isolate groups, accept only numeric counters and prune seven-day metadata",t=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),"ubot-interaction-diagnostics-")),db=new SharedDb(path.join(dir,"state.db"));
  t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
  const store=new InteractionDiagnostics(db),now=Date.now();
  store.record("10001","meme","probability_miss",{count:1,chat:"private chat" as unknown as number},now);
  store.record("10002","poke","queued",{},now);
  assert.equal(store.list("10001").length,1);
  assert.deepEqual(store.list("10001")[0]?.metrics,{count:1});
  assert.doesNotMatch(JSON.stringify(store.list("10001")),/private chat/);
  store.record("10001","meme","private chat",{},now);
  assert.equal(store.list("10001").length,1);
  assert.equal(store.list("10001",30,now+7*86_400_000+1).length,0);
});
