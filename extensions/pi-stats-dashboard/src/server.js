import { createServer } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
// ponytail: mtime 变化才重新 import，长驻 pi 进程改 aggregate.js 无需重启
const aggUrl = new URL("./aggregate.js", import.meta.url);
let aggMod = null, aggMtime = 0;
const loadAggregate = async () => {
  const m = statSync(aggUrl).mtimeMs;
  if (!aggMod || m !== aggMtime) { aggMod = await import(`${aggUrl.href}?v=${m}`); aggMtime = m; }
  return aggMod.aggregate;
};
// ponytail: 每次请求重读 HTML，长驻 pi 进程无需重启即可热更新面板
const htmlUrl = new URL("./dashboard.html", import.meta.url);
const readHtml = () => readFileSync(htmlUrl, "utf8");
export async function startServer({ port=3847 }={}) {
  const token=randomBytes(18).toString("hex"); let data; const refresh=async()=>{data=await(await loadAggregate())()}; await refresh();
  const server=createServer(async(req,res)=>{const url=new URL(req.url??"/","http://127.0.0.1"); const supplied=url.searchParams.get("token")??req.headers["x-pi-stats-token"]??""; const ok=supplied.length===token.length&&timingSafeEqual(Buffer.from(supplied),Buffer.from(token)); res.setHeader("Cache-Control","no-store");res.setHeader("X-Content-Type-Options","nosniff");res.setHeader("Content-Security-Policy","default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'"); if(req.method!=="GET")return end(res,405,"Method Not Allowed");if(req.headers.host!=="127.0.0.1"&&req.headers.host!==`127.0.0.1:${server.address()?.port}`)return end(res,403,"Forbidden");if(!ok)return end(res,401,"Unauthorized");if(url.pathname==="/"){res.setHeader("Content-Type","text/html; charset=utf-8");return res.end(readHtml().replaceAll("__TOKEN__",token).replace("__DATA__",JSON.stringify(data).replace(/</g,"\\u003c")))}if(url.pathname==="/api/stats"){await refresh();res.setHeader("Content-Type","application/json");return res.end(JSON.stringify(data))}end(res,404,"Not Found")});
  await listen(server, port); const actual=server.address().port; return {server,token,url:`http://127.0.0.1:${actual}/?token=${token}`,close:()=>new Promise(r=>server.close(r))};
}
async function listen(server, port) { try { await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(port,"127.0.0.1",resolve)}); } catch (error) { if (error.code !== "EADDRINUSE" || port === 0) throw error; await new Promise((resolve,reject)=>{server.removeAllListeners("error");server.once("error",reject);server.listen(0,"127.0.0.1",resolve)}); } }
function end(res,status,text){res.statusCode=status;res.setHeader("Content-Type","text/plain; charset=utf-8");res.end(text)}
