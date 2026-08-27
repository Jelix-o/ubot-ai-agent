import assert from "node:assert/strict";
import test from "node:test";

import type { CharacterProfile } from "../types.js";
import {
  CharacterProfileService,
  type CharacterProfileRepository,
} from "./character-profile-service.js";

const huixian: CharacterProfile = {
  id: "huixian",
  name: "会仙",
  systemPrompt: "会仙是原创成年女性虚拟聊天伙伴。",
  styleRules: ["自然、诚实、有边界。"],
  knowledge: ["不伪造真人身份。"],
  temperature: 0.8,
  maxContextTurns: 24,
};

class InMemoryCharacterProfileRepository implements CharacterProfileRepository {
  profile?: CharacterProfile;
  readonly saves: Array<{ profile: CharacterProfile; changedBy?: string }> = [];

  async getHuixianProfile(): Promise<CharacterProfile | undefined> {
    return this.profile ? structuredClone(this.profile) : undefined;
  }

  async saveHuixianProfile(profile: CharacterProfile, changedBy?: string): Promise<CharacterProfile> {
    this.profile = structuredClone(profile);
    this.saves.push({ profile: structuredClone(profile), changedBy });
    return structuredClone(profile);
  }
}

test("CharacterProfileService initializes exactly one Huixian profile from migration data", async () => {
  const repository = new InMemoryCharacterProfileRepository();
  const service = new CharacterProfileService(repository, { bootstrapProfile: huixian });

  const initialized = await service.ensureHuixianProfile("v3-migration");
  initialized.name = "mutated outside the service";

  assert.equal((await service.getHuixianProfile())?.name, "会仙");
  assert.deepEqual((await service.getAllSkills()).map((profile) => profile.id), ["huixian"]);
  assert.equal(await service.getSkill("legacy"), undefined);
  assert.equal(repository.saves.length, 1);
  assert.equal(repository.saves[0]?.changedBy, "v3-migration");
  assert.equal(repository.saves[0]?.profile.id, "huixian");
});

test("CharacterProfileService preserves the persisted profile and records Huixian-only revisions", async () => {
  const repository = new InMemoryCharacterProfileRepository();
  const service = new CharacterProfileService(repository, { bootstrapProfile: huixian });

  await service.ensureHuixianProfile();
  const updated = await service.updateHuixianProfile({
    id: "retired-persona",
    name: "会仙·正式版",
    knowledge: ["只使用显式保存的长期记忆。"],
  }, "admin:42");

  assert.equal(updated.id, "huixian");
  assert.equal(updated.name, "会仙·正式版");
  assert.deepEqual(updated.knowledge, ["只使用显式保存的长期记忆。"]);
  assert.equal(repository.saves.length, 2);
  assert.equal(repository.saves[1]?.changedBy, "admin:42");
  assert.equal(repository.saves[1]?.profile.id, "huixian");
});

test("CharacterProfileService never overwrites an existing SQLite profile with packaged bootstrap data", async () => {
  const repository = new InMemoryCharacterProfileRepository();
  repository.profile = { ...huixian, name: "会仙·已保存版本" };
  const service = new CharacterProfileService(repository, {
    bootstrapProfile: { ...huixian, name: "会仙·打包默认版本" },
  });

  const profile = await service.ensureHuixianProfile();

  assert.equal(profile.name, "会仙·已保存版本");
  assert.equal(repository.saves.length, 0);
});

test("CharacterProfileService requires a controlled bootstrap when SQLite has no profile", async () => {
  const service = new CharacterProfileService(new InMemoryCharacterProfileRepository());

  await assert.rejects(service.ensureHuixianProfile(), /huixian_profile_not_initialized/);
});
