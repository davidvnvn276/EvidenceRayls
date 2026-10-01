const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');
const assert = require('assert/strict');
const solc = require('solc');
const ganache = require('ganache');
const { ethers } = require('ethers');

const repo = path.resolve(process.env.RAYLS_CONTRACTS_DIR || '../rayls-sovereign-contracts');
const expectedCommit = 'bdf8f044b9a270e1f97c4c2ac6de9e32ec467de9';
assert.equal(cp.execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(), expectedCommit);
assert.equal(cp.execFileSync('git',['status','--porcelain'],{cwd:repo,encoding:'utf8'}).trim(), '');
const sourceFiles = {};
function findImports(file) {
  const roots = [repo, path.join(__dirname,'node_modules')];
  for (const root of roots) {
    const p = path.join(root,file);
    if (fs.existsSync(p)) {
      const contents = fs.readFileSync(p,'utf8');
      sourceFiles[file] = crypto.createHash('sha256').update(contents).digest('hex');
      return {contents};
    }
  }
  return {error:'Import not found: '+file};
}
const input = {language:'Solidity',sources:{'RedemptionLab.sol':{content:fs.readFileSync('RedemptionLab.sol','utf8')}},settings:{optimizer:{enabled:true,runs:50},evmVersion:'paris',outputSelection:{'*':{'*':['abi','evm.bytecode.object','evm.bytecode.linkReferences']}}}};
const out = JSON.parse(solc.compile(JSON.stringify(input),{import:findImports}));
const errs=(out.errors||[]).filter(e=>e.severity==='error');
if(errs.length) throw new Error(errs.map(e=>e.formattedMessage).join('\n'));
fs.writeFileSync('compilation-warnings.txt',(out.errors||[]).map(e=>e.formattedMessage).join('\n'));
const UNIT = 10n**18n;
const total = 100000n*UNIT;
const norm=n=>ethers.formatUnits(n,18);
const summary={createdAt:new Date().toISOString(),contractsCommit:expectedCommit,compiler:solc.version(),environment:'one local Ganache EVM; manual callback execution; official AccessManagerV1 via two initialized ERC1967 proxies; mock endpoint, registry and user governance; original handler methods unmodified',sourceSha256:sourceFiles,runs:[],boundaryCases:[]};

