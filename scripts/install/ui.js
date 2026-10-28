const csrf=document.querySelector('meta[name="flightdeck-csrf"]').content;
const $=id=>document.getElementById(id);
let currentStep=1,installationStarted=false,poll=null;
let lastPlan=null;
async function call(path,method="GET",payload){
  const response=await fetch(path,{
    method,credentials:"same-origin",cache:"no-store",
    headers:{
      "X-Flightdeck-CSRF":csrf,
      ...(method==="GET"?{}:{"Content-Type":"application/json"})
    },
    ...(method==="GET"?{}:{body:JSON.stringify(payload??{})})
  });
  let data;
  try{data=await response.json();}
  catch{throw new Error("The local installer returned an invalid response");}
  if(!response.ok)throw new Error(data?.message??data?.error??"Installation request failed");
  return data;
}
function alertBox(message,type="error"){
  const alert=$("alert");
  if(!message){alert.hidden=true;alert.textContent="";return;}
  alert.hidden=false;
  alert.className=type;
  alert.textContent=message;
}
function showStep(step){
  currentStep=step;
  document.querySelectorAll(".wizard-page").forEach(page=>
    page.classList.toggle("active",page.id==="page-"+step));
  document.querySelectorAll(".step").forEach(el=>{
    const i=Number(el.dataset.step);
    el.classList.toggle("active",i===step);
    el.classList.toggle("completed",i<step);
  });
  $("back").hidden=step===1||installationStarted;
  $("next").hidden=step===4;
  $("next").textContent=step===3?"Install to Cloudflare":"Continue";
  $("footnote").textContent="Step "+step+" of 4";
  if(step===4) $("status-chip").textContent="Installing";
}
function planInput(){
  return {
    accountId:$("account").value,
    slug:$("slug").value.trim(),
    adminEmails:$("admins").value.trim(),
    mode:document.querySelector('input[name="mode"]:checked')?.value??"intelligence",
    enableMcp:$("mcp").checked,
    enableAI:$("ai").checked,
    queryUnits:Number($("query-units").value)
  };
}
function textNode(tag,text,className){
  const e=document.createElement(tag);
  if(className)e.className=className;
  e.textContent=String(text);
  return e;
}
function renderPlan(plan){
  lastPlan=plan;
  const summary=$("plan-summary");
  summary.replaceChildren();
  const values=[
    ["Cloudflare account",plan.accountId],
    ["Deployment suffix",plan.slug],
    ["Deployment mode",plan.mode],
    ["Access administrators",plan.adminEmails.join(", ")],
    ["Private Analytics Core",plan.resources.core],
    ["Admin Console",plan.resources.console],
    ["MCP Worker",plan.resources.mcp],
    ["D1 database",plan.resources.metadataD1],
    ["Basin / R2 event bucket",plan.resources.r2CatalogBucket],
    ["Live event Queue",plan.mode==="intelligence"?plan.resources.queue:"Not installed"]
  ];
  for(const [name,value] of values){
    const item=textNode("div","","review-item");
    item.append(textNode("small",name),textNode("b",value));
    summary.append(item);
  }
  const list=$("plan-steps");list.replaceChildren();
  for(const step of plan.steps)list.append(textNode("li",step));
}
async function refreshAccounts(){
  const account=$("account");
  const old=account.value;
  account.replaceChildren(new Option("Loading accounts…",""));
  try{
    const payload=await call("/api/accounts");
    account.replaceChildren();
    for(const item of payload.accounts){
      const option=new Option(item.name+" ("+item.id+")",item.id);
      account.append(option);
    }
    if(!payload.accounts.length)throw new Error("No Cloudflare accounts are accessible");
    if(payload.accounts.some(a=>a.id===old))account.value=old;
    else account.value=payload.accounts[0].id;
  }catch(error){
    account.replaceChildren(new Option("Sign into Cloudflare / configure API token",""));
    alertBox(error.message+" — Run cf auth login or configure CLOUDFLARE_API_TOKEN.");
  }
}
async function updatePrerequisites(){
  try{
    const p=await call("/api/prerequisites");
    const fill=(prefix,enabled)=>{
      $(prefix+"-token-dot").classList.toggle("unavailable",!enabled);
      $(prefix+"-token-status").textContent=enabled?"Ready":"Needs configuration";
    };
    fill("api",p.cloudflareApiTokenConfigured);
    fill("catalog",p.catalogTokenConfigured);
  }catch(error){alertBox(error.message);}
}
async function startInstall(){
  const confirmation=$("confirmation").value.trim();
  if(confirmation!=="INSTALL")throw new Error("Type INSTALL exactly to confirm this account deployment");
  const request={...planInput(),confirmation};
  await call("/api/install","POST",request);
  installationStarted=true;
  showStep(4);
  poll=window.setInterval(()=>void updateProgress(),1200);
  await updateProgress();
}
async function updateProgress(){
  try{
    const state=await call("/api/status");
    const log=$("install-log");
    const before=log.scrollTop;
    const stick=log.scrollHeight-log.clientHeight-log.scrollTop<90;
    log.textContent=state.logs.length?state.logs.join("\n"):"Preparing installation…";
    if(stick)log.scrollTop=log.scrollHeight;
    $("progress-count").textContent=state.logs.length+" log entries";
    if(state.running){
      $("progress-state").textContent="Applying Cloudflare resources";
      $("progress-fill").classList.add("indeterminate");
    }
    if(state.done){
      window.clearInterval(poll);poll=null;
      $("progress-fill").classList.remove("indeterminate");
      $("progress-fill").style.width=state.success?"100%":"45%";
      $("deploy-title").textContent=state.success?"Installation command completed":"Installation stopped";
      $("progress-state").textContent=state.success?"Completed":"Review error";
      $("status-chip").textContent=state.success?"Command finished":"Failed";
      $("done-links").hidden=!state.success;
      if(!state.success)alertBox(state.error??"Review the installer log; rerun the wizard after fixing the problem.");
    }
  }catch(error){alertBox(error.message);}
}
async function advance(){
  if(installationStarted)return;
  alertBox("");
  $("next").disabled=true;
  try{
    if(currentStep===1){
      const input=planInput();
      if(!input.accountId||!input.adminEmails||!input.slug)
        throw new Error("Select an account, installation name and admin email");
      showStep(2);
    }else if(currentStep===2){
      const data=await call("/api/plan","POST",planInput());
      renderPlan(data.plan);
      await updatePrerequisites();
      showStep(3);
    }else if(currentStep===3){
      await startInstall();
    }
  }catch(error){alertBox(error.message);}
  finally{$("next").disabled=false;}
}
$("next").addEventListener("click",()=>void advance());
$("back").addEventListener("click",()=>{
  if(!installationStarted&&currentStep>1){alertBox("");showStep(currentStep-1);}
});
$("reload-accounts").addEventListener("click",()=>void refreshAccounts());
$("copy-log").addEventListener("click",()=>void navigator.clipboard.writeText($("install-log").textContent));
document.querySelectorAll('input[name="mode"]').forEach(el=>el.addEventListener("change",()=>{
  document.querySelectorAll(".option").forEach(label=>
    label.classList.toggle("selected",label.querySelector("input")?.checked));
}));
showStep(1);
void refreshAccounts();
void updatePrerequisites();
