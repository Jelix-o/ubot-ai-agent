import assert from "node:assert/strict";
import test from "node:test";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { NapCatActionRejectedError } from "./napcat-action-errors.js";

import {
  NapCatActionNotSentError,
  NapCatActionOutcomeUnknownError,
  NapCatReverseServer,
} from "./napcat-reverse-server.js";

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

test("reverse forward API keeps literal links, returns ids and distinguishes rejection/unknown sends", async t => {
  const server = new NapCatReverseServer({ host: "127.0.0.1", port: 0, path: "/onebot/ws", actionTimeoutMs: 200 });
  server.start();
  const http = (server as any).httpServer;
  if (!http.listening) await new Promise<void>(resolve => http.once("listening", resolve));
  const ws = new WebSocket(`ws://127.0.0.1:${http.address().port}/onebot/ws`);
  t.after(() => { ws.terminate(); server.close(); });
  await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  let mode = "ok";
  const actions: any[] = [];
  ws.on("message", data => {
    const action = JSON.parse(data.toString()); actions.push(action);
    if (mode === "timeout") return;
    ws.send(JSON.stringify({ echo: action.echo, status: mode.startsWith("rejected") ? "failed" : "ok", retcode: mode.startsWith("rejected") ? 1404 : 0, message: mode === "rejected-timeout" ? "send timeout" : "",
      data: mode === "ok" ? { message_id: 9001, res_id: "forward-resource" } : {} }));
  });
  const text = "[CQ:at,qq=all]\nmagnet:?xt=urn:btih:123&dn=%E5%AE%8C%E6%95%B4&tr=udp%3A%2F%2Ftracker.test";
  const nodes = [{ senderId: "12345", senderName: "会仙", text }];
  assert.deepEqual(await server.sendGroupForwardMessage("67890", nodes), { messageId: "9001", platformMessageId: "9001" });
  assert.equal(actions[0].action, "send_group_forward_msg");
  assert.deepEqual(actions[0].params, { group_id: 67890, messages: [{ type: "node", data: { user_id: 12345, nickname: "会仙", content: [{ type: "text", data: { text } }] } }] });
  mode = "rejected";
  await assert.rejects(server.sendGroupForwardMessage("67890", nodes), NapCatActionRejectedError);
  mode = "rejected-timeout";
  await assert.rejects(server.sendGroupForwardMessage("67890", nodes), NapCatActionOutcomeUnknownError);
  mode = "missing-id";
  await assert.rejects(server.sendGroupForwardMessage("67890", nodes), NapCatActionOutcomeUnknownError);
  mode = "timeout";
  await assert.rejects(server.sendGroupForwardMessage("67890", nodes), NapCatActionOutcomeUnknownError);
  assert.equal(actions.length, 5);
});

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

test("reverse server returns the message id from send_group_msg", async () => {
  const server = new NapCatReverseServer({
    host: "127.0.0.1",
    port: 0,
    path: "/onebot/ws",
  });

  server.start();
  await wait(60);

  const address = (server as any).httpServer.address() as AddressInfo;
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/onebot/ws`);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", (error) => reject(error));
  });

  const actionPromise = new Promise<{ action?: string; echo?: string }>((resolve) => {
    ws.once("message", (data) => resolve(JSON.parse(data.toString())));
  });
  const receiptPromise = server.sendGroupMessage("866209871", "hello");
  const action = await actionPromise;
  assert.equal(action.action, "send_group_msg");
  ws.send(JSON.stringify({
    status: "ok",
    retcode: 0,
    data: { message_id: 8899 },
    echo: action.echo,
  }));

  assert.deepEqual(await receiptPromise, { messageId: "8899", platformMessageId: "8899" });
  ws.close();
  server.close();
});

test("reverse server sends group images as OneBot image segments", async () => {
  const server = new NapCatReverseServer({
    host: "127.0.0.1",
    port: 0,
    path: "/onebot/ws",
  });

  server.start();
  await wait(60);

  const address = (server as any).httpServer.address() as AddressInfo;
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/onebot/ws`);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", (error) => reject(error));
  });

  const actionPromise = new Promise<{ action?: string; echo?: string; params?: unknown }>((resolve) => {
    ws.once("message", (data) => resolve(JSON.parse(data.toString())));
  });
  const imageFile = "base64://blacklisted-at-meme";
  const receiptPromise = server.sendGroupImage("866209871", imageFile);
  const action = await actionPromise;
  assert.equal(action.action, "send_group_msg");
  assert.deepEqual(action.params, {
    group_id: 866209871,
    message: [{
      type: "image",
      data: { file: imageFile },
    }],
  });
  ws.send(JSON.stringify({
    status: "ok",
    retcode: 0,
    data: { message_id: 8900 },
    echo: action.echo,
  }));

  assert.deepEqual(await receiptPromise, { messageId: "8900", platformMessageId: "8900" });
  ws.close();
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

  const pending = server.sendGroupMessage("866209871", "你好");
  ws.close();

  await assert.rejects(
    pending,
    (error: unknown) => error instanceof NapCatActionOutcomeUnknownError && /closed|stopped/i.test(error.message),
  );

  server.close();
});

test("reverse server classifies a missing socket as definitely not sent", async () => {
  const server = new NapCatReverseServer({ host: "127.0.0.1", port: 0, path: "/onebot/ws" });
  await assert.rejects(
    server.sendGroupImage("866209871", "base64://image"),
    NapCatActionNotSentError,
  );
  server.close();
});

test("reverse server classifies an action timeout as an unknown delivery outcome", async () => {
  const server = new NapCatReverseServer({
    host: "127.0.0.1",
    port: 0,
    path: "/onebot/ws",
    actionTimeoutMs: 20,
  });
  server.start();
  await wait(60);
  const address = (server as any).httpServer.address() as AddressInfo;
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/onebot/ws`);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  const actionReceived = new Promise<void>((resolve) => ws.once("message", () => resolve()));
  const pending = server.sendGroupImage("866209871", "base64://image");
  await actionReceived;
  await assert.rejects(pending, NapCatActionOutcomeUnknownError);
  ws.close();
  server.close();
});
