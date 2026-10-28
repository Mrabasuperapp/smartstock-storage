import {FsBlockstore} from "blockstore-fs";
import {blockstoreDir} from "../utils/paths.mjs";
import {unixfs} from "@helia/unixfs";

const blockstore = new FsBlockstore(blockstoreDir);

let closed = false;
async function shutdown() {
    if (closed) {
        return;
    }
    closed = true;
    try {
        await blockstore.close();
    } catch (_) {
    }
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
process.once("beforeExit", () => void shutdown());

export const unixFS = unixfs({blockstore});
export {blockstore};
