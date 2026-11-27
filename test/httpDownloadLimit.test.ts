/** R8: HttpClient.downloadAudio — ранний отказ по content-length и обрыв тела сверх лимита. */
import { strict as assert } from "node:assert";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { HttpClient, ResponseTooLargeError } from "../src/infra/http.ts";

let server: Server;
let base = "";
const hits: Record<string, number> = {};
const sentBytes: Record<string, number> = {};

before(async () => {
  server = createServer((req, res) => {
    const path = req.url ?? "";
    hits[path] = (hits[path] ?? 0) + 1;
    sentBytes[path] = 0;
    const send = (chunk: Buffer) => {
      sentBytes[path]! += chunk.length;
      return res.write(chunk);
    };
    if (path === "/declared-big") {
      // заявлено 10 МБ; шлём медленно — клиент должен оборвать до чтения тела
      res.writeHead(200, { "content-length": String(10 * 1024 * 1024) });
      send(Buffer.alloc(1024));
      const t = setInterval(() => {
        if (res.destroyed || !send(Buffer.alloc(64 * 1024))) clearInterval(t);
      }, 20);
      res.on("close", () => clearInterval(t));
      return;
    }
    if (path === "/chunked-big") {
      res.writeHead(200); // без content-length → chunked
      let n = 0;
      const t = setInterval(() => {
        if (res.destroyed || n++ > 200) {
          clearInterval(t);
          res.end();
          return;
        }
        send(Buffer.alloc(16 * 1024));
      }, 5);
      res.on("close", () => clearInterval(t));
      return;
    }
    res.writeHead(200, { "content-length": "3" });
    res.end(Buffer.from([1, 2, 3]));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

test("R8: content-length > maxBytes → ResponseTooLargeError сразу, без ретраев и без чтения тела", async () => {
  const http = new HttpClient();
  const t0 = Date.now();
  await assert.rejects(http.downloadAudio(`${base}/declared-big`, 3, undefined, 1024 * 1024), ResponseTooLargeError);
  assert.equal(hits["/declared-big"], 1, "ретраев нет");
  assert.ok(Date.now() - t0 < 2000, "без бэкоффа ретраев");
  assert.ok((sentBytes["/declared-big"] ?? 0) < 1024 * 1024, "тело не дочитывалось");
});

test("R8: без content-length тело обрывается, как только перевалит лимит", async () => {
  const http = new HttpClient();
  await assert.rejects(http.downloadAudio(`${base}/chunked-big`, 1, undefined, 100 * 1024), ResponseTooLargeError);
  await new Promise((r) => setTimeout(r, 100));
  assert.ok((sentBytes["/chunked-big"] ?? 0) < 1024 * 1024, `сервер успел отдать ${sentBytes["/chunked-big"]} байт`);
});

test("R8: тело в пределах лимита (и без лимита) скачивается как раньше", async () => {
  const http = new HttpClient();
  assert.deepEqual([...(await http.downloadAudio(`${base}/ok`, 1, undefined, 3))], [1, 2, 3]);
  assert.deepEqual([...(await http.downloadAudio(`${base}/ok`, 1))], [1, 2, 3]);
});
