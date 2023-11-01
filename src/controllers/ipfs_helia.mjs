import {createHelia} from 'helia'
import {FsBlockstore} from "blockstore-fs";
import {homedir} from "node:os";
import {join} from 'node:path';
import {unixfs} from "@helia/unixfs";

const blockstore = new FsBlockstore(join(homedir(), 'zebra-store'));

const helia = await createHelia({blockstore});

//<<<<<<< HEAD
//=======
// helia.start().then(console.log).catch(console.log);

//>>>>>>> c163b4e (ignore helia start)
export const unixFS = unixfs(helia);
