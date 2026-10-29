import {mkdtemp,mkdir,readFile,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import assert from "node:assert/strict";
import {DurableTasks} from "../src/durable-tasks.js";
const checkpoint=join(tmpdir(),"devspace-long-task-20261029.json");
if(process.argv[2]==="start"){
 const directory=await mkdtemp(join(tmpdir(),"devspace-long-acceptance-"));
 const root=join(directory,"project");await mkdir(root);
 const tasks=new DurableTasks(join(directory,"tasks"));
 const task=await tasks.start({workspaceId:"acceptance",root,cwd:root,command:"sleep 310; printf 'survived-five-minutes\\n'"}) as any;
 await writeFile(checkpoint,JSON.stringify({directory,root,taskId:task.taskId,started:Date.now()}),{mode:0o600});
 console.log(JSON.stringify({taskId:task.taskId,status:task.status,checkpoint}));
}else{
 const saved=JSON.parse(await readFile(checkpoint,"utf8"));
 const tasks=new DurableTasks(join(saved.directory,"tasks"));
 const state=await tasks.status("acceptance",saved.root,saved.taskId) as any;
 console.log(JSON.stringify({status:state.status,elapsedSeconds:(Date.now()-saved.started)/1000}));
 if(state.status==="completed"){
  const log=await tasks.logs("acceptance",saved.root,saved.taskId) as any;
  assert.equal(log.textPreview,"survived-five-minutes\n");
  assert.ok(Date.now()-saved.started>300000);
  await tasks.assertUnlocked(saved.root);
  console.log("PASS: independent worker survived parent exit and exceeded five minutes; exact full log recovered.");
  await rm(saved.directory,{recursive:true,force:true});await rm(checkpoint);
 }
}
