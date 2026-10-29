import { constants } from "node:fs";
import { open, realpath, mkdir, link, unlink, lstat } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import * as z from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WorkspaceRegistry } from "./workspaces.js";
import { isPathInsideRoot } from "./roots.js";

async function parentInside(root:string,path:string) {
  const [base,parent]=await Promise.all([realpath(root),realpath(dirname(path))]);
  if(!isPathInsideRoot(parent,base))throw new Error("Destination parent resolves outside the workspace.");
  return join(parent,basename(path));
}
export async function copyWorkspaceFile(root:string,source:string,destination:string,move=false) {
  const physicalRoot=await realpath(root);
  const sourcePath=await parentInside(root,source);
  const target=await parentInside(root,destination);
  if(sourcePath===target)throw new Error("Source and destination are the same file.");
  const input=await open(sourcePath,constants.O_RDONLY|constants.O_NOFOLLOW);
  let partial:string|undefined;let published=false;
  try {
    const before=await input.stat({bigint:true});
    if(!before.isFile())throw new Error("This operation requires a regular file. Create directories with make_directory.");
    const sourceParent=await realpath(dirname(sourcePath));
    if(!isPathInsideRoot(sourceParent,physicalRoot))throw new Error("Source resolves outside the workspace.");
    partial=join(dirname(target),".devspace-copy-"+randomUUID()+".partial");
    const output=await open(partial,"wx",Number(before.mode & 0o777n));
    try {
      const buffer=Buffer.alloc(1024*1024);let position=0;
      while(true){
        const {bytesRead}=await input.read(buffer,0,buffer.length,position);
        if(!bytesRead)break;
        let written=0;
        while(written<bytesRead)written+=(await output.write(buffer,written,bytesRead-written,position+written)).bytesWritten;
        position+=bytesRead;
      }
      const after=await input.stat({bigint:true});
      if(before.size!==after.size||before.mtimeNs!==after.mtimeNs||before.ctimeNs!==after.ctimeNs)throw new Error("FILE_CHANGED: source changed while copying.");
      await output.sync();
      if(await parentInside(root,destination)!==target)throw new Error("Destination parent changed.");
      // Hard-link publication cannot overwrite a concurrently created destination.
      await link(partial,target);published=true;
      if(move){
        const current=await lstat(sourcePath,{bigint:true});
        if(current.dev!==before.dev||current.ino!==before.ino||current.mtimeNs!==before.mtimeNs||current.ctimeNs!==before.ctimeNs)
          throw new Error("FILE_CHANGED: destination copy is preserved; source changed and was not removed.");
        await unlink(sourcePath);
      }
      return {source:relative(physicalRoot,sourcePath),path:relative(physicalRoot,target),operation:move?"move":"copy",size:Number(before.size)};
    }finally{await output.close();}
  }catch(error){
    if(published)throw new Error("Destination was created and preserved. "+(error instanceof Error?error.message:String(error)));
    throw error;
  }finally{
    await input.close();
    if(partial)await unlink(partial).catch(()=>{});
  }
}
export function registerFileOperationTools(server:McpServer,workspaces:WorkspaceRegistry) {
  for(const operation of ["copy","move"] as const)server.registerTool(operation+"_file",{
    description:operation==="copy"?"Copy a text or binary file inside the selected workspace. Read the source first. Destination must be absent; existing data is never overwritten.":"Move a text or binary file inside the selected workspace. Read the source first. Uses verified copy and removes the unchanged source only after successful publication.",
    inputSchema:{workspaceId:z.string(),source:z.string().min(1),destination:z.string().min(1)},
    annotations:{readOnlyHint:false,destructiveHint:operation==="move",openWorldHint:false},
  },async({workspaceId,source,destination})=>{
    const ws=workspaces.getWorkspace(workspaceId);
    const result=await workspaces.runMutation(ws,operation+"_file",()=>copyWorkspaceFile(ws.root,workspaces.resolvePath(ws,source),workspaces.resolvePath(ws,destination),operation==="move"),[source,destination]);
    return {content:[{type:"text" as const,text:JSON.stringify(result)}]};
  });
  server.registerTool("make_directory",{
    description:"Create one directory in an existing workspace parent. No recursive overwrite and no symlink escape.",
    inputSchema:{workspaceId:z.string(),path:z.string().min(1)},
    annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false},
  },async({workspaceId,path})=>{
    const ws=workspaces.getWorkspace(workspaceId);
    await workspaces.runMutation(ws,"make_directory",async()=>{await mkdir(await parentInside(ws.root,workspaces.resolvePath(ws,path)));},[path]);
    return {content:[{type:"text" as const,text:JSON.stringify({path})}]};
  });
}
