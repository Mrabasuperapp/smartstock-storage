import {after, before, describe, test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import http from "node:http";

const dir = await mkdtemp(join(tmpdir(), "zebra-range-"));
process.env.STORAGE_BLOCKSTORE_DIR = dir;
process.env.NODE_ENV = "test";

const {handleGetFile} = await import("../src/controllers/storage.mjs");
const {generateCidFromBuffer} = await import("../src/controllers/ipfs.mjs");
const {default: express} = await import("express").catch(() => ({default: null}));

// 3 MB so the file spans several unixfs chunks
const data = Buffer.alloc(3 * 1024 * 1024, 0).map((_, i) => (i * 31 + (i >> 8)) & 255);
let server, base, cid;

const run = (handlers, req, res) => {
    let i = 0;
    const next = err => {
        const h = handlers[i++];
        if (!h || err) return;
        Promise.resolve(h(req, res, next)).catch(e => { console.error('HANDLER ERROR', e); res.statusCode = 500; res.end(); });
    };
    next();
};

before(async () => {
    ({cid} = await generateCidFromBuffer({data}));
    const handlers = handleGetFile();
    server = http.createServer((req, res) => {
        // minimal express-like helpers used by the handlers
        res.status = code => (res.statusCode = code, res);
        res.set = h => (Object.entries(h).forEach(([k, v]) => res.setHeader(k, v)), res);
        res.json = o => res.end(JSON.stringify(o));
        const [, , c, f] = req.url.split("/");
        req.get = name => req.headers[`${name}`.toLowerCase()];
        req.params = {cid: c, filename: f};
        run(handlers, req, res);
    });
    await new Promise(r => server.listen(0, r));
    base = `http://localhost:${server.address().port}`;
});

after(async () => {
    server.close();
    await rm(dir, {recursive: true, force: true});
});

const get = (range) => fetch(`${base}/storage/${cid}/v.mp4`, {headers: range ? {Range: range} : {}});

describe("range requests", () => {
    test("full file advertises byte ranges", async () => {
        const r = await get();
        assert.equal(r.status, 200);
        assert.equal(r.headers.get("accept-ranges"), "bytes");
        assert.equal(r.headers.get("content-length"), `${data.length}`);
        assert.deepEqual(Buffer.from(await r.arrayBuffer()), data);
    });
    test("bytes=a-b", async () => {
        const r = await get("bytes=1000000-1000999");
        assert.equal(r.status, 206);
        assert.equal(r.headers.get("content-range"), `bytes 1000000-1000999/${data.length}`);
        assert.deepEqual(Buffer.from(await r.arrayBuffer()), data.subarray(1000000, 1001000));
    });
    test("open ended bytes=a-", async () => {
        const r = await get(`bytes=${data.length - 10}-`);
        assert.equal(r.status, 206);
        assert.deepEqual(Buffer.from(await r.arrayBuffer()), data.subarray(data.length - 10));
    });
    test("suffix bytes=-n", async () => {
        const r = await get("bytes=-500");
        assert.equal(r.status, 206);
        assert.deepEqual(Buffer.from(await r.arrayBuffer()), data.subarray(data.length - 500));
    });
    test("start beyond the end is 416", async () => {
        const r = await get(`bytes=${data.length}-`);
        assert.equal(r.status, 416);
        assert.equal(r.headers.get("content-range"), `bytes */${data.length}`);
    });
});
