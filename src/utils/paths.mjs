import {cpSync, existsSync} from "node:fs";
import {homedir} from "node:os";
import {join} from "node:path";

/** The zebra store directory holds the blocks and, under `_meta`, every other piece of state. */
export const blockstoreDir = process.env.STORAGE_BLOCKSTORE_DIR || join(homedir(), "zebra-store");
export const metaDir = process.env.STORAGE_DATA_DIR || join(blockstoreDir, "_meta");

/** Largest single upload in MB, set with STORAGE_MAX_UPLOAD_MB (default 50). */
const configuredMax = Number(process.env.STORAGE_MAX_UPLOAD_MB);
export const maxUploadMb = Number.isFinite(configuredMax) && configuredMax > 0 ? configuredMax : 50;

// one-time move of the old ./.data directory into the zebra store
const legacyDir = join(process.cwd(), ".data");
if (!existsSync(metaDir) && existsSync(legacyDir)) {
    cpSync(legacyDir, metaDir, {recursive: true});
}
