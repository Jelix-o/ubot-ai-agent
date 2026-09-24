import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SharedDb } from "../shared/sqlite.js";
import { V3StateRepository } from "./v3-state-repository.js";
import {
  KnowledgeSourceBindingStore, knowledgeCommandConflict, normalizeKnowledgeSourceCommand,
} from "./knowledge-source-binding-store.js";

test("knowledge bindings migrate independently of FAQ content and are visible after reopening", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ubot-binding-"));
  let db = new SharedDb(path.join(dir, "shared.db"));
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const repository = new V3StateRepository(db);
  const entry = {
    id: "old-faq", groupId: "10001", title: "报销", question: "怎么报销", answer: "提交发票",
    keywords: ["报销"], enabled: true, createdAt: "2026-09-20T00:00:00Z", updatedAt: "2026-09-20T00:00:00Z",
  };
  repository.saveKnowledge(entry);
  // Simulate an existing v15 install while retaining all FAQ data.
  db.db.exec("DROP TABLE v3_knowledge_source_bindings; DELETE FROM schema_migrations WHERE version = 16");
  db.close();
  db = new SharedDb(path.join(dir, "shared.db"));
  let store = new KnowledgeSourceBindingStore(new V3StateRepository(db));
  assert.equal(store.get("private_enterprise_ranking"), "#民营企业排名");
  assert.equal(store.get("group_faq", "10001"), "#群知识库");
  store.save({ source: "group_faq", groupId: "10001", command: "#财务", updatedBy: "admin" });
  store.save({ source: "private_enterprise_ranking", groupId: "", command: "#企业榜", updatedBy: "root" });
  db.close();
  db = new SharedDb(path.join(dir, "shared.db"));
  const reloaded = new V3StateRepository(db);
  store = new KnowledgeSourceBindingStore(reloaded);
  assert.equal(store.get("group_faq", "10001"), "#财务");
  assert.equal(store.get("group_faq", "10002"), "#群知识库");
  assert.equal(store.get("private_enterprise_ranking"), "#企业榜");
  assert.equal(reloaded.getKnowledge(entry.id)?.answer, entry.answer);
  assert.equal(reloaded.listKnowledge("10001").length, 1);
  assert.equal(db.listSchemaMigrations().filter((item) => item.version === 16).length, 1);
});

test("knowledge command validation rejects invalid prefixes and shared namespace conflicts", () => {
  for (const input of ["", "#", "榜单", "＃榜单", "#空 格", "#a\nb", "#x!", "#" + "长".repeat(32)]) {
    assert.equal(normalizeKnowledgeSourceCommand(input), undefined, input);
  }
  assert.equal(normalizeKnowledgeSourceCommand(" #企业_2026 "), "#企业_2026");
  const bindings = [{ source: "group_faq" as const, groupId: "10001", command: "#报销", updatedAt: "" }];
  const scope = { source: "group_faq" as const, groupId: "10001" };
  for (const command of ["#知识库", "#知识", "#健康自检", "#民营企业排名", "#民营企业"]) {
    assert.ok(knowledgeCommandConflict(command, scope, bindings, [], "#民营企业排名"), command);
  }
  assert.equal(knowledgeCommandConflict("#报销", scope, bindings, [], "#民营企业排名"), undefined, "saving an unchanged binding is valid");
  assert.equal(knowledgeCommandConflict("#报销2", scope, bindings, [], "#民营企业排名"), undefined, "old binding is replaced");
  assert.ok(knowledgeCommandConflict("#报销", { source: "private_enterprise_ranking", groupId: "" }, bindings, [], "#民营企业排名"));
  assert.ok(knowledgeCommandConflict("#群知识库", { source: "private_enterprise_ranking", groupId: "" }, bindings, [], "#民营企业排名"));
});
