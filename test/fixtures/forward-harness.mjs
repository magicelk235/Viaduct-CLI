import { forward, exitLike } from "../../src/forward.js";

exitLike(await forward(process.argv[2], process.argv.slice(3)));
