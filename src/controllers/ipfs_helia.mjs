import {createHelia} from 'helia'
import {FsBlockstore} from "blockstore-fs";
import {homedir} from "node:os";
import {join} from 'node:path';
import {unixfs} from "@helia/unixfs";

const blockstore = new FsBlockstore(join(homedir(), 'smartstock-storage'));

const helia = await createHelia({blockstore})
export const unixFS = unixfs(helia);
