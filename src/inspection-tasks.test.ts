import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { InspectionPages, readBytePage } from "./inspection-pages.js";
import { DurableTasks } from "./durable-tasks.js";

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
test("paged search filters types and retrieves every result and large UTF-8 file byte", async t => {
  const dir = await mkdtemp(join(tmpdir(), "devspace-page-"));
  t.after(() => rm(dir, {recursive:true,force:true}));
  const root = join(dir,"project"); await mkdir(root);
  const body = Array.from({length:620}, (_,i) => "needle 中文 " + i).join("\n");
  await writeFile(join(root,"wanted.ts"),body);
  await writeFile(join(root,"excluded.md"),"needle should not appear");
  const pages = new InspectionPages(join(dir,"pages"));
  let cursor: string | undefined = await pages.start("ws",root,{operation:"grep",pattern:"needle",include:"*.ts"},root);
  const rows: any[] = [];
  for(let poll=0; cursor && poll<500; poll++){
    const result = await pages.page("ws",root,cursor,37) as any;
    assert.equal(result.scanError,undefined);
    rows.push(...result.rows); cursor=result.nextCursor;
    if(cursor && !result.rows.length) await pause(20);
    if(!cursor) assert.equal(result.complete,true);
  }
  assert.equal(cursor,undefined);
  assert.equal(rows.length,620);
  assert.equal(new Set(rows.map(r=>r.line)).size,620);
  assert.ok(rows.every(r=>r.path.endsWith("wanted.ts")));
  const huge = Buffer.from("文".repeat(70000));
  await writeFile(join(root,"huge.json"),huge);
  const pieces: Buffer[]=[]; let offset=0; let version:string|undefined;
  while(true){
    const page = await readBytePage(join(root,"huge.json"),offset,8191,version);
    version=page.version; offset=page.nextOffset; pieces.push(Buffer.from(page.data,"base64"));
    if(!page.hasMore) break;
  }
  assert.deepEqual(Buffer.concat(pieces),huge);
  await writeFile(join(root,"huge.json"),"changed");
  await assert.rejects(readBytePage(join(root,"huge.json"),0,10,version),/FILE_CHANGED/);
  const listing = await pages.start("ws",root,{operation:"ls"},root);
  await assert.rejects(pages.page("other",root,listing),/another workspace/);
  for(let i=0;i<100;i++){if((await pages.page("ws",root,listing) as any).scanStatus==="complete")break;await pause(10);}
});
test("durable task reconnects, preserves large logs, locks writes, accepts input and cancels", async t => {
  const dir = await mkdtemp(join(tmpdir(),"devspace-task-"));
  const root=join(dir,"project"); await mkdir(root);
  const taskDir=join(dir,"tasks");
  const tasks=new DurableTasks(taskDir);
  let id:string|undefined;
  t.after(async()=>{
    if(id) await tasks.act("ws",root,id,"cancel").catch(()=>{});
    await pause(250); await rm(dir,{recursive:true,force:true});
  });
  const command = JSON.stringify(process.execPath)+" -e "+ "'process.stdout.write(\"文\".repeat(40000)); process.stdin.once(\"data\",()=>{console.log(\"END\");process.exit(0)}); setInterval(()=>{},1000)'";
  const started=await tasks.start({workspaceId:"ws",root,cwd:root,command}) as any;
  id=started.taskId; assert.ok(id);
  const recovered=new DurableTasks(taskDir);
  await assert.rejects(recovered.assertUnlocked(root),/MUTATION_IN_PROGRESS/);
  await assert.rejects(recovered.status("other",root,id!),/another workspace/);
  for(let i=0;i<100;i++){
    const state=await recovered.status("ws",root,id!) as any;
    if(state.status==="running") break;
    assert.notEqual(state.status,"unknown"); await pause(50);
  }
  await recovered.act("ws",root,id!,"input","done\n");
  for(let i=0;i<100;i++){
    const state=await recovered.status("ws",root,id!) as any;
    if(state.status==="completed") break;
    await pause(50);
  }
  const final=await recovered.status("ws",root,id!) as any;
  assert.equal(final.status,"completed");
  assert.equal("token" in final,false);
  await recovered.assertUnlocked(root);
  const chunks:Buffer[]=[]; let offset=0;
  while(true){
    const page=await recovered.logs("ws",root,id!,offset,8191) as any;
    chunks.push(Buffer.from(page.data,"base64")); offset=page.nextOffset;
    if(!page.hasMore) break;
  }
  assert.equal(Buffer.concat(chunks).toString(),"文".repeat(40000)+"END\n");
  const timeout=await recovered.start({workspaceId:"ws",root,cwd:root,command:"sleep 20",timeoutSeconds:0.1}) as any;
  id=timeout.taskId;
  for(let i=0;i<100;i++){const state=await recovered.status("ws",root,id!) as any;if(state.status==="timed_out")break;await pause(50);}
  assert.equal((await recovered.status("ws",root,id!) as any).status,"timed_out");
  await recovered.assertUnlocked(root);
});
