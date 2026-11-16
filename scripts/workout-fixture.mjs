import fs from "node:fs/promises";
import ts from "typescript";
import { createServer } from "node:http";
import { resolve, extname } from "node:path";
import assert from "node:assert/strict";
// Patch only the test copy: all real application handlers and Strava requests remain intact.
export async function serveWorkoutFixture() {
  const root = await fs.mkdtemp("artifacts/workout-fixture-");
  await fs.cp("artifacts/visual-release", root, { recursive: true });
  const html = await fs.readFile(root + "/index.html", "utf8"),
    path = html.match(/src="(\/assets\/[^\"]+\.js)"/)[1];
  let code = await fs.readFile(root + path, "utf8");
  const ast = ts.createSourceFile("app.js", code, 99, true, ts.ScriptKind.JS);
  const replacements = [];
  for (const name of ["Gv", "Gg"]) {
    const fn = ast.statements.find(
      (n) => ts.isFunctionDeclaration(n) && n.name?.text === name,
    );
    assert(fn, `Hardware hook ${name} exists`);
    replacements.push({
      start: fn.getStart(ast),
      end: fn.end,
      text: `function ${name}(){
    const [tick,setTick]=m.useState(0);
    m.useEffect(()=>{const id=setInterval(()=>setTick(v=>v+1),100);return()=>clearInterval(id)},[]);
    const f=window.__fixture;
    const send=async(key,value)=>{window.__commands.push([key,value]);if(f.delay===key)await new Promise(r=>setTimeout(r,300));if(f.fail===key)throw Error('Machine rejected target');if(key==='start')f.running=true;if(key==='pause'||key==='stop')f.running=false;};
    return {available:true,supported:true,connected:${name === "Gv" ? "f.connected && !f.ifit" : "f.connected && !!f.ifit"},controllable:true,connecting:false,deviceName:'Fixture equipment',error:'',metrics:{...f.metrics,running:f.running,distanceM:f.metrics.totalDistanceM},machineRunning:f.running,targetFeatures:f.features,supportedRanges:f.ranges,summary:null,controllableFields:{speed:true,incline:true,resistance:true},resistanceLevels:[1,2,3,4,5,6],getDevice:()=>null,setTargetSpeed:v=>send('speed',v),setTargetIncline:v=>send('incline',v),setTargetPower:v=>send('power',v),setTargetResistance:v=>send('resistance',v),startDevice:()=>send('start'),resumeDevice:()=>send('start'),pauseDevice:()=>send('pause'),emergencyStop:()=>send('stop'),resetToIdle:async()=>{},disconnect:async()=>{if(('${name}'==='Gg')===!!f.ifit){await send('disconnect');f.connected=false}},connect:async()=>{window.__commands.push(['connect']);}};
  }`,
    });
  }
  for (const r of replacements.sort((a, b) => b.start - a.start))
    code = code.slice(0, r.start) + r.text + code.slice(r.end);
  await fs.writeFile(root + path, code);
  const server = createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, "http://fixture").pathname;
      const file = resolve(
        root,
        "." + (pathname === "/" ? "/index.html" : pathname),
      );
      if (!file.startsWith(resolve(root) + "/")) throw Error("Invalid path");
      const body = await fs.readFile(file);
      res.writeHead(200, {
        "Content-Type":
          {
            ".html": "text/html",
            ".js": "text/javascript",
            ".css": "text/css",
            ".json": "application/json",
            ".svg": "image/svg+xml",
            ".jpg": "image/jpeg",
          }[extname(file)] || "application/octet-stream",
      });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end("Not found");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: "http://127.0.0.1:" + server.address().port,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}
