import { createServer } from "node:http";
import { createRequire } from "node:module";

// proves pnpm install ran: fails at startup when dependencies are missing
const isNumber = createRequire(import.meta.url)("is-number");
if (!isNumber(5173)) throw new Error("is-number broken");

const body = `${process.env.APP_GREETING ?? "hello"} from ${process.env.WTC_NAME ?? "?"}\n`;
createServer((req, res) => {
  if (req.url === "/health") return res.end("ok\n");
  res.end(body);
}).listen(5173, "127.0.0.1");