async function main(){
 const engine=ganache.provider({logging:{quiet:true},wallet:{deterministic:true,totalAccounts:5},chain:{chainId:31337,hardfork:'shanghai',allowUnlimitedContractSize:true}});
 const provider=new ethers.BrowserProvider(engine);
 provider.pollingInterval=50;
 const [exec,a,b,outsider,admin]=await Promise.all([0,1,2,3,4].map(n=>provider.getSigner(n)));
 const addresses=await Promise.all([exec,a,b,outsider,admin].map(s=>s.getAddress()));
 const linkedLibraries = new Map();
 async function linkedBytecode(x){
  let code=x.evm.bytecode.object;
  for(const [file,names] of Object.entries(x.evm.bytecode.linkReferences||{})){
   for(const [name,refs] of Object.entries(names)){
    const key=file+':'+name;
    if(!linkedLibraries.has(key))linkedLibraries.set(key,await (await deploy(file,name,[])).getAddress());
    const address=linkedLibraries.get(key).slice(2).toLowerCase();
    for(const ref of refs){assert.equal(ref.length,20);const start=ref.start*2;code=code.slice(0,start)+address+code.slice(start+40);}
   }
  }
  return code;
 }
 async function deploy(file,name,args){const x=out.contracts[file][name];const c=await new ethers.ContractFactory(x.abi,await linkedBytecode(x),exec).deploy(...args);await c.waitForDeployment();return c;}
 let managerImpl;
 async function manager(){
  const file='src/privateHub/AccessControl/RaylsAccessManagerV1.sol';
  if(!managerImpl)managerImpl=await deploy(file,'RaylsAccessManagerV1',[]);
  const abi=out.contracts[file].RaylsAccessManagerV1.abi;
  const init=new ethers.Interface(abi).encodeFunctionData('initialize',[addresses[4]]);
  const proxy=await deploy('@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol','ERC1967Proxy',[await managerImpl.getAddress(),init]);
  const c=new ethers.Contract(await proxy.getAddress(),abi,admin);
  await tx(c.registerRole('MESSAGE_EXECUTOR'));await tx(c.registerRole('RELAYER'));
  const role=await c.getRoleIdByName('MESSAGE_EXECUTOR');await tx(c.grantRole(role,addresses[0],0));
  assert.equal((await c.hasRole(0,addresses[0]))[0],false);
  return c;
 }
 async function tx(p){const t=await p;const r=await t.wait();assert.equal(r.status,1);return r.hash;}
 async function tokenEvents(contract,hash){
  const receipt=await provider.getTransactionReceipt(hash);const addr=(await contract.getAddress()).toLowerCase();
  return receipt.logs.filter(x=>x.address.toLowerCase()===addr).map(x=>{
   const parsed=contract.interface.parseLog(x);
   return {name:parsed.name,args:Array.from(parsed.args,a=>typeof a==='bigint'?a.toString():a)};
  });
 }
 async function fixture(){
  const auth=await manager();const publicAuth=await manager();
  const registry=await deploy('RedemptionLab.sol','LabRegistry',[]);
  const gov=await deploy('RedemptionLab.sol','LabGovernance',[]);
  const endpoint=await deploy('RedemptionLab.sol','LabEndpoint',[await auth.getAddress(),await registry.getAddress()]);
  const publicEndpoint=await deploy('RedemptionLab.sol','LabEndpoint',[await publicAuth.getAddress(),await registry.getAddress()]);
  const priv=await deploy('RedemptionLab.sol','LabPrivateToken',[await endpoint.getAddress(),await gov.getAddress(),addresses[1],total]);
  const pub=await deploy('src/rayls-node/rayls-public-chain/tokens/PublicChainERC20.sol','PublicChainERC20',['Lab public','LPUB',await publicEndpoint.getAddress(),0,await priv.getAddress()]);
  await tx(gov.approve(addresses[1]));
  await tx(gov.approve(addresses[2]));
  await tx(priv.connect(a).teleportToPublicChain(addresses[1],total,7331));
  assert.equal(await priv.getLockedAmount(addresses[1]),total);
  assert.equal(await priv.balanceOf(await priv.getAddress()),total);
  await tx(exec.sendTransaction({to:await pub.getAddress(),data:await endpoint.lastPayload()}));
  return {auth,publicAuth,registry,gov,privateEndpoint:endpoint,endpoint:publicEndpoint,priv,pub};
 }
 async function snapshot(f){return {
  lockedA:norm(await f.priv.getLockedAmount(addresses[1])),lockedB:norm(await f.priv.getLockedAmount(addresses[2])),
  privateContractBalance:norm(await f.priv.balanceOf(await f.priv.getAddress())),privateA:norm(await f.priv.balanceOf(addresses[1])),privateB:norm(await f.priv.balanceOf(addresses[2])),privateSupply:norm(await f.priv.totalSupply()),
  publicA:norm(await f.pub.balanceOf(addresses[1])),publicB:norm(await f.pub.balanceOf(addresses[2])),publicSupply:norm(await f.pub.totalSupply())};}
 async function expectError(contract,method,args,name,errorArgs){
  let observed;
  try {await contract[method].staticCall(...args);throw new Error('Unexpected success');}
  catch(e){const data=e.data||e.info?.error?.data?.result||e.info?.error?.data;observed=contract.interface.parseError(data);}
  assert.equal(observed.name,name);
  if(errorArgs) for(let i=0;i<errorArgs.length;i++)assert.equal(observed.args[i],errorArgs[i]);
  // Also submit the failing transaction; static simulation alone is not the recorded execution.
  const t=await contract[method](...args,{gasLimit:1500000});
  let receipt;
  try {receipt=await t.wait();} catch(e){receipt=e.receipt;}
  assert.equal(receipt.status,0);
  return {error:observed.name,args:Array.from(observed.args,x=>typeof x==='bigint'?x.toString():x),hash:t.hash,receiptStatus:receipt.status};
 }
 for(const requested of [1n,40000n,100000n]){
  const amount=requested*UNIT;const f=await fixture();
  await tx(f.pub.connect(a).transfer(addresses[2],amount));
  const before=await snapshot(f);
  assert.equal(before.lockedB,'0.0');
  const burnHash=await tx(f.pub.connect(b).teleportToPrivacyNode(addresses[2],amount,1001));
  const afterBurn=await snapshot(f);
  assert.equal(afterBurn.publicSupply,norm(total-amount));
  const failed=await expectError(f.priv,'receiveTeleportFromPublicChain',[addresses[2],amount],'RaylsErc20Handler__InsufficientLockedAmount',[amount,0n]);
  const afterFailure=await snapshot(f);assert.deepEqual(afterFailure,afterBurn);
  // Manually execute the exact revert payload recorded by the mock endpoint.
  const compensation=await tx(exec.sendTransaction({to:await f.pub.getAddress(),data:await f.endpoint.lastRevert()}));
  const afterCompensation=await snapshot(f);assert.deepEqual(afterCompensation,before);
  // Holder B can choose a destination whose lock exists; this credits A, not B.
  const controlBurn=await tx(f.pub.connect(b).teleportToPrivacyNode(addresses[1],amount,1001));
  const forwardData=await f.endpoint.lastPayload();
  const returnHash=await tx(exec.sendTransaction({to:await f.priv.getAddress(),data:forwardData}));
  const afterSuccess=await snapshot(f);
  assert.equal(afterSuccess.privateA,norm(amount));assert.equal(afterSuccess.privateB,'0.0');
  assert.equal(afterSuccess.lockedA,norm(total-amount));assert.equal(afterSuccess.publicSupply,norm(total-amount));
  assert.equal(afterSuccess.privateContractBalance,norm(total-amount));
  const events={burn:await tokenEvents(f.pub,burnHash),compensation:await tokenEvents(f.pub,compensation),return:await tokenEvents(f.priv,returnHash)};
  assert.deepEqual(events.burn,[{name:'Transfer',args:[addresses[2],ethers.ZeroAddress,amount.toString()]}]);
  assert.deepEqual(events.compensation,[{name:'Transfer',args:[ethers.ZeroAddress,addresses[2],amount.toString()]}]);
  assert.deepEqual(events.return,[{name:'TokensUnlocked',args:[addresses[1],amount.toString()]},{name:'Transfer',args:[await f.priv.getAddress(),addresses[1],amount.toString()]}]);
  summary.runs.push({amount:norm(amount),before,afterBurn,failedDestination:failed,afterFailure,compensationHash:compensation,afterCompensation,controlDestination:'A (original locker)',controlBurnHash:controlBurn,returnHash,afterSuccess,burnHash,events});
  console.log('PASS repeated amount',requested.toString(),': B destination rejected; compensation restored exact state; A destination succeeded');
 }
 const f=await fixture();const before=await snapshot(f);
 async function boundary(label,contract,method,args,name,params){const result=await expectError(contract,method,args,name,params);assert.deepEqual(await snapshot(f),before);summary.boundaryCases.push({label,...result,stateUnchanged:true});console.log('PASS boundary',label);}
 await boundary('zero recipient rejected before burn',f.pub.connect(a),'teleportToPrivacyNode',[ethers.ZeroAddress,UNIT,1001],'RaylsPublicERC20Handler__DestinationIsZeroAddress');
 await boundary('zero amount rejected before burn',f.pub.connect(a),'teleportToPrivacyNode',[addresses[1],0,1001],'RaylsPublicERC20Handler__AmountMustBeGreaterThanZero');
 await boundary('destination amount exceeds recipient lock',f.priv,'receiveTeleportFromPublicChain',[addresses[1],total+UNIT],'RaylsErc20Handler__InsufficientLockedAmount',[total+UNIT,total]);
 await boundary('unapproved Sovereign sender',f.priv.connect(outsider),'teleportToPublicChain',[addresses[3],UNIT,7331],'RaylsApp__UserNotRegistered',[addresses[3]]);
 await boundary('unauthorized return callback under official AccessManager',f.priv.connect(outsider),'receiveTeleportFromPublicChain',[addresses[1],UNIT],'RaylsAccessManaged__Unauthorized',[addresses[3]]);
 await tx(f.registry.setActive(false));
 await boundary('inactive destination token',f.priv,'receiveTeleportFromPublicChain',[addresses[1],UNIT],'RaylsApp__PublicChainNotActive',[await f.priv.getAddress(),2n,0n]);
 await tx(f.registry.setActive(true));
 // Real role/pause gates: compensation itself can be blocked independently.
 const role=await f.auth.getRoleIdByName('MESSAGE_EXECUTOR');
 await tx(f.auth.revokeRole(role,addresses[0]));
 await boundary('revoked MESSAGE_EXECUTOR rejected',f.priv,'receiveTeleportFromPublicChain',[addresses[1],UNIT],'RaylsAccessManaged__Unauthorized',[addresses[0]]);
 await tx(f.auth.grantRole(role,addresses[0],60));
 await boundary('delayed MESSAGE_EXECUTOR must schedule',f.priv,'receiveTeleportFromPublicChain',[addresses[1],UNIT],'RaylsAccessManaged__MustSchedule',[addresses[0],60n]);
 await tx(f.auth.grantRole(role,addresses[0],0));
 await tx(f.auth.setContractPaused(await f.priv.getAddress(),true));
 await boundary('paused private token blocks callback',f.priv,'receiveTeleportFromPublicChain',[addresses[1],UNIT],'RaylsAccessManaged__ContractPaused');
 await tx(f.auth.setContractPaused(await f.priv.getAddress(),false));
 // Burn B's 40k; destination B has zero lock; block compensation on public token.
 const q=40000n*UNIT;await tx(f.pub.connect(a).transfer(addresses[2],q));
 const prior=await snapshot(f);const burn=await tx(f.pub.connect(b).teleportToPrivacyNode(addresses[2],q,1001));
 const forward=await f.endpoint.lastPayload(), rev=await f.endpoint.lastRevert();
 assert.equal(forward,f.priv.interface.encodeFunctionData('receiveTeleportFromPublicChain',[addresses[2],q]));
 assert.equal(rev,f.pub.interface.encodeFunctionData('revertTeleportToPrivacyNode',[addresses[2],q]));
 const destFail=await expectError(f.priv,'receiveTeleportFromPublicChain',[addresses[2],q],'RaylsErc20Handler__InsufficientLockedAmount',[q,0n]);
 const pending=await snapshot(f);await tx(f.publicAuth.setContractPaused(await f.pub.getAddress(),true));
 const compFail=await expectError(f.pub,'revertTeleportToPrivacyNode',[addresses[2],q],'RaylsAccessManaged__ContractPaused');
 assert.deepEqual(await snapshot(f),pending);assert.equal(pending.publicB,'0.0');
 await tx(f.publicAuth.setContractPaused(await f.pub.getAddress(),false));
 const recovered=await tx(exec.sendTransaction({to:await f.pub.getAddress(),data:rev}));
 const restored=await snapshot(f);assert.deepEqual(restored,prior);
 summary.blockedCompensation={amount:norm(q),burnHash:burn,destinationFailure:destFail,compensationFailure:compFail,before:prior,pending,restored,recoveryHash:recovered};
 summary.realAuthority={privateManager:await f.auth.getAddress(),publicManager:await f.publicAuth.getAddress(),implementation:await managerImpl.getAddress(),executor:addresses[0],admin:addresses[4],executorIsAdmin:false,linkedLibraries:Object.fromEntries(linkedLibraries)};
 console.log('PASS compensation independently blocked by official AccessManager pause; restored after unpause');
 summary.passed=true;summary.receiptFailures=summary.runs.length+summary.boundaryCases.length+2;
 fs.writeFileSync('results.json',JSON.stringify(summary,null,2));
 fs.writeFileSync('compiler-input.json',JSON.stringify(input,null,2));
 console.log('ALL PASS: 3 fresh fixtures / 3 exact-state failed-return compensations / 3 successful controls / 9 negative boundary executions / blocked-compensation recovery');
 await engine.disconnect();
}
main().catch(e=>{console.error(e);process.exitCode=1;});
