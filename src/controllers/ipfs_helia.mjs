import {createHelia} from 'helia'
import {FsBlockstore} from "blockstore-fs";
import {homedir} from "node:os";
import {join} from 'node:path';
import {unixfs} from "@helia/unixfs";

const blockstore = new FsBlockstore(join(homedir(), 'zebra-store'));

const helia = await createHelia({blockstore});

let closed = false;
async function shutdown() {
    if (closed) {
        return;
    }
    closed = true;
    try {
        await helia.stop();
    } catch (_) {
    }
    try {
        await blockstore.close();
    } catch (_) {
    }
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
process.once("beforeExit", () => void shutdown());

export const unixFS = unixfs(helia);
export {blockstore, helia};
