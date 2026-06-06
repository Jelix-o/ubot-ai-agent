import assert from "node:assert/strict";
import test from "node:test";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";

import { NapCatReverseServer } from "./napcat-reverse-server.js";

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

test("reverse server accepts token and emits group events", async () => {
  const server = new NapCatReverseServer({
    host: "127.0.0.1",
    port: 0,
    path: "/onebot/ws",
    accessToken: "token-1",
  });

  server.start();
  await wait(60);

  const address = (server as any).httpServer.address() as AddressInfo;
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/onebot/ws`, {
    headers: { Authorization: "Bearer token-1" },
  });

  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", (err) => reject(err));
  });

  const eventPromise = new Promise<number>((resolve) => {
    server.once("groupMessage", (event) => resolve(event.group_id));
  });

  ws.send(
    JSON.stringify({
      post_type: "message",
      message_type: "group",
      self_id: 12345,
      group_id: 866209871,
      user_id: 1569671790,
      message_id: 1,
      raw_message: "@bot hi",
      message: [{ type: "text", data: { text: "hello" } }],
    }),
  );

  assert.equal(await eventPromise, 866209871);

  ws.close();
  server.close();
});

test("reverse server rejects wrong token", async () => {
  const server = new NapCatReverseServer({
    host: "127.0.0.1",
    port: 0,
    path: "/onebot/ws",
    accessToken: "token-1",
  });

  server.start();
  await wait(60);

  const address = (server as any).httpServer.address() as AddressInfo;
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/onebot/ws?access_token=wrong`);

  const error = await new Promise<Error>((resolve) => {
    ws.once("error", (err) => resolve(err));
  });

  assert.match(error.message, /401|Unexpected server response/i);

  server.close();
});

test("reverse server rejects query string token", async () => {
  const server = new NapCatReverseServer({
    host: "127.0.0.1",
    port: 0,
    path: "/onebot/ws",
    accessToken: "token-1",
  });

  server.start();
  await wait(60);

  const address = (server as any).httpServer.address() as AddressInfo;
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/onebot/ws?access_token=token-1`);

  const error = await new Promise<Error>((resolve) => {
    ws.once("error", (err) => resolve(err));
  });

  assert.match(error.message, /401|Unexpected server response/i);

  server.close();
});

test("reverse server rejects pending actions when socket closes", async () => {
  const server = new NapCatReverseServer({
    host: "127.0.0.1",
    port: 0,
    path: "/onebot/ws",
    accessToken: "token-1",
  });

  server.start();
  await wait(60);

  const address = (server as any).httpServer.address() as AddressInfo;
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/onebot/ws`, {
    headers: { Authorization: "Bearer token-1" },
  });

  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", (err) => reject(err));
  });

  const pending = server.sendGroupAiRecord("866209871", "你好");
  ws.close();

  await assert.rejects(pending, /closed|stopped/i);

  server.close();
});
