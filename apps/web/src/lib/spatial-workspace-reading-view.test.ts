import { expect, it } from 'vitest';
import type { WorkspacePack } from './spatial-workspace-contract';
import { createSpatialWorkspaceView } from './spatial-workspace-view';
import type { WorkspaceReadingUrlState } from './spatial-workspace-url-state';
import { scopeWorkspaceReadingPack, workspaceReadingStateForView, workspaceViewForReadingState } from './spatial-workspace-reading-view';
function fixture(): WorkspacePack {
  return {schemaVersion:1,generatedAt:'2026-10-04',processingVersion:'fixture-only',sources:[{id:'s',versionId:'v',title:'Synthetic navigation fixture',provider:'Fixture publisher',kind:'report',originalSha256:'a'.repeat(64),processingVersion:'source-rule',regionIds:['chaobai'],needIds:['K5-001'],evidenceUrl:null,duplicateOf:null,rights:{public:false,displayAllowed:true,redistributionAllowed:false,note:'Fixture only'},status:{original:'saved',parsed:'ready',checked:'unknown',professionalReview:'pending',space:'reference',use:'unknown'}}],records:[],regions:[{id:'bth',name:'BTH',aliases:[],type:'region',bounds:[113,36,120,43]}],topicPackages:[],rasterReports:[]};
}
const state: WorkspaceReadingUrlState = {regionId:null,needId:null,dateRole:null,monthWindow:null,tab:'spatial',pane:'map',source:null,selection:null};
it('does not serialize an implicit display default as an explicitly chosen regional scope',()=>{
  const pack=fixture();const view=createSpatialWorkspaceView(pack);
  expect(workspaceReadingStateForView(pack,state,view,null,'results')?.regionId).toBeNull();
});
it('retains a fixed source-only reading trail when switching panes without a record selection',()=>{
  const pack=fixture();const input={...state,source:{sourceId:'s',versionId:'v',sha256:'a'.repeat(64),processingVersion:'source-rule'}};
  const result=workspaceReadingStateForView(pack,input,workspaceViewForReadingState(pack,input),null,'evidence');
  expect(result?.source).toEqual(input.source);
});
it('preserves a full leap month as a month scope while supplying legal date-control boundaries',()=>{
  const pack=fixture();const input={...state,dateRole:'PUBLICATION' as const,monthWindow:{start:'2024-02',end:'2024-02'}};
  const view=workspaceViewForReadingState(pack,input);
  expect([view.start,view.end]).toEqual(['2024-02-01','2024-02-29']);
  const next=workspaceReadingStateForView(pack,input,view,null,'map');
  expect(next?.monthWindow).toEqual(input.monthWindow);
  expect(next).not.toHaveProperty('dayWindow');
});
it('retains exact edited day boundaries instead of retaining a wider earlier month',()=>{
  const pack=fixture();const input={...state,dateRole:'PUBLICATION' as const,monthWindow:{start:'2024-02',end:'2024-02'}};
  const view={...workspaceViewForReadingState(pack,input),end:'2024-02-17'};
  const next=workspaceReadingStateForView(pack,input,view,null,'map');
  expect(next?.dayWindow).toEqual({start:'2024-02-01',end:'2024-02-17'});
  expect(next?.monthWindow).toBeNull();
});
it('excludes revoked and opposite-track raster reports without hiding permitted reference sources',()=>{
  const pack=fixture();
  pack.rasterReports=[{sourceId:'s',versionId:'v',rights:{displayAllowed:true},regionIds:['chaobai']} as WorkspacePack['rasterReports'][number]];
  expect(scopeWorkspaceReadingPack(pack,{...state,track:'SYNTHETIC'}).rasterReports).toEqual([]);
  pack.sources[0].rights.displayAllowed=false;
  expect(scopeWorkspaceReadingPack(pack,{...state,track:'REAL'}).rasterReports).toEqual([]);
  expect(scopeWorkspaceReadingPack(pack,{...state,track:'REAL'}).sources).toBe(pack.sources);
});
